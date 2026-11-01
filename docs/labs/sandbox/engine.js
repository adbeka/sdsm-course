/* Сетевая песочница БЗПД — движок симуляции.
   Чистая логика без DOM: модель сети (L2 VLAN/trunk, L3, static, OSPF, ACL),
   прохождение пакета, CLI в стиле Cisco IOS. Работает в браузере и в Node (для тестов). */
(function (root) {
  'use strict';

  /* ================= адреса ================= */
  function ip2n(s) {
    if (typeof s !== 'string') return null;
    const p = s.trim().split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const x of p) {
      if (!/^\d{1,3}$/.test(x) || +x > 255) return null;
      n = n * 256 + +x;
    }
    return n;
  }
  function n2ip(n) { return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.'); }
  function pfx2mask(p) { return p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0; }
  function mask2pfx(m) {
    const n = typeof m === 'string' ? ip2n(m) : m;
    if (n === null) return -1;
    let p = 0;
    while (p < 32 && (n >>> (31 - p)) & 1) p++;
    return pfx2mask(p) === n ? p : -1;
  }
  function netOf(ip, p) { return (ip & pfx2mask(p)) >>> 0; }
  function sameNet(a, b, p) { return netOf(a, p) === netOf(b, p); }
  function wcMatch(ip, net, wc) { const m = (~wc) >>> 0; return ((ip & m) >>> 0) === ((net & m) >>> 0); }

  const EXP = { Gi: 'GigabitEthernet', Fa: 'FastEthernet', eth: 'eth' };
  function fullIf(n) { const m = n.match(/^([A-Za-z]+)(.*)$/); return (EXP[m[1]] || m[1]) + m[2]; }
  function normIf(dev, s) {
    const m = String(s).match(/^([a-zA-Z]+)\s*([\d/.]+)$/);
    if (!m) return null;
    const letters = m[1].toLowerCase();
    for (const name of Object.keys(dev.ifaces)) {
      const k = name.match(/^([A-Za-z]+)([\d/.]+)$/);
      if (!k || k[2] !== m[2]) continue;
      const full = (EXP[k[1]] || k[1]).toLowerCase();
      if (full.startsWith(letters) || k[1].toLowerCase().startsWith(letters)) return name;
    }
    return null;
  }
  function parseList(s) {
    const out = new Set();
    for (const part of s.split(',')) {
      const r = part.split('-').map(Number);
      if (r.length === 1 && r[0] >= 1) out.add(r[0]);
      else if (r.length === 2 && r[0] <= r[1]) for (let v = r[0]; v <= r[1]; v++) out.add(v);
    }
    return [...out].sort((a, b) => a - b);
  }
  function fmtList(arr) {
    if (!arr.length) return 'none';
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
      out.push(j > i + 1 ? arr[i] + '-' + arr[j] : (j === i + 1 ? arr[i] + ',' + arr[j] : String(arr[i])));
      i = j;
    }
    return out.join(',');
  }
  const pad = (s, n) => { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); };

  /* ================= построение сети ================= */
  function PC(name, x, y, ip, mask, gw, opt) {
    opt = opt || {};
    return { name, type: 'pc', x, y, gw: gw ? ip2n(gw) : null, log: [], dhcp: !!opt.dhcp, icon: opt.icon || null,
      ifaces: { eth0: { name: 'eth0', shut: false, err: false, ip: ip ? ip2n(ip) : null, pfx: mask ? mask2pfx(mask) : null } } };
  }
  function SW(name, x, y, ports, vlans, opt) {
    opt = opt || {};
    const ifaces = {};
    for (const [n, o] of Object.entries(ports)) {
      ifaces[n] = Object.assign({ name: n, shut: false, err: false, mode: 'access', vlan: 1, allowed: null, portfast: false, bpduguard: false }, o);
    }
    return { name, type: 'sw', x, y, ifaces, log: [], vlans: Object.assign({ 1: 'default' }, vlans || {}),
      stpOff: opt.stpOff || [], prio: opt.prio || {}, cpuStorm: false };
  }
  function RT(name, x, y, ifs, opt) {
    opt = opt || {};
    const ifaces = {};
    for (const [n, o] of Object.entries(ifs)) {
      ifaces[n] = { name: n, shut: !!o.shut, err: false, ip: o.ip ? ip2n(o.ip) : null, pfx: o.mask ? mask2pfx(o.mask) : null,
        mtu: o.mtu || 1500, hello: o.hello || 10, mtuIgnore: false, aclIn: o.aclIn || null, aclOut: o.aclOut || null, desc: o.desc || '',
        nat: o.nat || null, helper: o.helper ? [ip2n(o.helper)] : [] };
    }
    const acls = {};
    for (const [an, rules] of Object.entries(opt.acls || {})) acls[an] = rules.map((r, i) => Object.assign({ seq: (i + 1) * 10 }, parseAce(r.split(/\s+/))));
    const stdAcls = {};
    for (const [num, rules] of Object.entries(opt.stdAcls || {})) stdAcls[num] = rules.map((r, i) => Object.assign({ seq: (i + 1) * 10 }, parseStd(r.split(/\s+/))));
    const dhcp = { pools: {}, excluded: (opt.dhcp && opt.dhcp.excluded || []).map(([a, b]) => [ip2n(a), ip2n(b || a)]), bindings: {} };
    for (const [pn, pl] of Object.entries(opt.dhcp && opt.dhcp.pools || {})) {
      dhcp.pools[pn] = { net: pl.net ? ip2n(pl.net) : null, pfx: pl.mask ? mask2pfx(pl.mask) : null, gw: pl.gw ? ip2n(pl.gw) : null, dns: pl.dns ? ip2n(pl.dns) : null };
    }
    return { name, type: 'rt', x, y, ifaces, log: [], rid: opt.rid || null, icon: opt.icon || null, stdAcls, dhcp,
      nat: { dyn: (opt.nat && opt.nat.dyn || []).map(([list, ifn]) => ({ list: String(list), ifn })), stat: (opt.nat && opt.nat.stat || []).map(([l, g]) => ({ local: ip2n(l), global: ip2n(g) })) },
      xlate: [],
      routes: (opt.routes || []).map(([a, m, nh]) => ({ net: ip2n(a), pfx: mask2pfx(m), nh: ip2n(nh) })),
      ospf: opt.ospf ? { pid: opt.ospf.pid || 1, networks: opt.ospf.networks.map(([a, w, ar]) => ({ net: ip2n(a), wc: ip2n(w), area: ar })), passive: opt.ospf.passive || [] } : null,
      acls };
  }

  class Net {
    constructor(def) {
      this.dev = def.devices;
      let k = 0;
      for (const [id, d] of Object.entries(this.dev)) {
        d.id = id;
        if (d.type === 'sw') { k++; d.mac = d.mac || `0019.e7${String(k).padStart(2, '0')}.${String(k * 1111).padStart(4, '0')}`; }
      }
      this.links = def.links.map(([a, ai, b, bi]) => ({ a: [a, ai], b: [b, bi] }));
      this.peer = {};
      for (const l of this.links) {
        this.peer[l.a[0] + '|' + l.a[1]] = l.b;
        this.peer[l.b[0] + '|' + l.b[1]] = l.a;
      }
    }
    peerOf(d, i) { return this.peer[d + '|' + i] || null; }
    portUp(d, i) { const f = this.dev[d].ifaces[i]; return !!f && !f.shut && !f.err; }
    ifUp(d, i) {
      if (!this.portUp(d, i)) return false;
      const p = this.peerOf(d, i);
      return !!p && this.portUp(p[0], p[1]);
    }
    linkUp(l) { return this.ifUp(l.a[0], l.a[1]); }

    /* ---------- L2: куда долетит кадр, отправленный с L3-интерфейса ---------- */
    l2reach(d, i) {
      const out = [], seenEp = new Set(), seenSeg = new Set(), stpc = {};
      out.storm = null;
      if (!this.ifUp(d, i)) return out;
      const carries = carriesV;
      const st = v => stpc[v] || (stpc[v] = this.stp(v));
      const deliver = (dev, ifn, tag, chain) => {
        const D = this.dev[dev], f = D.ifaces[ifn];
        if (D.type !== 'sw') {
          if (tag !== null) return;
          const k = dev + '|' + ifn;
          if (seenEp.has(k) || (dev === d && ifn === i)) return;
          seenEp.add(k);
          out.push({ dev, ifn, chain: chain.concat(dev) });
          return;
        }
        let v;
        if (f.mode === 'access') { if (tag !== null) return; v = f.vlan; }
        else { v = tag === null ? 1 : tag; if (!carries(f, v)) return; }
        flood(dev, v, ifn, chain.concat(dev));
      };
      const flood = (sw, v, inIf, chain) => {
        const k = sw + '|' + v;
        const S = st(v);
        if (S.blocked.has(sw + '|' + inIf)) return; // кадр пришёл в заблокированный порт — отброшен
        if (seenSeg.has(k)) return;
        seenSeg.add(k);
        if (S.storm && S.stormSw.has(sw)) out.storm = v;
        for (const [pn, f] of Object.entries(this.dev[sw].ifaces)) {
          if (pn === inIf || !this.ifUp(sw, pn) || !carries(f, v) || S.blocked.has(sw + '|' + pn)) continue;
          const tag = f.mode === 'trunk' && v !== 1 ? v : null;
          const p = this.peerOf(sw, pn);
          deliver(p[0], p[1], tag, chain);
        }
      };
      const p = this.peerOf(d, i);
      deliver(p[0], p[1], null, [d]);
      return out;
    }


    /* ---------- STP (упрощённый RSTP/PVST для одного VLAN) ---------- */
    stpOn(sw, v) { return !this.dev[sw].stpOff.includes(v); }
    bid(sw, v) { const D = this.dev[sw]; return [(D.prio[v] || 32768) + v, D.mac]; }
    cmpBid(a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); }
    stp(v) {
      const n = this, sws = Object.keys(n.dev).filter(id => n.dev[id].type === 'sw');
      const links = [];
      n.links.forEach((l, idx) => {
        const A = n.dev[l.a[0]], B = n.dev[l.b[0]];
        if (A.type !== 'sw' || B.type !== 'sw' || !n.linkUp(l)) return;
        if (!carriesV(A.ifaces[l.a[1]], v) || !carriesV(B.ifaces[l.b[1]], v)) return;
        links.push({ idx, a: l.a, b: l.b });
      });
      // сегменты: коммутаторы без STP прозрачно пропускают BPDU
      const par = {};
      const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
      const node = ([sw, p]) => n.stpOn(sw, v) ? 'P:' + sw + '|' + p : 'D:' + sw;
      const union = (x, y) => { [x, y].forEach(z => { if (par[z] === undefined) par[z] = z; }); const a = find(x), b = find(y); if (a !== b) par[a] = b; };
      for (const l of links) union(node(l.a), node(l.b));
      const ports = {}; // sw -> [port]
      const segOf = {};
      for (const l of links) for (const e of [l.a, l.b]) if (n.stpOn(e[0], v)) {
        (ports[e[0]] = ports[e[0]] || []).push(e[1]);
        segOf[e[0] + '|' + e[1]] = find('P:' + e[0] + '|' + e[1]);
      }
      const segMembers = {};
      for (const [k, sg] of Object.entries(segOf)) (segMembers[sg] = segMembers[sg] || []).push(k);
      const bridges = sws.filter(sw => n.stpOn(sw, v));
      const cost = {}, rootFor = {};
      const left = new Set(bridges);
      while (left.size) {
        const root = [...left].sort((a, b) => n.cmpBid(n.bid(a, v), n.bid(b, v)))[0];
        cost[root] = 0; rootFor[root] = root;
        const q = [root];
        while (q.length) {
          q.sort((a, b) => cost[a] - cost[b]);
          const u = q.shift();
          if (!left.has(u)) continue;
          left.delete(u);
          for (const p of ports[u] || []) for (const m of segMembers[segOf[u + '|' + p]]) {
            const w = m.split('|')[0];
            if (w === u || !left.has(w)) continue;
            if (cost[w] === undefined || cost[u] + 4 < cost[w]) { cost[w] = cost[u] + 4; rootFor[w] = root; q.push(w); }
          }
        }
      }
      const roles = {}, blocked = new Set(), rootPort = {};
      for (const b of bridges) {
        if (rootFor[b] === b) continue;
        let best = null;
        for (const p of ports[b] || []) for (const m of segMembers[segOf[b + '|' + p]]) {
          const w = m.split('|')[0];
          if (w === b || rootFor[w] !== rootFor[b]) continue;
          const c = [cost[w] + 4, n.bid(w, v), p];
          if (!best || c[0] < best[0] || (c[0] === best[0] && (n.cmpBid(c[1], best[1]) < 0 || (n.cmpBid(c[1], best[1]) === 0 && c[2] < best[2])))) best = c;
        }
        if (best) rootPort[b] = best[2];
      }
      for (const [sg, mem] of Object.entries(segMembers)) {
        const sorted = mem.slice().sort((x, y) => {
          const [a, pa] = x.split('|'), [b, pb] = y.split('|');
          return (cost[a] - cost[b]) || n.cmpBid(n.bid(a, v), n.bid(b, v)) || (pa < pb ? -1 : pa > pb ? 1 : 0);
        });
        sorted.forEach((k, i) => {
          const [sw, p] = k.split('|');
          if (i === 0 && rootPort[sw] !== p) roles[k] = 'Desg';
          else if (rootPort[sw] === p) roles[k] = 'Root';
          else { roles[k] = 'Altn'; blocked.add(k); }
        });
      }
      // петля = цикл в графе пересылающих линков
      const up = {};
      const f2 = x => { while (up[x] !== x) x = up[x] = up[up[x]]; return x; };
      sws.forEach(sw => { up[sw] = sw; });
      const fwd = links.filter(l => !blocked.has(l.a.join('|')) && !blocked.has(l.b.join('|')));
      const loopRoots = new Set();
      for (const l of fwd) { const a = f2(l.a[0]), b = f2(l.b[0]); if (a === b) loopRoots.add(a); else up[a] = b; }
      const stormSw = new Set(), stormLinks = new Set();
      if (loopRoots.size) {
        const bad = new Set([...loopRoots].map(f2));
        sws.forEach(sw => { if (bad.has(f2(sw))) stormSw.add(sw); });
        fwd.forEach(l => { if (stormSw.has(l.a[0])) stormLinks.add(l.idx); });
      }
      return { v, roles, blocked, rootFor, cost, rootPort, storm: stormSw.size > 0, stormSw, stormLinks, bridges };
    }
    vlansInUse() {
      const set = new Set();
      for (const D of Object.values(this.dev)) if (D.type === 'sw') for (const f of Object.values(D.ifaces)) {
        if (f.mode === 'access') set.add(f.vlan); else (f.allowed || Object.keys(D.vlans).map(Number)).forEach(v => { if (D.vlans[v]) set.add(v); });
      }
      return [...set].sort((a, b) => a - b);
    }
    l2view() {
      const blocked = new Map(), storm = new Set(), stormSw = new Set();
      for (const v of this.vlansInUse()) {
        const S = this.stp(v);
        S.blocked.forEach(k => { if (!blocked.has(k)) blocked.set(k, []); blocked.get(k).push(v); });
        S.stormLinks.forEach(k => storm.add(k)); S.stormSw.forEach(k => stormSw.add(k));
      }
      return { blocked, storm, stormSw };
    }
    portVlans(d, ifn) { const f = this.dev[d].ifaces[ifn]; return this.vlansInUse().filter(v => carriesV(f, v)); }

    /* ---------- OSPF ---------- */
    rid(r) {
      const R = this.dev[r];
      if (R.rid) return ip2n(R.rid);
      let best = 0;
      for (const f of Object.values(R.ifaces)) if (f.ip !== null && f.ip > best) best = f.ip;
      return best;
    }
    ospfIf(r, ifn) {
      const R = this.dev[r], f = R.ifaces[ifn];
      if (!R.ospf || f.ip === null) return null;
      const nw = R.ospf.networks.find(n => wcMatch(f.ip, n.net, n.wc));
      if (!nw) return null;
      return { area: nw.area, passive: R.ospf.passive.includes(ifn) };
    }
    ospfNeighbors(r) {
      const R = this.dev[r], res = [];
      if (!R.ospf) return res;
      for (const ifn of Object.keys(R.ifaces)) {
        const me = this.ospfIf(r, ifn), f = R.ifaces[ifn];
        if (!me || me.passive || !this.ifUp(r, ifn)) continue;
        for (const ep of this.l2reach(r, ifn)) {
          const Q = this.dev[ep.dev];
          if (Q.type !== 'rt' || ep.dev === r) continue;
          const g = Q.ifaces[ep.ifn], other = this.ospfIf(ep.dev, ep.ifn);
          if (!other || other.passive || g.pfx !== f.pfx || !sameNet(g.ip, f.ip, f.pfx)) continue;
          if (other.area !== me.area || g.hello !== f.hello) continue;
          // DBD отвергает сторона с меньшим MTU — ей и нужен mtu-ignore, если MTU не выровняли
          const low = f.mtu < g.mtu ? f : g;
          const state = g.mtu !== f.mtu && !low.mtuIgnore ? (f.mtu > g.mtu ? 'EXSTART' : 'EXCHANGE') : 'FULL';
          res.push({ nbr: ep.dev, rid: this.rid(ep.dev), ip: g.ip, ifn, nbrIf: ep.ifn, state });
        }
      }
      return res;
    }
    ospfRoutes(r) {
      const dist = { [r]: 0 }, first = {}, done = new Set(), routes = [];
      const adj = id => this.ospfNeighbors(id).filter(n => n.state === 'FULL' &&
        this.ospfNeighbors(n.nbr).some(m => m.nbr === id && m.state === 'FULL'));
      for (;;) {
        let u = null;
        for (const k of Object.keys(dist)) if (!done.has(k) && (u === null || dist[k] < dist[u])) u = k;
        if (u === null) break;
        done.add(u);
        for (const n of adj(u)) {
          const nd = dist[u] + 1;
          if (dist[n.nbr] === undefined || nd < dist[n.nbr]) {
            dist[n.nbr] = nd;
            first[n.nbr] = u === r ? { nh: n.ip, ifn: n.ifn } : first[u];
          }
        }
      }
      for (const q of Object.keys(dist)) {
        if (q === r) continue;
        for (const ifn of Object.keys(this.dev[q].ifaces)) {
          const f = this.dev[q].ifaces[ifn];
          if (!this.ospfIf(q, ifn) || !this.ifUp(q, ifn)) continue;
          routes.push({ code: 'O', net: netOf(f.ip, f.pfx), pfx: f.pfx, nh: first[q].nh, ifn: first[q].ifn, ad: 110, metric: dist[q] + 1 });
        }
      }
      return routes;
    }

    /* ---------- таблица маршрутизации ---------- */
    rib(r) {
      const R = this.dev[r], cand = [];
      for (const [ifn, f] of Object.entries(R.ifaces)) {
        if (f.ip !== null && this.ifUp(r, ifn)) cand.push({ code: 'C', net: netOf(f.ip, f.pfx), pfx: f.pfx, ifn, nh: null, ad: 0, metric: 0 });
      }
      for (const s of R.routes) {
        const c = cand.find(x => x.code === 'C' && sameNet(s.nh, x.net, x.pfx));
        if (c) cand.push({ code: 'S', net: s.net, pfx: s.pfx, nh: s.nh, ifn: c.ifn, ad: 1, metric: 0 });
      }
      if (R.ospf) cand.push(...this.ospfRoutes(r));
      const best = {};
      for (const c of cand) {
        const k = c.net + '/' + c.pfx;
        if (!best[k] || c.ad < best[k].ad || (c.ad === best[k].ad && c.metric < best[k].metric)) best[k] = c;
      }
      return Object.values(best).sort((a, b) => a.net - b.net || a.pfx - b.pfx);
    }
    lookup(r, dst) {
      let best = null;
      for (const e of this.rib(r)) if (sameNet(dst, e.net, e.pfx) && (!best || e.pfx > best.pfx)) best = e;
      return best;
    }

    /* ---------- ACL ---------- */
    aclPermit(r, name, pkt) {
      const acl = this.dev[r].acls[name];
      if (!acl) return true; // ссылка на несуществующий ACL — пропускает всё, как в IOS
      for (const a of acl.slice().sort((x, y) => x.seq - y.seq)) {
        if (a.proto !== 'ip' && a.proto !== pkt.proto) continue;
        if (!wcMatch(pkt.src, a.src.n, a.src.w) || !wcMatch(pkt.dst, a.dst.n, a.dst.w)) continue;
        if (a.port && pkt.dport !== a.port) continue;
        return a.action === 'permit';
      }
      return false;
    }

    /* ---------- прохождение пакета ---------- */
    owns(d, ip) {
      for (const [ifn, f] of Object.entries(this.dev[d].ifaces)) if (f.ip === ip && this.ifUp(d, ifn)) return true;
      return false;
    }
    walk(src, dst, o) {
      o = o || {};
      const pkt = { src: o.srcIp != null ? o.srcIp : null, dst, proto: o.proto || 'icmp', dport: o.dport || 0, sport: o.sport || 0, err: !!o.err };
      let node = src, path = [src], inIf = null, origSrc = null;
      const hops = [];
      const fail = (reason, kind, at) => ({ ok: false, reason, kind, at: at || node, path, hops, srcIp: origSrc !== null ? origSrc : pkt.src, src });
      for (let ttl = 0; ttl < 24; ttl++) {
        const D = this.dev[node];
        if (D.type === 'rt' && inIf && D.ifaces[inIf].nat === 'outside') this.natIn(node, pkt);
        dst = pkt.dst;
        if (this.owns(node, dst)) return { ok: true, path, hops, srcIp: origSrc !== null ? origSrc : pkt.src, finalSrc: pkt.src, finalDst: pkt.dst, finalSport: pkt.sport, finalDport: pkt.dport, dstDev: node, src };
        let ifn, nh;
        if (D.type === 'pc') {
          if (ttl > 0) return fail(`${D.name} получил чужой пакет — хост не маршрутизирует`, 'host');
          const e = D.ifaces.eth0;
          if (e.ip === null) return fail(`у ${D.name} не задан IP-адрес`, 'noip');
          if (!this.ifUp(node, 'eth0')) return fail(`у ${D.name} нет линка`, 'link');
          if (sameNet(e.ip, dst, e.pfx)) nh = dst;
          else { if (D.gw === null) return fail(`у ${D.name} не задан шлюз, а ${n2ip(dst)} в чужой подсети`, 'nogw'); nh = D.gw; }
          ifn = 'eth0';
        } else if (D.type === 'rt') {
          const r = this.lookup(node, dst);
          if (!r) return fail(`у ${D.name} нет маршрута до ${n2ip(dst)}`, 'noroute');
          ifn = r.ifn; nh = r.nh !== null ? r.nh : dst;
        } else return fail('коммутатор не отправляет IP-пакеты', 'sw');
        if (pkt.src === null) pkt.src = D.ifaces[ifn].ip;
        if (origSrc === null) origSrc = pkt.src;
        const fo = D.ifaces[ifn];
        if (D.type === 'rt' && inIf && D.ifaces[inIf].nat === 'inside' && fo.nat === 'outside') this.natOut(node, pkt, ifn);
        if (fo.aclOut && !this.aclPermit(node, fo.aclOut, pkt)) return fail(`пакет отброшен ACL ${fo.aclOut} (out) на ${D.name} ${ifn}`, 'acl');
        const reach = this.l2reach(node, ifn);
        if (reach.storm !== null) return fail(`широковещательный шторм в VLAN ${reach.storm}: кадры тонут в L2-петле`, 'storm');
        const t = reach.find(e => this.dev[e.dev].ifaces[e.ifn].ip === nh);
        if (!t) return fail(`${D.name}: ARP-запрос за ${n2ip(nh)} остался без ответа`, 'arp');
        path = path.concat(t.chain.slice(1));
        const T = this.dev[t.dev], fi = T.ifaces[t.ifn];
        if (fi.aclIn && !this.aclPermit(t.dev, fi.aclIn, pkt)) return fail(`пакет отброшен ACL ${fi.aclIn} (in) на ${T.name} ${t.ifn}`, 'acl', t.dev);
        hops.push({ dev: t.dev, ip: fi.ip, src: pkt.src, sport: pkt.sport });
        node = t.dev; inIf = t.ifn;
      }
      return fail('петля маршрутизации: TTL истёк', 'loop');
    }
    ping(src, dst, o) {
      o = o || {};
      const fwd = this.walk(src, dst, { proto: o.proto || 'icmp', dport: o.dport || 0, sport: o.proto === 'tcp' ? 49152 : 1 });
      if (!fwd.ok) return { ok: false, fwd, back: null, fail: fwd };
      const back = this.walk(fwd.dstDev, fwd.finalSrc, { proto: o.proto || 'icmp', srcIp: fwd.finalDst, sport: fwd.finalDport, dport: fwd.finalSport });
      if (back.ok && back.dstDev !== src) {
        const f = Object.assign({}, back, { ok: false, kind: 'nat', at: back.dstDev, reason: `ответ пришёл на ${this.dev[back.dstDev].name} и дальше не пошёл — нет обратной трансляции NAT` });
        return { ok: false, fwd, back: f, fail: f };
      }
      return { ok: back.ok, fwd, back, fail: back.ok ? null : back };
    }

    /* ---------- NAT ---------- */
    stdPermit(r, list, ip) {
      const acl = this.dev[r].stdAcls[list];
      if (!acl) return false;
      for (const a of acl.slice().sort((x, y) => x.seq - y.seq)) if (wcMatch(ip, a.src.n, a.src.w)) return a.action === 'permit';
      return false;
    }
    natIn(r, pkt) {
      const R = this.dev[r];
      const st = R.nat.stat.find(x => x.global === pkt.dst);
      if (st) { pkt.dst = st.local; return; }
      // ICMP-ошибки (traceroute) сопоставляются по вложенному пакету — т.е. только по внешнему адресу и порту
      const x = R.xlate.find(e => e.global === pkt.dst && e.gport === pkt.dport && (pkt.err || (e.remote === pkt.src && e.proto === pkt.proto)));
      if (x) { pkt.dst = x.local; pkt.dport = x.lport; }
    }
    natOut(r, pkt, ifn) {
      const R = this.dev[r];
      const st = R.nat.stat.find(x => x.local === pkt.src);
      if (st) { pkt.src = st.global; return; }
      const rule = R.nat.dyn.find(d => d.ifn === ifn && this.stdPermit(r, d.list, pkt.src));
      if (!rule || R.ifaces[ifn].ip === null) return;
      let e = R.xlate.find(x => x.proto === pkt.proto && x.local === pkt.src && x.lport === pkt.sport && x.remote === pkt.dst);
      if (!e) {
        R.natPort = (R.natPort || 1023) + 1;
        e = { proto: pkt.proto, local: pkt.src, lport: pkt.sport, global: R.ifaces[ifn].ip, gport: R.natPort, remote: pkt.dst, rport: pkt.dport };
        R.xlate.push(e);
        if (R.xlate.length > 12) R.xlate.shift();
      }
      pkt.src = e.global; pkt.sport = e.gport;
    }

    /* ---------- DHCP ---------- */
    dhcpServe(S, giaddr, client) {
      const D = this.dev[S];
      const pool = Object.values(D.dhcp.pools).find(p => p.net !== null && sameNet(giaddr, p.net, p.pfx));
      if (!pool) return null;
      const b = D.dhcp.bindings;
      if (b[client] && sameNet(b[client], pool.net, pool.pfx)) return { ip: b[client], pfx: pool.pfx, gw: pool.gw, dns: pool.dns, server: S };
      const used = new Set(Object.values(b));
      for (const X of Object.values(this.dev)) for (const f of Object.values(X.ifaces)) if (f.ip !== null && X.id !== client) used.add(f.ip);
      const size = 2 ** (32 - pool.pfx);
      for (let k = 1; k < size - 1; k++) {
        const ip = pool.net + k;
        if (used.has(ip) || D.dhcp.excluded.some(([a, z]) => ip >= a && ip <= z)) continue;
        b[client] = ip;
        return { ip, pfx: pool.pfx, gw: pool.gw, dns: pool.dns, server: S };
      }
      return { exhausted: true };
    }
    dhcp(pc) {
      if (!this.ifUp(pc, 'eth0')) return { ok: false, reason: 'нет линка' };
      const dom = this.l2reach(pc, 'eth0');
      if (dom.storm !== null) return { ok: false, reason: 'шторм в сети' };
      for (const ep of dom) {
        const R = this.dev[ep.dev], f = R.ifaces[ep.ifn];
        if (R.type !== 'rt' || f.ip === null) continue;
        let lease = this.dhcpServe(ep.dev, f.ip, pc);
        let relay = null;
        if (!lease) for (const h of f.helper) {
          const fw = this.walk(ep.dev, h, { proto: 'udp', dport: 67, srcIp: f.ip });
          if (!fw.ok) continue;
          const bk = this.walk(fw.dstDev, f.ip, { proto: 'udp', dport: 68, srcIp: h });
          if (!bk.ok) continue;
          lease = this.dhcpServe(fw.dstDev, f.ip, pc);
          if (lease) { relay = { via: f.ip, router: ep.dev, server: h }; break; }
        }
        if (lease && lease.exhausted) return { ok: false, reason: 'в пуле закончились адреса' };
        if (lease) return Object.assign({ ok: true, relay }, lease);
      }
      return { ok: false, reason: 'DHCP-сервер не ответил' };
    }
  }

  function parseAddr(t, i) {
    if (t[i] === 'any') return { a: { n: 0, w: 0xFFFFFFFF }, i: i + 1 };
    if (t[i] === 'host' && ip2n(t[i + 1]) !== null) return { a: { n: ip2n(t[i + 1]), w: 0 }, i: i + 2 };
    if (ip2n(t[i]) !== null && ip2n(t[i + 1]) !== null) return { a: { n: ip2n(t[i]), w: ip2n(t[i + 1]) }, i: i + 2 };
    return null;
  }
  function parseAce(t) {
    t = t.map(x => x.toLowerCase());
    const action = t[0];
    if (action !== 'permit' && action !== 'deny') return null;
    const proto = t[1];
    if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return null;
    const s = parseAddr(t, 2); if (!s) return null;
    const d = parseAddr(t, s.i); if (!d) return null;
    let port = 0, i = d.i;
    if (t[i] === 'eq') { port = { telnet: 23, ssh: 22, www: 80 }[t[i + 1]] || +t[i + 1]; if (!port) return null; i += 2; }
    if (i !== t.length) return null;
    return { action, proto, src: s.a, dst: d.a, port };
  }
  function parseStd(t) {
    t = t.map(x => x.toLowerCase());
    const action = t[0];
    if (action !== 'permit' && action !== 'deny') return null;
    let src;
    if (t[1] === 'any' && t.length === 2) src = { n: 0, w: 0xFFFFFFFF };
    else if (t[1] === 'host' && ip2n(t[2]) !== null && t.length === 3) src = { n: ip2n(t[2]), w: 0 };
    else if (ip2n(t[1]) !== null && (t.length === 2 || (t.length === 3 && ip2n(t[2]) !== null))) src = { n: ip2n(t[1]), w: t[2] ? ip2n(t[2]) : 0 };
    else return null;
    return { action, src };
  }
  function addrStr(a) { return a.w === 0xFFFFFFFF ? 'any' : a.w === 0 ? 'host ' + n2ip(a.n) : n2ip(a.n) + ' ' + n2ip(a.w); }
  function aceStr(a) { return `${a.action} ${a.proto} ${addrStr(a.src)} ${addrStr(a.dst)}${a.port ? ' eq ' + ({ 23: 'telnet', 22: 'ssh', 80: 'www' }[a.port] || a.port) : ''}`; }

  /* ================= CLI ================= */
  const MODE_PROMPT = { exec: '#', config: '(config)#', if: '(config-if)#', router: '(config-router)#', acl: '(config-ext-nacl)#', vlan: '(config-vlan)#', dhcp: '(dhcp-config)#' };
  function carriesV(f, v) { return f.mode === 'access' ? f.vlan === v : (f.allowed === null || f.allowed.includes(v)); }

  class Session {
    constructor(net, devId, hooks) {
      this.net = net; this.id = devId; this.mode = 'exec'; this.ifn = null; this.acl = null; this.vlan = null;
      this.hooks = hooks || {};
    }
    get dev() { return this.net.dev[this.id]; }
    prompt() {
      const D = this.dev;
      if (D.type === 'pc') return D.name + '>';
      return D.name + MODE_PROMPT[this.mode];
    }
    say(l) { this.out.push(l); }
    logEv(msg) { this.dev.log.push(msg); this.say(msg); }
    run(line) {
      this.out = [];
      const tokens = line.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return this.out;
      if (tokens[0] === '?' || tokens[tokens.length - 1] === '?') { this.help(tokens.slice(0, -1)); return this.out; }
      const before = this.snapshot();
      const res = this.dispatch(tokens);
      if (res === 'invalid') this.say('% Invalid input detected — команда не распознана. Введите ? для списка команд.');
      else if (res === 'incomplete') this.say('% Incomplete command.');
      else if (res === 'ambiguous') this.say(`% Ambiguous command: "${line.trim()}"`);
      this.afterChange(before);
      return this.out;
    }
    grammar(mode) { return GRAMMAR.filter(g => g.modes.includes(mode) && g.types.includes(this.dev.type)); }
    match(tokens, mode) {
      const found = [];
      let incomplete = false;
      for (const g of this.grammar(mode)) {
        const r = matchPattern(tokens, g.pat, this.dev);
        if (r === 'incomplete') incomplete = true;
        else if (r) found.push({ g, args: r.args, score: r.score });
      }
      if (!found.length) return incomplete ? 'incomplete' : null;
      found.sort((a, b) => b.score - a.score);
      if (found.length > 1 && found[0].score === found[1].score) return 'ambiguous';
      return found[0];
    }
    dispatch(tokens) {
      const mode = this.dev.type === 'pc' ? 'pc' : this.mode;
      if (mode !== 'exec' && mode !== 'pc' && tokens[0].toLowerCase() === 'do' && tokens.length > 1) {
        const m = this.match(tokens.slice(1), 'exec');
        if (m && typeof m === 'object') { m.g.run(this, m.args); return 'ok'; }
        return m || 'invalid';
      }
      let m = this.match(tokens, mode);
      if (!m && ['if', 'router', 'acl', 'vlan', 'dhcp'].includes(mode)) {
        const m2 = this.match(tokens, 'config');
        if (m2 && typeof m2 === 'object') { this.mode = 'config'; m = m2; }
      }
      if (m && typeof m === 'object') { m.g.run(this, m.args); return 'ok'; }
      return m || 'invalid';
    }
    complete(line) {
      const tokens = line.split(/\s+/);
      const last = tokens.pop().toLowerCase();
      const mode = this.dev.type === 'pc' ? 'pc' : this.mode;
      const cands = new Set();
      for (const g of this.grammar(mode)) {
        if (g.pat.length <= tokens.length) continue;
        const head = matchPattern(tokens, g.pat.slice(0, tokens.length), this.dev);
        if (!head || head === 'incomplete') continue;
        const p = g.pat[tokens.length];
        if (p[0] === '(') p.slice(1, -1).split('|').forEach(o => { if (o.startsWith(last)) cands.add(o); });
        else if (p[0] !== '<' && p.startsWith(last)) cands.add(p);
      }
      const list = [...cands];
      if (list.length === 1) return { line: tokens.concat(list[0]).join(' ') + ' ', options: [] };
      return { line, options: list.sort() };
    }
    help(tokens) {
      const mode = this.dev.type === 'pc' ? 'pc' : this.mode;
      const rows = [];
      for (const g of this.grammar(mode)) {
        if (tokens.length && !matchPattern(tokens, g.pat.slice(0, tokens.length), this.dev)) continue;
        rows.push('  ' + pad(g.pat.join(' '), 46) + (g.help || ''));
      }
      this.say(rows.length ? rows.join('\n') : '% Нет подходящих команд.');
    }
    snapshot() {
      const n = this.net, s = { links: n.links.map(l => n.linkUp(l)), nbr: {} };
      for (const [id, D] of Object.entries(n.dev)) if (D.type === 'rt' && D.ospf) s.nbr[id] = n.ospfNeighbors(id);
      return s;
    }
    afterChange(before) {
      const n = this.net, after = this.snapshot();
      n.links.forEach((l, k) => {
        if (before.links[k] === after.links[k]) return;
        for (const [d, i] of [l.a, l.b]) {
          if (d !== this.id || this.dev.type === 'pc') continue;
          const st = after.links[k] ? 'up' : (this.dev.ifaces[i].shut ? 'administratively down' : 'down');
          this.logEv(`%LINK-3-UPDOWN: Interface ${fullIf(i)}, changed state to ${st}`);
          this.logEv(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${fullIf(i)}, changed state to ${after.links[k] ? 'up' : 'down'}`);
        }
      });
      for (const id of Object.keys(after.nbr)) {
        const b = before.nbr[id] || [], a = after.nbr[id];
        const key = x => x.nbr + x.ifn;
        for (const x of a) {
          const old = b.find(y => key(y) === key(x));
          if (!old || old.state !== x.state) {
            const msg = `%OSPF-5-ADJCHG: Process ${n.dev[id].ospf.pid}, Nbr ${n2ip(x.rid)} on ${fullIf(x.ifn)} from ${old ? old.state : 'LOADING'} to ${x.state}${x.state === 'FULL' ? ', Loading Done' : ''}`;
            n.dev[id].log.push(msg);
            if (id === this.id) this.say(msg);
          }
        }
        for (const y of b) if (!a.find(x => key(x) === key(y))) {
          const msg = `%OSPF-5-ADJCHG: Process ${n.dev[id].ospf.pid}, Nbr ${n2ip(y.rid)} on ${fullIf(y.ifn)} from ${y.state} to DOWN, Neighbor Down`;
          n.dev[id].log.push(msg);
          if (id === this.id) this.say(msg);
        }
      }
      if (this.hooks.changed) this.hooks.changed();
    }
  }

  const V = {
    '<ip>': t => ip2n(t) !== null,
    '<mask>': t => mask2pfx(t) >= 0,
    '<num>': t => /^\d+$/.test(t),
    '<word>': () => true,
    '<list>': t => /^\d+([,-]\d+)*$/.test(t),
  };
  function matchPattern(tokens, pat, dev) {
    let i = 0, score = 0;
    const args = [];
    for (let k = 0; k < pat.length; k++) {
      const p = pat[k];
      if (p === '<rest>') { if (i >= tokens.length) return 'incomplete'; args.push(tokens.slice(i).join(' ')); i = tokens.length; continue; }
      if (i >= tokens.length) return 'incomplete';
      const t = tokens[i], tl = t.toLowerCase();
      if (p === '<if>') {
        let v = normIf(dev, t);
        if (v) { args.push(v); i++; continue; }
        if (i + 1 < tokens.length && (v = normIf(dev, t + tokens[i + 1]))) { args.push(v); i += 2; continue; }
        return null;
      }
      if (p[0] === '<') { if (!V[p](t)) return null; args.push(t); i++; continue; }
      if (p[0] === '(') {
        const m = p.slice(1, -1).split('|').filter(o => o.startsWith(tl));
        if (m.length !== 1) return null;
        args.push(m[0]); if (m[0] === tl) score++; i++; continue;
      }
      if (!p.startsWith(tl)) return null;
      if (p === tl) score++;
      i++;
    }
    if (i !== tokens.length) return null;
    return { args, score };
  }

  /* ---------- show-выводы ---------- */
  function ifStatus(s, ifn) {
    const n = s.net, f = s.dev.ifaces[ifn];
    if (f.shut) return ['administratively down', 'down'];
    if (f.err) return ['down', 'down (err-disabled)'];
    return n.ifUp(s.id, ifn) ? ['up', 'up'] : ['down', 'down'];
  }
  function showIpIntBrief(s) {
    const rows = [pad('Interface', 23) + pad('IP-Address', 16) + 'OK? Method ' + pad('Status', 22) + 'Protocol'];
    for (const [ifn, f] of Object.entries(s.dev.ifaces)) {
      const [st, pr] = ifStatus(s, ifn);
      rows.push(pad(fullIf(ifn), 23) + pad(f.ip !== null ? n2ip(f.ip) : 'unassigned', 16) + 'YES ' + pad(f.ip !== null ? 'manual' : 'unset', 7) + pad(st, 22) + pr);
    }
    s.say(rows.join('\n'));
  }
  function showIpRoute(s) {
    const rib = s.net.rib(s.id);
    const def = rib.find(e => e.pfx === 0);
    const lines = ['Codes: C - connected, S - static, O - OSPF, * - candidate default', '', def ? `Gateway of last resort is ${n2ip(def.nh)} to network 0.0.0.0` : 'Gateway of last resort is not set', ''];
    if (!rib.length) lines.push('% Таблица пуста');
    for (const e of rib) {
      const pre = n2ip(e.net) + '/' + e.pfx;
      if (e.code === 'C') lines.push(`C        ${pre} is directly connected, ${fullIf(e.ifn)}`);
      else if (e.code === 'S') lines.push(`S${e.pfx === 0 ? '*' : ' '}       ${pre} [1/0] via ${n2ip(e.nh)}`);
      else lines.push(`O        ${pre} [110/${e.metric}] via ${n2ip(e.nh)}, 00:0${e.metric}:1${e.metric}, ${fullIf(e.ifn)}`);
    }
    s.say(lines.join('\n'));
  }
  function showOspfNbr(s) {
    if (!s.dev.ospf) { s.say('% OSPF не запущен'); return; }
    const rows = [pad('Neighbor ID', 16) + pad('Pri', 6) + pad('State', 16) + pad('Dead Time', 12) + pad('Address', 16) + 'Interface'];
    for (const x of s.net.ospfNeighbors(s.id)) rows.push(pad(n2ip(x.rid), 16) + pad('1', 6) + pad(x.state + '/  -', 16) + pad('00:00:3' + (x.rid % 9), 12) + pad(n2ip(x.ip), 16) + fullIf(x.ifn));
    s.say(rows.join('\n'));
  }
  function showOspfInt(s, brief) {
    const D = s.dev, n = s.net;
    if (!D.ospf) { s.say('% OSPF не запущен'); return; }
    const nb = n.ospfNeighbors(s.id);
    if (brief) {
      const rows = [pad('Interface', 11) + pad('PID', 6) + pad('Area', 8) + pad('IP Address/Mask', 20) + pad('Cost', 6) + pad('State', 7) + 'Nbrs F/C'];
      for (const ifn of Object.keys(D.ifaces)) {
        const o = n.ospfIf(s.id, ifn); if (!o) continue;
        const f = D.ifaces[ifn], mine = nb.filter(x => x.ifn === ifn);
        rows.push(pad(ifn, 11) + pad(D.ospf.pid, 6) + pad(o.area, 8) + pad(n2ip(f.ip) + '/' + f.pfx, 20) + pad('1', 6) + pad(n.ifUp(s.id, ifn) ? (o.passive ? 'DR' : 'P2P') : 'DOWN', 7) + mine.filter(x => x.state === 'FULL').length + '/' + mine.length);
      }
      s.say(rows.join('\n'));
      return;
    }
    const out = [];
    for (const ifn of Object.keys(D.ifaces)) {
      const o = n.ospfIf(s.id, ifn); if (!o) continue;
      const f = D.ifaces[ifn], mine = nb.filter(x => x.ifn === ifn);
      out.push(`${fullIf(ifn)} is ${ifStatus(s, ifn)[0]}, line protocol is ${ifStatus(s, ifn)[1]}`,
        `  Internet Address ${n2ip(f.ip)}/${f.pfx}, Area ${o.area}`,
        `  Process ID ${D.ospf.pid}, Router ID ${n2ip(n.rid(s.id))}, Network Type POINT_TO_POINT, Cost: 1`,
        `  Timer intervals configured, Hello ${f.hello}, Dead ${f.hello * 4}, Wait ${f.hello * 4}, Retransmit 5`,
        o.passive ? '  No Hellos (Passive interface)' : `  Neighbor Count is ${mine.length}, Adjacent neighbor count is ${mine.filter(x => x.state === 'FULL').length}`, '');
    }
    s.say(out.join('\n') || '% Нет интерфейсов в OSPF');
  }
  function showInterface(s, ifn) {
    const D = s.dev, f = D.ifaces[ifn], [st, pr] = ifStatus(s, ifn);
    const lines = [`${fullIf(ifn)} is ${st}, line protocol is ${pr}`];
    if (f.desc) lines.push(`  Description: ${f.desc}`);
    if (D.type === 'rt') {
      if (f.ip !== null) lines.push(`  Internet address is ${n2ip(f.ip)}/${f.pfx}`);
      lines.push(`  MTU ${f.mtu} bytes, BW 1000000 Kbit/sec, DLY 10 usec`);
    } else {
      lines.push('  MTU 1500 bytes, BW 100000 Kbit/sec');
      if (s.net.l2view().stormSw.has(s.id) && s.net.ifUp(s.id, ifn)) lines.push('  5 minute input rate 97412000 bits/sec, 141233 packets/sec', '     Received 98123441 broadcasts (97881122 multicasts)');
    }
    lines.push('  Full-duplex, 1000Mb/s', '     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored', '     0 output errors, 0 collisions, 0 interface resets');
    s.say(lines.join('\n'));
  }
  function showIntStatus(s) {
    const rows = [pad('Port', 10) + pad('Name', 14) + pad('Status', 14) + pad('Vlan', 8) + pad('Duplex', 8) + pad('Speed', 7) + 'Type'];
    for (const [ifn, f] of Object.entries(s.dev.ifaces)) {
      const st = f.err ? 'err-disabled' : f.shut ? 'disabled' : s.net.ifUp(s.id, ifn) ? 'connected' : 'notconnect';
      rows.push(pad(ifn, 10) + pad((f.desc || '').slice(0, 13), 14) + pad(st, 14) + pad(f.mode === 'trunk' ? 'trunk' : f.vlan, 8) + pad('a-full', 8) + pad(ifn.startsWith('Gi') ? 'a-1000' : 'a-100', 7) + (ifn.startsWith('Gi') ? '10/100/1000BaseTX' : '10/100BaseTX'));
    }
    s.say(rows.join('\n'));
  }
  function showTrunk(s) {
    const tr = Object.entries(s.dev.ifaces).filter(([ifn, f]) => f.mode === 'trunk' && s.net.ifUp(s.id, ifn));
    if (!tr.length) { s.say(''); return; }
    const vl = Object.keys(s.dev.vlans).map(Number);
    const rows = [pad('Port', 12) + pad('Mode', 13) + pad('Encapsulation', 15) + pad('Status', 14) + 'Native vlan'];
    tr.forEach(([ifn]) => rows.push(pad(ifn, 12) + pad('on', 13) + pad('802.1q', 15) + pad('trunking', 14) + '1'));
    rows.push('', pad('Port', 12) + 'Vlans allowed on trunk');
    tr.forEach(([ifn, f]) => rows.push(pad(ifn, 12) + (f.allowed === null ? '1-4094' : fmtList(f.allowed))));
    rows.push('', pad('Port', 12) + 'Vlans allowed and active in management domain');
    tr.forEach(([ifn, f]) => rows.push(pad(ifn, 12) + fmtList(vl.filter(v => f.allowed === null || f.allowed.includes(v)))));
    s.say(rows.join('\n'));
  }
  function showVlanBrief(s) {
    const D = s.dev;
    const rows = [pad('VLAN', 5) + pad('Name', 33) + pad('Status', 10) + 'Ports', '---- -------------------------------- --------- -------------------------------'];
    for (const v of Object.keys(D.vlans).map(Number).sort((a, b) => a - b)) {
      const ports = Object.entries(D.ifaces).filter(([, f]) => f.mode === 'access' && f.vlan === v).map(([n]) => n);
      rows.push(pad(v, 5) + pad(D.vlans[v], 33) + pad('active', 10) + ports.join(', '));
    }
    s.say(rows.join('\n'));
  }
  function showAcl(s) {
    const out = [];
    for (const [num, rules] of Object.entries(s.dev.stdAcls || {})) {
      out.push('Standard IP access list ' + num);
      rules.slice().sort((a, b) => a.seq - b.seq).forEach(r => out.push(`    ${r.seq} ${r.action} ${r.src.w === 0xFFFFFFFF ? 'any' : n2ip(r.src.n) + (r.src.w ? ', wildcard bits ' + n2ip(r.src.w) : '')}`));
    }
    for (const [name, rules] of Object.entries(s.dev.acls)) {
      out.push('Extended IP access list ' + name);
      rules.slice().sort((a, b) => a.seq - b.seq).forEach(r => out.push(`    ${r.seq} ${aceStr(r)}`));
    }
    s.say(out.join('\n') || '% ACL не настроены');
  }
  function runningConfig(s) {
    const D = s.dev, L = ['Building configuration...', '', 'hostname ' + D.name, '!'];
    if (D.type === 'sw') {
      L.push('spanning-tree mode rapid-pvst');
      if (D.stpOff.length) L.push('no spanning-tree vlan ' + fmtList(D.stpOff.slice().sort((a, b) => a - b)));
      for (const [v, p] of Object.entries(D.prio)) L.push(`spanning-tree vlan ${v} priority ${p}`);
      L.push('!');
      for (const v of Object.keys(D.vlans).map(Number).filter(v => v !== 1)) L.push('vlan ' + v, ' name ' + D.vlans[v], '!');
      for (const [ifn, f] of Object.entries(D.ifaces)) {
        L.push('interface ' + fullIf(ifn));
        if (f.desc) L.push(' description ' + f.desc);
        if (f.mode === 'trunk') { L.push(' switchport mode trunk'); if (f.allowed !== null) L.push(' switchport trunk allowed vlan ' + fmtList(f.allowed)); }
        else { L.push(' switchport mode access'); if (f.vlan !== 1) L.push(' switchport access vlan ' + f.vlan); }
        if (f.portfast) L.push(' spanning-tree portfast');
        if (f.bpduguard) L.push(' spanning-tree bpduguard enable');
        if (f.shut) L.push(' shutdown');
        L.push('!');
      }
    } else {
      for (const [ifn, f] of Object.entries(D.ifaces)) {
        L.push('interface ' + fullIf(ifn));
        if (f.desc) L.push(' description ' + f.desc);
        L.push(f.ip !== null ? ` ip address ${n2ip(f.ip)} ${n2ip(pfx2mask(f.pfx))}` : ' no ip address');
        if (f.mtu !== 1500) L.push(' ip mtu ' + f.mtu);
        if (f.hello !== 10) L.push(' ip ospf hello-interval ' + f.hello);
        if (f.mtuIgnore) L.push(' ip ospf mtu-ignore');
        f.helper.forEach(h => L.push(' ip helper-address ' + n2ip(h)));
        if (f.nat) L.push(' ip nat ' + f.nat);
        if (f.aclIn) L.push(` ip access-group ${f.aclIn} in`);
        if (f.aclOut) L.push(` ip access-group ${f.aclOut} out`);
        if (f.shut) L.push(' shutdown');
        L.push('!');
      }
      if (D.ospf) {
        L.push('router ospf ' + D.ospf.pid);
        if (D.rid) L.push(' router-id ' + D.rid);
        D.ospf.passive.forEach(p => L.push(' passive-interface ' + fullIf(p)));
        D.ospf.networks.forEach(nw => L.push(` network ${n2ip(nw.net)} ${n2ip(nw.wc)} area ${nw.area}`));
        L.push('!');
      }
      D.dhcp.excluded.forEach(([a, b]) => L.push('ip dhcp excluded-address ' + n2ip(a) + (a !== b ? ' ' + n2ip(b) : '')));
      for (const [name, p] of Object.entries(D.dhcp.pools)) {
        L.push('ip dhcp pool ' + name);
        if (p.net !== null) L.push(` network ${n2ip(p.net)} ${n2ip(pfx2mask(p.pfx))}`);
        if (p.gw !== null) L.push(' default-router ' + n2ip(p.gw));
        if (p.dns !== null) L.push(' dns-server ' + n2ip(p.dns));
        L.push('!');
      }
      D.nat.dyn.forEach(d => L.push(`ip nat inside source list ${d.list} interface ${fullIf(d.ifn)} overload`));
      D.nat.stat.forEach(x => L.push(`ip nat inside source static ${n2ip(x.local)} ${n2ip(x.global)}`));
      D.routes.forEach(r => L.push(`ip route ${n2ip(r.net)} ${n2ip(pfx2mask(r.pfx))} ${n2ip(r.nh)}`));
      for (const [num, rules] of Object.entries(D.stdAcls)) rules.slice().sort((a, b) => a.seq - b.seq).forEach(r => L.push(`access-list ${num} ${r.action} ${r.src.w === 0xFFFFFFFF ? 'any' : n2ip(r.src.n) + (r.src.w ? ' ' + n2ip(r.src.w) : '')}`));
      for (const [name, rules] of Object.entries(D.acls)) {
        L.push('ip access-list extended ' + name);
        rules.slice().sort((a, b) => a.seq - b.seq).forEach(r => L.push(` ${r.seq} ${aceStr(r)}`));
        L.push('!');
      }
    }
    L.push('end');
    s.say(L.join('\n'));
  }


  function showStp(s, only) {
    const n = s.net, D = s.dev;
    const vl = only !== undefined ? [only] : n.vlansInUse().filter(v => D.vlans[v] && Object.values(D.ifaces).some(f => carriesV(f, v)));
    const out = [];
    for (const v of vl) {
      if (!n.stpOn(s.id, v)) { out.push(`Spanning tree instance(s) for vlan ${v} does not exist.`, ''); continue; }
      const S = n.stp(v), root = S.rootFor[s.id] || s.id, rb = n.bid(root, v), me = n.bid(s.id, v);
      out.push('VLAN' + String(v).padStart(4, '0'), '  Spanning tree enabled protocol rstp',
        `  Root ID    Priority    ${rb[0]}`, `             Address     ${rb[1]}`,
        root === s.id ? '             This bridge is the root' : `             Cost        ${S.cost[s.id]}\n             Port        ${S.rootPort[s.id]}`,
        '', `  Bridge ID  Priority    ${me[0]}  (priority ${me[0] - v} sys-id-ext ${v})`, `             Address     ${me[1]}`, '',
        pad('Interface', 20) + pad('Role', 5) + pad('Sts', 4) + pad('Cost', 10) + pad('Prio.Nbr', 9) + 'Type',
        '------------------- ---- --- --------- -------- --------------------------------');
      Object.entries(D.ifaces).forEach(([ifn, f], k) => {
        if (!n.ifUp(s.id, ifn) || !carriesV(f, v)) return;
        const role = S.roles[s.id + '|' + ifn];
        const peer = n.peerOf(s.id, ifn), edge = !role;
        const r = role || 'Desg', sts = r === 'Altn' ? 'BLK' : 'FWD';
        out.push(pad(ifn, 20) + pad(r, 5) + pad(sts, 4) + pad(ifn.startsWith('Gi') ? 4 : 19, 10) + pad('128.' + (k + 1), 9) + 'P2p' + (edge && n.dev[peer[0]].type !== 'sw' ? ' Edge' : ''));
      });
      out.push('');
    }
    s.say(out.join('\n') || 'No spanning tree instances exist.');
  }
  function showCpu(s) {
    const storm = s.net.l2view().stormSw.has(s.id);
    s.say(storm
      ? 'CPU utilization for five seconds: 99%/91%; one minute: 98%; five minutes: 94%\n PID Runtime(ms)   Invoked  5Sec   Process\n  89   98123412  71234511 61.4%  ARP Input\n 112   41231234  31231299 23.2%  Hulc LED Process\n 201   12312311  11231231  9.8%  HL3U bkgrd process'
      : 'CPU utilization for five seconds: 4%/0%; one minute: 3%; five minutes: 3%\n PID Runtime(ms)   Invoked  5Sec   Process\n 112     412312    312312  1.1%  Hulc LED Process\n  89      12311     11231  0.3%  ARP Input');
  }
  function showNat(s) {
    const D = s.dev, rows = [pad('Pro', 5) + pad('Inside global', 22) + pad('Inside local', 20) + pad('Outside local', 20) + 'Outside global'];
    D.nat.stat.forEach(x => rows.push(pad('---', 5) + pad(n2ip(x.global), 22) + pad(n2ip(x.local), 20) + pad('---', 20) + '---'));
    D.xlate.forEach(x => rows.push(pad(x.proto, 5) + pad(n2ip(x.global) + ':' + x.gport, 22) + pad(n2ip(x.local) + ':' + x.lport, 20) + pad(n2ip(x.remote) + ':' + (x.rport || x.lport), 20) + n2ip(x.remote) + ':' + (x.rport || x.lport)));
    s.say(rows.length > 1 ? rows.join('\n') : '');
  }
  function showNatStats(s) {
    const D = s.dev, ins = [], outs = [];
    for (const [ifn, f] of Object.entries(D.ifaces)) { if (f.nat === 'inside') ins.push(fullIf(ifn)); if (f.nat === 'outside') outs.push(fullIf(ifn)); }
    const L = [`Total active translations: ${D.nat.stat.length + D.xlate.length} (${D.nat.stat.length} static, ${D.xlate.length} dynamic; ${D.xlate.length} extended)`,
      'Outside interfaces:', '  ' + (outs.join(', ') || '(нет)'), 'Inside interfaces:', '  ' + (ins.join(', ') || '(нет)'), 'Dynamic mappings:', '-- Inside Source'];
    D.nat.dyn.forEach(d => L.push(`[Id: 1] access-list ${d.list} interface ${fullIf(d.ifn)} refcount ${D.xlate.length}`));
    s.say(L.join('\n'));
  }
  function showDhcpPool(s) {
    const D = s.dev, out = [];
    for (const [name, p] of Object.entries(D.dhcp.pools)) {
      const leased = p.net === null ? 0 : Object.values(D.dhcp.bindings).filter(ip => sameNet(ip, p.net, p.pfx)).length;
      out.push(`Pool ${name} :`, `  Network                  : ${p.net !== null ? n2ip(p.net) + ' / ' + n2ip(pfx2mask(p.pfx)) : 'не задана'}`,
        `  Default router           : ${p.gw !== null ? n2ip(p.gw) : 'не задан'}`, `  DNS server               : ${p.dns !== null ? n2ip(p.dns) : 'не задан'}`,
        `  Leased addresses         : ${leased}`, '');
    }
    if (D.dhcp.excluded.length) out.push('Excluded: ' + D.dhcp.excluded.map(([a, b]) => a === b ? n2ip(a) : n2ip(a) + ' - ' + n2ip(b)).join(', '));
    s.say(out.join('\n') || '% DHCP-пулы не настроены');
  }
  function showDhcpBinding(s) {
    const rows = [pad('IP address', 18) + pad('Client', 18) + pad('Lease expiration', 24) + 'Type'];
    for (const [cl, ip] of Object.entries(s.dev.dhcp.bindings)) rows.push(pad(n2ip(ip), 18) + pad(s.net.dev[cl] ? s.net.dev[cl].name : cl, 18) + pad('Nov 02 2026 09:00 AM', 24) + 'Automatic');
    s.say(rows.join('\n'));
  }
  function apipa(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return ip2n(`169.254.${(h % 250) + 2}.${((h >> 8) % 250) + 2}`); }
  function dhcpRenew(s) {
    const D = s.dev, e = D.ifaces.eth0, n = s.net;
    D.dhcp = true;
    const r = n.dhcp(s.id);
    if (r.ok) {
      Object.assign(e, { ip: r.ip, pfx: r.pfx }); D.gw = r.gw;
      const via = r.relay ? ` через relay ${n2ip(r.relay.via)}` : '';
      s.say(`\nDHCP: Discover → Offer → Request → Ack (сервер ${n.dev[r.server].name}${via})\n\nАдаптер Ethernet:\n\n   IPv4-адрес. . . . . . . . . . . . : ${n2ip(r.ip)}\n   Маска подсети . . . . . . . . . . : ${n2ip(pfx2mask(r.pfx))}\n   Основной шлюз . . . . . . . . . . : ${r.gw !== null ? n2ip(r.gw) : ''}\n   DNS-серверы . . . . . . . . . . . : ${r.dns !== null ? n2ip(r.dns) : ''}`);
    } else {
      Object.assign(e, { ip: apipa(s.id), pfx: 16 }); D.gw = null;
      s.say(`\nDHCP: Discover … Discover … Discover — ответа нет (${r.reason}).\nОшибка при обновлении интерфейса Ethernet: Не удается связаться с DHCP-сервером. Истекло время ожидания запроса.\n\n   Автонастройка IPv4-адреса . . . . : ${n2ip(e.ip)} (APIPA)\n   Маска подсети . . . . . . . . . . : 255.255.0.0`);
    }
  }

  /* ---------- ping / traceroute ---------- */
  function doPing(s, dstS, style) {
    const dst = ip2n(dstS), n = s.net;
    const r = n.ping(s.id, dst);
    if (s.hooks.trace) s.hooks.trace(r);
    const srcIp = r.fwd.srcIp;
    if (style === 'win') {
      const out = ['', `Обмен пакетами с ${dstS} по с 32 байтами данных:`];
      const arpFail = !r.fwd.ok && r.fwd.kind === 'arp' && r.fwd.at === s.id;
      const ttl = r.ok ? (n.dev[r.fwd.dstDev].type === 'pc' ? 128 : 255) - Math.max(0, r.back.hops.filter(h => n.dev[h.dev].type === 'rt').length - (n.dev[s.id].type === 'rt' ? 1 : 0)) : 0;
      for (let k = 0; k < 4; k++) out.push(r.ok ? `Ответ от ${dstS}: число байт=32 время<1мс TTL=${ttl}` : arpFail ? `Ответ от ${srcIp !== null ? n2ip(srcIp) : '0.0.0.0'}: Заданный узел недоступен.` : (!r.fwd.ok && r.fwd.kind === 'nogw' ? 'Сбой передачи. Общий сбой.' : 'Превышен интервал ожидания для запроса.'));
      out.push('', `Статистика Ping для ${dstS}:`, `    Пакетов: отправлено = 4, получено = ${r.ok || arpFail ? 4 : 0}, потеряно = ${r.ok || arpFail ? 0 : 4}`, `    (${r.ok || arpFail ? 0 : 100}% потерь)`);
      s.say(out.join('\n'));
    } else {
      s.say(`Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${dstS}, timeout is 2 seconds:\n${r.ok ? '!!!!!' : '.....'}\nSuccess rate is ${r.ok ? '100 percent (5/5), round-trip min/avg/max = 1/1/2 ms' : '0 percent (0/5)'}`);
    }
    return r;
  }
  function doTrace(s, dstS, style) {
    const dst = ip2n(dstS), n = s.net;
    const fwd = n.walk(s.id, dst, { proto: 'icmp', sport: 1 });
    if (s.hooks.trace) s.hooks.trace({ ok: fwd.ok, fwd, back: null, fail: fwd.ok ? null : fwd });
    const win = style === 'win';
    const out = win ? ['', `Трассировка маршрута к ${dstS} с максимальным числом прыжков 30`, ''] : ['Type escape sequence to abort.', `Tracing the route to ${dstS}`, ''];
    const hops = fwd.hops.filter(h => n.dev[h.dev].type !== 'sw');
    hops.forEach((h, k) => {
      const last = k === hops.length - 1 && fwd.ok;
      const replyFrom = last ? dst : h.ip;
      const back = last ? n.walk(h.dev, h.src, { proto: 'icmp', srcIp: replyFrom, dport: h.sport }) : n.walk(h.dev, h.src, { proto: 'icmp', srcIp: replyFrom, dport: h.sport, err: true });
      const num = String(k + 1).padStart(2, ' ');
      if (back.ok && back.dstDev === s.id) out.push(win ? `${num}    <1 мс    <1 мс    <1 мс  ${n2ip(replyFrom)}` : `  ${k + 1} ${n2ip(replyFrom)} 1 msec 1 msec 1 msec`);
      else out.push(win ? `${num}     *        *        *     Превышен интервал ожидания для запроса.` : `  ${k + 1}  *  *  *`);
    });
    if (!fwd.ok) {
      for (let k = hops.length; k < hops.length + 2; k++) out.push(win ? `${String(k + 1).padStart(2, ' ')}     *        *        *     Превышен интервал ожидания для запроса.` : `  ${k + 1}  *  *  *`);
      out.push(win ? '\nТрассировка прервана.' : '\nTrace aborted.');
    } else out.push(win ? '\nТрассировка завершена.' : '');
    s.say(out.join('\n'));
  }

  /* ---------- грамматика ---------- */
  const RS = ['rt', 'sw'], R = ['rt'], S = ['sw'], P = ['pc'];
  const IFM = ['if'];
  function G(modes, types, words, run, help) { return { modes, types, pat: words.split(' '), run, help }; }
  function setShut(s, on) {
    const f = s.dev.ifaces[s.ifn];
    if (on) { f.shut = true; f.err = false; } else f.shut = false;
  }
  const GRAMMAR = [
    // --- exec ---
    G(['exec'], RS, 'show running-config', s => runningConfig(s), 'текущая конфигурация'),
    G(['exec'], R, 'show ip interface brief', s => showIpIntBrief(s), 'интерфейсы, IP, статус'),
    G(['exec'], R, 'show ip route', s => showIpRoute(s), 'таблица маршрутизации'),
    G(['exec'], R, 'show ip ospf neighbor', s => showOspfNbr(s), 'соседи OSPF'),
    G(['exec'], R, 'show ip ospf interface brief', s => showOspfInt(s, true), 'интерфейсы в OSPF кратко'),
    G(['exec'], R, 'show ip ospf interface', s => showOspfInt(s, false), 'интерфейсы в OSPF подробно'),
    G(['exec'], R, 'show access-lists', s => showAcl(s), 'списки доступа'),
    G(['exec'], RS, 'show interfaces <if>', (s, a) => showInterface(s, a[0]), 'состояние порта, MTU, ошибки'),
    G(['exec'], S, 'show interfaces status', s => showIntStatus(s), 'статус всех портов'),
    G(['exec'], S, 'show interfaces trunk', s => showTrunk(s), 'транки и разрешённые VLAN'),
    G(['exec'], S, 'show vlan brief', s => showVlanBrief(s), 'VLAN и порты доступа'),
    G(['exec'], RS, 'show logging', s => s.say(s.dev.log.length ? s.dev.log.join('\n') : 'Log buffer: пусто'), 'журнал событий'),
    G(['exec'], R, 'ping <ip>', (s, a) => doPing(s, a[0]), 'проверка доступности'),
    G(['exec'], R, 'traceroute <ip>', (s, a) => doTrace(s, a[0]), 'путь до узла'),
    G(['exec'], RS, 'configure terminal', s => { s.mode = 'config'; s.say('Enter configuration commands, one per line.  End with CNTL/Z.'); }, 'режим настройки'),
    G(['exec'], RS, 'write memory', s => s.say('Building configuration...\n[OK]'), 'сохранить конфиг'),
    G(['exec'], RS, 'copy running-config startup-config', s => s.say('Destination filename [startup-config]?\nBuilding configuration...\n[OK]'), 'сохранить конфиг'),
    G(['exec'], RS, 'exit', s => s.say('(сессия продолжается — это симулятор)')),
    // --- config ---
    G(['config'], RS, 'interface <if>', (s, a) => { s.mode = 'if'; s.ifn = a[0]; }, 'настроить интерфейс'),
    G(['config'], R, 'router ospf <num>', (s, a) => {
      const D = s.dev;
      if (!D.ospf) D.ospf = { pid: +a[0], networks: [], passive: [] };
      else if (D.ospf.pid !== +a[0]) { s.say(`% Уже запущен процесс OSPF ${D.ospf.pid} — в симуляторе поддерживается один процесс`); return; }
      s.mode = 'router';
    }, 'настроить OSPF'),
    G(['config'], R, 'ip route <ip> <mask> <ip>', (s, a) => {
      const r = { net: ip2n(a[0]), pfx: mask2pfx(a[1]), nh: ip2n(a[2]) };
      if (netOf(r.net, r.pfx) !== r.net) { s.say('%Inconsistent address and mask'); return; }
      if (!s.dev.routes.some(x => x.net === r.net && x.pfx === r.pfx && x.nh === r.nh)) s.dev.routes.push(r);
    }, 'статический маршрут'),
    G(['config'], R, 'no ip route <ip> <mask> <ip>', (s, a) => {
      const net = ip2n(a[0]), p = mask2pfx(a[1]), nh = ip2n(a[2]);
      const before = s.dev.routes.length;
      s.dev.routes = s.dev.routes.filter(x => !(x.net === net && x.pfx === p && x.nh === nh));
      if (before === s.dev.routes.length) s.say('%No matching route to delete');
    }, 'удалить маршрут'),
    G(['config'], R, 'ip access-list extended <word>', (s, a) => { if (!s.dev.acls[a[0]]) s.dev.acls[a[0]] = []; s.acl = a[0]; s.mode = 'acl'; }, 'настроить ACL'),
    G(['config'], S, 'vlan <num>', (s, a) => { const v = +a[0]; if (!s.dev.vlans[v]) s.dev.vlans[v] = 'VLAN' + String(v).padStart(4, '0'); s.vlan = v; s.mode = 'vlan'; }, 'создать VLAN'),
    G(['config', 'if', 'router', 'acl', 'vlan'], RS, 'end', s => { s.mode = 'exec'; }, 'выйти в exec'),
    G(['config'], RS, 'exit', s => { s.mode = 'exec'; }),
    G(['if', 'router', 'acl', 'vlan'], RS, 'exit', s => { s.mode = 'config'; }, 'на уровень выше'),
    // --- interface ---
    G(IFM, RS, 'shutdown', s => setShut(s, true), 'выключить порт'),
    G(IFM, RS, 'no shutdown', s => setShut(s, false), 'включить порт'),
    G(IFM, RS, 'description <rest>', (s, a) => { s.dev.ifaces[s.ifn].desc = a[0]; }, 'подпись порта'),
    G(IFM, R, 'ip address <ip> <mask>', (s, a) => {
      const ip = ip2n(a[0]), p = mask2pfx(a[1]);
      if (p < 31 && (ip === netOf(ip, p) || ip === (netOf(ip, p) + 2 ** (32 - p) - 1))) { s.say('% Bad mask /' + p + ' for address ' + a[0]); return; }
      Object.assign(s.dev.ifaces[s.ifn], { ip, pfx: p });
    }, 'IP-адрес интерфейса'),
    G(IFM, R, 'no ip address', s => Object.assign(s.dev.ifaces[s.ifn], { ip: null, pfx: null }), 'удалить IP'),
    G(IFM, R, 'ip mtu <num>', (s, a) => { const v = +a[0]; if (v < 68 || v > 9216) { s.say('% Invalid input: MTU 68-9216'); return; } s.dev.ifaces[s.ifn].mtu = v; }, 'MTU для IP'),
    G(IFM, R, 'no ip mtu', s => { s.dev.ifaces[s.ifn].mtu = 1500; }, 'MTU по умолчанию'),
    G(IFM, R, 'ip ospf hello-interval <num>', (s, a) => { s.dev.ifaces[s.ifn].hello = +a[0]; }, 'таймер hello'),
    G(IFM, R, 'no ip ospf hello-interval', s => { s.dev.ifaces[s.ifn].hello = 10; }),
    G(IFM, R, 'ip ospf mtu-ignore', s => { s.dev.ifaces[s.ifn].mtuIgnore = true; }, 'не сравнивать MTU (костыль)'),
    G(IFM, R, 'no ip ospf mtu-ignore', s => { s.dev.ifaces[s.ifn].mtuIgnore = false; }),
    G(IFM, R, 'ip access-group <word> (in|out)', (s, a) => { s.dev.ifaces[s.ifn][a[1] === 'in' ? 'aclIn' : 'aclOut'] = a[0]; }, 'применить ACL'),
    G(IFM, R, 'no ip access-group <word> (in|out)', (s, a) => { s.dev.ifaces[s.ifn][a[1] === 'in' ? 'aclIn' : 'aclOut'] = null; }, 'снять ACL'),
    G(IFM, S, 'switchport mode (access|trunk)', (s, a) => { s.dev.ifaces[s.ifn].mode = a[0]; }, 'режим порта'),
    G(IFM, S, 'switchport access vlan <num>', (s, a) => {
      const v = +a[0];
      if (!s.dev.vlans[v]) { s.dev.vlans[v] = 'VLAN' + String(v).padStart(4, '0'); s.say(`% Access VLAN does not exist. Creating vlan ${v}`); }
      s.dev.ifaces[s.ifn].vlan = v;
    }, 'VLAN порта доступа'),
    G(IFM, S, 'switchport trunk allowed vlan <list>', (s, a) => { s.dev.ifaces[s.ifn].allowed = parseList(a[0]); }, 'ЗАМЕНИТЬ список VLAN на транке'),
    G(IFM, S, 'switchport trunk allowed vlan add <list>', (s, a) => {
      const f = s.dev.ifaces[s.ifn]; if (f.allowed === null) return;
      f.allowed = [...new Set(f.allowed.concat(parseList(a[0])))].sort((x, y) => x - y);
    }, 'добавить VLAN на транк'),
    G(IFM, S, 'switchport trunk allowed vlan remove <list>', (s, a) => {
      const f = s.dev.ifaces[s.ifn], rm = parseList(a[0]);
      const base = f.allowed === null ? Array.from({ length: 4094 }, (_, k) => k + 1) : f.allowed;
      f.allowed = base.filter(v => !rm.includes(v));
    }, 'убрать VLAN с транка'),
    G(IFM, S, 'switchport trunk allowed vlan all', s => { s.dev.ifaces[s.ifn].allowed = null; }, 'разрешить все VLAN'),
    G(IFM, S, 'spanning-tree portfast', s => { s.dev.ifaces[s.ifn].portfast = true; }),
    G(IFM, S, 'spanning-tree bpduguard (enable|disable)', (s, a) => { s.dev.ifaces[s.ifn].bpduguard = a[0] === 'enable'; }, 'защита от чужих коммутаторов'),
    // --- router ospf ---
    G(['router'], R, 'network <ip> <ip> area <num>', (s, a) => {
      const nw = { net: ip2n(a[0]), wc: ip2n(a[1]), area: +a[2] };
      const ex = s.dev.ospf.networks.find(x => x.net === nw.net && x.wc === nw.wc);
      if (ex) { if (ex.area !== nw.area) s.say(`% OSPF: "network ${a[0]} ${a[1]} area ${ex.area}" уже настроен — сначала удалите его (no network ...)`); return; }
      s.dev.ospf.networks.push(nw);
    }, 'включить OSPF на интерфейсах'),
    G(['router'], R, 'no network <ip> <ip> area <num>', (s, a) => {
      const o = s.dev.ospf, b = o.networks.length;
      o.networks = o.networks.filter(x => !(x.net === ip2n(a[0]) && x.wc === ip2n(a[1]) && x.area === +a[2]));
      if (b === o.networks.length) s.say('% Такой network-команды нет');
    }, 'убрать network'),
    G(['router'], R, 'passive-interface <if>', (s, a) => { if (!s.dev.ospf.passive.includes(a[0])) s.dev.ospf.passive.push(a[0]); }, 'без hello на интерфейсе'),
    G(['router'], R, 'no passive-interface <if>', (s, a) => { s.dev.ospf.passive = s.dev.ospf.passive.filter(x => x !== a[0]); }),
    // --- ACL ---
    G(['acl'], R, '<num> <rest>', (s, a) => aclAdd(s, +a[0], a[1]), 'строка с номером: 15 permit ...'),
    G(['acl'], R, 'permit <rest>', (s, a) => aclAdd(s, null, 'permit ' + a[0]), 'permit <proto> <src> <dst> [eq порт]'),
    G(['acl'], R, 'deny <rest>', (s, a) => aclAdd(s, null, 'deny ' + a[0]), 'deny <proto> <src> <dst> [eq порт]'),
    G(['acl'], R, 'no <num>', (s, a) => {
      const L = s.dev.acls[s.acl], b = L.length;
      s.dev.acls[s.acl] = L.filter(r => r.seq !== +a[0]);
      if (b === s.dev.acls[s.acl].length) s.say('% Строки с таким номером нет');
    }, 'удалить строку по номеру'),
    // --- vlan ---
    G(['vlan'], S, 'name <word>', (s, a) => { s.dev.vlans[s.vlan] = a[0]; }, 'имя VLAN'),
    // --- PC ---
    G(P, P, 'ipconfig', s => {
      const D = s.dev, e = D.ifaces.eth0;
      s.say(`\nАдаптер Ethernet:\n\n   DHCP включён. . . . . . . . . . . : ${D.dhcp ? 'Да' : 'Нет'}\n   IPv4-адрес. . . . . . . . . . . . : ${e.ip !== null ? n2ip(e.ip) : '—'}\n   Маска подсети . . . . . . . . . . : ${e.pfx !== null ? n2ip(pfx2mask(e.pfx)) : '—'}\n   Основной шлюз . . . . . . . . . . : ${D.gw !== null ? n2ip(D.gw) : ''}`);
    }, 'текущие IP, маска, шлюз'),
    G(P, P, 'ipconfig <ip> <mask> <ip>', (s, a) => {
      const D = s.dev; Object.assign(D.ifaces.eth0, { ip: ip2n(a[0]), pfx: mask2pfx(a[1]) }); D.gw = ip2n(a[2]); D.dhcp = false;
      s.say('Настройки применены.');
    }, 'задать IP, маску, шлюз'),
    G(P, P, 'ping <ip>', (s, a) => doPing(s, a[0], 'win'), 'проверка доступности'),
    G(P, P, 'tracert <ip>', (s, a) => doTrace(s, a[0], 'win'), 'путь до узла'),
    G(P, P, 'telnet <ip>', (s, a) => {
      const r = s.net.ping(s.id, ip2n(a[0]), { proto: 'tcp', dport: 23 });
      if (s.hooks.trace) s.hooks.trace(r);
      s.say(r.ok ? `Подключение к ${a[0]}...\nConnected. (порт 23 открыт)\n— соединение закрыто симулятором` : `Подключение к ${a[0]}...Не удалось открыть подключение к этому узлу, на порт 23: Сбой подключения`);
    }, 'проверить TCP 23'),

    // --- STP ---
    G(['exec'], S, 'show spanning-tree', s => showStp(s), 'состояние STP по VLAN'),
    G(['exec'], S, 'show spanning-tree vlan <num>', (s, a) => showStp(s, +a[0]), 'STP в одном VLAN'),
    G(['exec'], RS, 'show processes cpu', s => showCpu(s), 'загрузка CPU'),
    G(['config'], S, 'spanning-tree vlan <list>', (s, a) => { const l = parseList(a[0]); s.dev.stpOff = s.dev.stpOff.filter(v => !l.includes(v)); }, 'включить STP в VLAN'),
    G(['config'], S, 'no spanning-tree vlan <list>', (s, a) => { const l = parseList(a[0]); s.dev.stpOff = [...new Set(s.dev.stpOff.concat(l))]; }, 'выключить STP в VLAN (опасно!)'),
    G(['config'], S, 'spanning-tree vlan <list> priority <num>', (s, a) => {
      const p = +a[1]; if (p % 4096 || p > 61440) { s.say('% Bridge Priority must be in increments of 4096 (0-61440)'); return; }
      parseList(a[0]).forEach(v => { s.dev.prio[v] = p; });
    }, 'приоритет моста (меньше — главнее)'),
    G(['config'], S, 'spanning-tree mode rapid-pvst', () => {}, 'режим RSTP'),
    // --- NAT ---
    G(['exec'], R, 'show ip nat translations', s => showNat(s), 'таблица трансляций NAT'),
    G(['exec'], R, 'show ip nat statistics', s => showNatStats(s), 'inside/outside интерфейсы и правила'),
    G(IFM, R, 'ip nat (inside|outside)', (s, a) => { s.dev.ifaces[s.ifn].nat = a[0]; }, 'роль интерфейса в NAT'),
    G(IFM, R, 'no ip nat (inside|outside)', (s, a) => { const f = s.dev.ifaces[s.ifn]; if (f.nat === a[0]) f.nat = null; }),
    G(['config'], R, 'ip nat inside source list <word> interface <if> overload', (s, a) => {
      if (!s.dev.nat.dyn.some(d => d.list === a[0] && d.ifn === a[1])) s.dev.nat.dyn.push({ list: a[0], ifn: a[1] });
    }, 'PAT: много адресов в один'),
    G(['config'], R, 'no ip nat inside source list <word> interface <if> overload', (s, a) => { s.dev.nat.dyn = s.dev.nat.dyn.filter(d => !(d.list === a[0] && d.ifn === a[1])); }),
    G(['config'], R, 'ip nat inside source static <ip> <ip>', (s, a) => {
      const l = ip2n(a[0]), g = ip2n(a[1]);
      if (s.dev.nat.stat.some(x => x.global === g)) { s.say(`% ${a[1]} уже используется в другой статической трансляции`); return; }
      s.dev.nat.stat.push({ local: l, global: g });
    }, 'статический NAT 1:1'),
    G(['config'], R, 'no ip nat inside source static <ip> <ip>', (s, a) => {
      const b = s.dev.nat.stat.length;
      s.dev.nat.stat = s.dev.nat.stat.filter(x => !(x.local === ip2n(a[0]) && x.global === ip2n(a[1])));
      if (b === s.dev.nat.stat.length) s.say('% Такой статической трансляции нет');
    }),
    G(['config'], R, 'access-list <num> <rest>', (s, a) => {
      const r = parseStd(a[1].split(/\s+/));
      if (!r) { s.say('% Формат: access-list N permit|deny <адрес> [wildcard] | any | host A'); return; }
      const L = s.dev.stdAcls[a[0]] = s.dev.stdAcls[a[0]] || [];
      L.push(Object.assign({ seq: L.reduce((m, x) => Math.max(m, x.seq), 0) + 10 }, r));
    }, 'стандартный ACL (по источнику)'),
    G(['config'], R, 'no access-list <num>', (s, a) => { delete s.dev.stdAcls[a[0]]; }, 'удалить стандартный ACL'),
    G(['exec'], R, 'clear ip nat translation *', s => { s.dev.xlate = []; }, 'очистить динамические трансляции'),
    // --- DHCP ---
    G(['exec'], R, 'show ip dhcp pool', s => showDhcpPool(s), 'DHCP-пулы'),
    G(['exec'], R, 'show ip dhcp binding', s => showDhcpBinding(s), 'выданные адреса'),
    G(['exec'], R, 'clear ip dhcp binding *', s => { s.dev.dhcp.bindings = {}; }, 'забыть выданные адреса'),
    G(['config'], R, 'ip dhcp pool <word>', (s, a) => {
      if (!s.dev.dhcp.pools[a[0]]) s.dev.dhcp.pools[a[0]] = { net: null, pfx: null, gw: null, dns: null };
      s.pool = a[0]; s.mode = 'dhcp';
    }, 'настроить DHCP-пул'),
    G(['config'], R, 'no ip dhcp pool <word>', (s, a) => { delete s.dev.dhcp.pools[a[0]]; }),
    G(['config'], R, 'ip dhcp excluded-address <ip>', (s, a) => { s.dev.dhcp.excluded.push([ip2n(a[0]), ip2n(a[0])]); }, 'не выдавать адрес'),
    G(['config'], R, 'ip dhcp excluded-address <ip> <ip>', (s, a) => { s.dev.dhcp.excluded.push([ip2n(a[0]), ip2n(a[1])]); }, 'не выдавать диапазон'),
    G(['config'], R, 'no ip dhcp excluded-address <ip> <ip>', (s, a) => { s.dev.dhcp.excluded = s.dev.dhcp.excluded.filter(([x, y]) => !(x === ip2n(a[0]) && y === ip2n(a[1]))); }),
    G(['dhcp'], R, 'network <ip> <mask>', (s, a) => Object.assign(s.dev.dhcp.pools[s.pool], { net: netOf(ip2n(a[0]), mask2pfx(a[1])), pfx: mask2pfx(a[1]) }), 'сеть пула'),
    G(['dhcp'], R, 'default-router <ip>', (s, a) => { s.dev.dhcp.pools[s.pool].gw = ip2n(a[0]); }, 'шлюз для клиентов'),
    G(['dhcp'], R, 'no default-router', s => { s.dev.dhcp.pools[s.pool].gw = null; }),
    G(['dhcp'], R, 'dns-server <ip>', (s, a) => { s.dev.dhcp.pools[s.pool].dns = ip2n(a[0]); }, 'DNS для клиентов'),
    G(['dhcp'], R, 'exit', s => { s.mode = 'config'; }, 'на уровень выше'),
    G(['dhcp'], R, 'end', s => { s.mode = 'exec'; }, 'выйти в exec'),
    G(IFM, R, 'ip helper-address <ip>', (s, a) => { const f = s.dev.ifaces[s.ifn], h = ip2n(a[0]); if (!f.helper.includes(h)) f.helper.push(h); }, 'DHCP relay на сервер'),
    G(IFM, R, 'no ip helper-address <ip>', (s, a) => { const f = s.dev.ifaces[s.ifn]; f.helper = f.helper.filter(h => h !== ip2n(a[0])); }),
    G(P, P, 'ipconfig /renew', s => dhcpRenew(s), 'получить адрес по DHCP'),
    G(P, P, 'ipconfig /release', s => { const D = s.dev; Object.assign(D.ifaces.eth0, { ip: null, pfx: null }); D.gw = null; s.say('Адрес освобождён.'); }, 'отдать адрес DHCP'),
    G(P, P, 'help', s => s.help([]), 'список команд'),
  ];
  function aclAdd(s, seq, text) {
    const ace = parseAce(text.split(/\s+/));
    if (!ace) { s.say('% Invalid input. Формат: permit|deny ip|icmp|tcp|udp <src> <dst> [eq порт], адрес — any | host A | A wildcard'); return; }
    const L = s.dev.acls[s.acl];
    if (seq === null) seq = (L.reduce((m, r) => Math.max(m, r.seq), 0)) + 10;
    if (L.some(r => r.seq === seq)) { s.say(`% Duplicate sequence number ${seq}`); return; }
    L.push(Object.assign({ seq }, ace));
  }

  const NetSim = { Net, Session, PC, SW, RT, ip2n, n2ip, mask2pfx, fullIf };
  if (typeof module !== 'undefined' && module.exports) module.exports = NetSim;
  else root.NetSim = NetSim;
})(typeof window !== 'undefined' ? window : globalThis);
