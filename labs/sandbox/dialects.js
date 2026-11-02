/* Сетевая песочница — диалекты CLI: Huawei VRP и Juniper Junos.
   Модель сети общая (engine.js), здесь только синтаксис команд, режимы и формат выводов.
   Имена интерфейсов в модели — в стиле IOS (Gi0/1, Fa0/1); здесь они переводятся
   в GigabitEthernet0/0/1 / XGigabitEthernet0/0/1 (VRP) и ge-0/0/1 / xe-0/1/1 (Junos). */
(function (root) {
  'use strict';
  const N = root.NetSim || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const { ip2n, n2ip, pfx2mask, mask2pfx, netOf, sameNet, parseList, pad, carriesV, G } = N._;
  const RS = ['rt', 'sw'], R = ['rt'], S = ['sw'];

  /* ================= общее ================= */
  const hasFa = dev => Object.keys(dev.ifaces).some(n => n.startsWith('Fa'));
  const ifParts = n => { const m = n.match(/^(Fa|Gi)0\/(\d+)$/); return m ? { t: m[1], n: m[2] } : null; };
  const areaStr = a => n2ip(a);
  const parseArea = t => /^\d+$/.test(t) ? +t : ip2n(t);
  const parseMl = t => /^\d{1,2}$/.test(t) ? +t : mask2pfx(t);
  const STATE = { FULL: 'Full', EXSTART: 'ExStart', EXCHANGE: 'Exchange', LOADING: 'Loading', DOWN: 'Down' };
  const stamp = (k) => `Nov  1 2026 07:${String(12 + (k % 40)).padStart(2, '0')}:${String((k * 17) % 60).padStart(2, '0')}`;

  function ifState(s, ifn) {
    const f = s.dev.ifaces[ifn];
    return { admin: !f.shut, err: f.err, up: s.net.ifUp(s.id, ifn) };
  }
  function pingData(s, dstS) {
    const n = s.net, r = n.ping(s.id, ip2n(dstS));
    if (s.hooks.trace) s.hooks.trace(r);
    let ttl = 0;
    if (r.ok) {
      const base = n.dev[r.fwd.dstDev].type === 'pc' ? 128 : 255;
      const routers = r.back.hops.filter(h => n.dev[h.dev].type === 'rt').length - (n.dev[s.id].type === 'rt' ? 1 : 0);
      ttl = base - Math.max(0, routers);
    }
    return { r, ttl };
  }
  function traceData(s, dstS) {
    const n = s.net, dst = ip2n(dstS);
    const fwd = n.walk(s.id, dst, { proto: 'icmp', sport: 1 });
    if (s.hooks.trace) s.hooks.trace({ ok: fwd.ok, fwd, back: null, fail: fwd.ok ? null : fwd });
    const hops = fwd.hops.filter(h => n.dev[h.dev].type !== 'sw');
    const rows = hops.map((h, k) => {
      const last = k === hops.length - 1 && fwd.ok, from = last ? dst : h.ip;
      const back = n.walk(h.dev, h.src, { proto: 'icmp', srcIp: from, dport: h.sport, err: !last });
      return back.ok && back.dstDev === s.id ? n2ip(from) : null;
    });
    if (!fwd.ok) rows.push(null, null);
    return { rows, ok: fwd.ok };
  }
  // PC-команды берутся из базовой грамматики (Windows)
  const pcGrammar = () => N._.GRAMMAR.filter(g => g.types.includes('pc'));

  /* =====================================================================
     HUAWEI VRP
     ===================================================================== */
  function vName(dev, n) {
    const p = ifParts(n); if (!p) return n;
    return (p.t === 'Gi' && hasFa(dev) ? 'XGigabitEthernet0/0/' : 'GigabitEthernet0/0/') + p.n;
  }
  const vShort = (dev, n) => vName(dev, n).replace('XGigabitEthernet', 'XGE').replace('GigabitEthernet', 'GE');
  function vNorm(dev, tok) {
    const m = String(tok).match(/^([a-zA-Z]+)\s*([\d/]+)$/);
    if (!m) return null;
    const L = m[1].toLowerCase();
    for (const n of Object.keys(dev.ifaces)) {
      if (n === 'eth0') continue;
      const fm = vName(dev, n).match(/^([A-Za-z]+)([\d/]+)$/);
      if (fm[2] !== m[2]) continue;
      const full = fm[1].toLowerCase(), short = full === 'xgigabitethernet' ? 'xge' : 'ge';
      if (full.startsWith(L) || short === L) return n;
    }
    return null;
  }
  function vList(arr) {
    if (!arr.length) return '';
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      let j = i; while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
      out.push(j > i ? arr[i] + ' to ' + arr[j] : String(arr[i])); i = j;
    }
    return out.join(' ');
  }
  function vParseVlans(text) { // "10 20", "10 to 20", "all"
    const t = text.toLowerCase().split(/\s+/);
    if (t.includes('all')) return 'all';
    const out = new Set();
    for (let i = 0; i < t.length; i++) {
      if (!/^\d+$/.test(t[i])) return null;
      if (t[i + 1] === 'to' && /^\d+$/.test(t[i + 2] || '')) { for (let v = +t[i]; v <= +t[i + 2]; v++) out.add(v); i += 2; }
      else out.add(+t[i]);
    }
    return [...out].sort((a, b) => a - b);
  }
  function vInit(s) {
    const D = s.dev;
    if (D.type === 'sw') {
      if (D.stpOff.length) { D.stpAllOff = true; D.stpOff = []; }
      const p = Object.values(D.prio)[0]; if (p && !D.prioAll) D.prioAll = p;
    }
    if (D.type === 'rt') {
      for (const f of Object.values(D.ifaces)) {
        if (f.helper.length) f.dhcpSelect = 'relay';
        else if (f.ip !== null && Object.values(D.dhcp.pools).some(p => p.net !== null && sameNet(f.ip, p.net, p.pfx))) f.dhcpSelect = 'global';
      }
      if (Object.keys(D.dhcp.pools).length || Object.values(D.ifaces).some(f => f.dhcpSelect)) D.dhcpEn = true;
    }
  }
  function vPrompt(s) {
    const D = s.dev, h = D.name;
    switch (s.mode) {
      case 'user': return `<${h}>`;
      case 'sys': return `[${h}]`;
      case 'if': return `[${h}-${vName(D, s.ifn)}]`;
      case 'ospf': return `[${h}-ospf-${D.ospf.pid}]`;
      case 'area': return `[${h}-ospf-${D.ospf.pid}-area-${areaStr(s.area)}]`;
      case 'pool': return `[${h}-ip-pool-${s.pool}]`;
      case 'vlan': return `[${h}-vlan${s.vlan}]`;
    }
    return `[${h}]`;
  }
  const vStatus = (s, ifn) => { const st = ifState(s, ifn); return st.admin ? (st.up ? 'up' : 'down') : '*down'; };

  function vIpIntBrief(s) {
    const D = s.dev, rows = [];
    const ifs = Object.keys(D.ifaces);
    const up = ifs.filter(i => s.net.ifUp(s.id, i)).length;
    rows.push('*down: administratively down', '^down: standby', '(l): loopback', '(s): spoofing',
      `The number of interface that is UP in Physical is ${up}`, `The number of interface that is DOWN in Physical is ${ifs.length - up}`, '',
      pad('Interface', 34) + pad('IP Address/Mask', 21) + pad('Physical', 11) + 'Protocol');
    for (const i of ifs) {
      const f = D.ifaces[i], st = vStatus(s, i);
      rows.push(pad(vName(D, i), 34) + pad(f.ip !== null ? n2ip(f.ip) + '/' + f.pfx : 'unassigned', 21) + pad(st, 11) + (st === 'up' && f.ip !== null ? 'up' : 'down'));
    }
    s.say(rows.join('\n'));
  }
  function vIntBrief(s) {
    const D = s.dev, rows = ['PHY: Physical', '*down: administratively down', '(e): ETHOAM down', '(d): Dampening Suppressed', 'InUti/OutUti: input utility/output utility',
      pad('Interface', 28) + pad('PHY', 7) + pad('Protocol', 9) + pad('InUti', 7) + pad('OutUti', 8) + pad('inErrors', 10) + 'outErrors'];
    const storm = s.net.l2view().stormSw.has(s.id);
    for (const i of Object.keys(D.ifaces)) {
      const st = vStatus(s, i), u = st === 'up' ? (storm ? '99.87%' : '0.01%') : '0%';
      rows.push(pad(vName(D, i), 28) + pad(st, 7) + pad(st === 'up' ? 'up' : 'down', 9) + pad(u, 7) + pad(u, 8) + pad(0, 10) + '0');
    }
    s.say(rows.join('\n'));
  }
  function vInterface(s, ifn) {
    const D = s.dev, f = D.ifaces[ifn], st = ifState(s, ifn);
    const state = !st.admin ? 'Administratively DOWN' : st.err ? 'ERROR DOWN(bpdu-protection)' : st.up ? 'UP' : 'DOWN';
    const L = [`${vName(D, ifn)} current state : ${state}`, `Line protocol current state : ${st.up ? 'UP' : 'DOWN'}`, `Description: ${f.desc || ''}`];
    if (D.type === 'rt') {
      L.push(`Route Port,The Maximum Transmit Unit is ${f.mtu}`);
      L.push(f.ip !== null ? `Internet Address is ${n2ip(f.ip)}/${f.pfx}` : 'Internet protocol processing : disabled');
    } else {
      L.push(`Switch Port, PVID : ${f.mode === 'access' ? f.vlan : 1}, TPID : 8100(Hex), The Maximum Frame Length is 9216`);
      if (s.net.l2view().stormSw.has(s.id) && st.up) L.push('Last 300 seconds input rate 97412000 bits/sec, 141233 packets/sec', 'Input: 98123441 packets, Broadcast: 97881122, Multicast: 241233');
    }
    L.push('Speed : 1000,  Loopback: NONE', 'Duplex: FULL,  Negotiation: ENABLE', 'Input:  CRC: 0, Giants: 0, Jabbers: 0, Fragments: 0', 'Output: Collisions: 0, Late Collisions: 0');
    s.say(L.join('\n'));
  }
  function vVlan(s) {
    const D = s.dev, vl = Object.keys(D.vlans).map(Number).sort((a, b) => a - b);
    const L = [`The total number of vlans is : ${vl.length}`, '-'.repeat(80), 'U: Up;         D: Down;         TG: Tagged;         UT: Untagged;', '-'.repeat(80), pad('VID', 5) + pad('Type', 8) + 'Ports', '-'.repeat(80)];
    for (const v of vl) {
      const ut = [], tg = [];
      for (const [i, f] of Object.entries(D.ifaces)) {
        if (!carriesV(f, v)) continue;
        const tag = `${vShort(D, i)}(${s.net.ifUp(s.id, i) ? 'U' : 'D'})`;
        if (f.mode === 'access' || v === 1) ut.push(tag); else tg.push(tag);
      }
      L.push(pad(v, 5) + pad('common', 8) + (ut.length ? 'UT:' + ut.join('  ') : '') + (tg.length ? (ut.length ? '\n' + ' '.repeat(13) : '') + 'TG:' + tg.join('  ') : ''));
    }
    s.say(L.join('\n'));
  }
  function vPortVlan(s) {
    const D = s.dev, L = [pad('Port', 28) + pad('Link Type', 13) + pad('PVID', 6) + 'Trunk VLAN List', '-'.repeat(79)];
    for (const [i, f] of Object.entries(D.ifaces)) {
      L.push(pad(vName(D, i), 28) + pad(f.mode, 13) + pad(f.mode === 'access' ? f.vlan : 1, 6) + (f.mode === 'trunk' ? (f.allowed === null ? '1-4094' : vList(f.allowed)) : '-'));
    }
    s.say(L.join('\n'));
  }
  function vStpBrief(s) {
    const D = s.dev, n = s.net;
    if (D.stpAllOff) { s.say('Info: The STP is disabled.'); return; }
    const v = (n.vlansInUse().find(x => x !== 1 && Object.values(D.ifaces).some(f => carriesV(f, x)))) || 1;
    const St = n.stp(v), L = [' MSTID  Port                        Role  STP State     Protection'];
    for (const [i, f] of Object.entries(D.ifaces)) {
      if (!n.ifUp(s.id, i) || !carriesV(f, v)) continue;
      const role = St.roles[s.id + '|' + i] || 'Desg';
      const r = { Root: 'ROOT', Desg: 'DESI', Altn: 'ALTE' }[role];
      L.push(`   0    ${pad(vName(D, i), 28)}${pad(r, 6)}${pad(role === 'Altn' ? 'DISCARDING' : 'FORWARDING', 14)}${f.bpduguard ? 'BPDU' : 'NONE'}`);
    }
    s.say(L.join('\n'));
  }
  function vStp(s) {
    const D = s.dev, n = s.net;
    if (D.stpAllOff) { s.say('Protocol Status :Disabled\nInfo: The STP is disabled.'); return; }
    const v = (n.vlansInUse().find(x => x !== 1 && Object.values(D.ifaces).some(f => carriesV(f, x)))) || 1;
    const St = n.stp(v), root = St.rootFor[s.id] || s.id, me = n.bid(s.id, v), rb = n.bid(root, v);
    const mac = m => m.replace(/\./g, '-');
    s.say(['-------[CIST Global Info][Mode MSTP]-------', `CIST Bridge         :${me[0] - v} .${mac(me[1])}`,
      `CIST Root/ERPC      :${rb[0] - v} .${mac(rb[1])} / ${St.cost[s.id] || 0}`, `CIST RootPortId     :${St.rootPort[s.id] ? '128.' + St.rootPort[s.id].split('/')[1] + ' (' + vName(D, St.rootPort[s.id]) + ')' : '0.0'}`,
      `BPDU-Protection     :${Object.values(D.ifaces).some(f => f.bpduguard) ? 'Enabled' : 'Disabled'}`].join('\n'));
    vStpBrief(s);
  }
  function vRoutes(s, dstS) {
    const D = s.dev, n = s.net;
    let rib = n.rib(s.id);
    if (dstS) { const e = n.lookup(s.id, ip2n(dstS)); rib = e ? [e] : []; }
    const P = { C: ['Direct', 0], S: ['Static', 60], O: ['OSPF', 10] };
    const L = ['Route Flags: R - relay, D - download to fib', '-'.repeat(78), 'Routing Tables: Public', `         Destinations : ${rib.length}        Routes : ${rib.length}`, '',
      pad('Destination/Mask', 20) + pad('Proto', 8) + pad('Pre', 5) + pad('Cost', 10) + pad('Flags', 6) + pad('NextHop', 16) + 'Interface', ''];
    for (const e of rib) {
      const nh = e.code === 'C' ? D.ifaces[e.ifn].ip : e.nh;
      L.push(pad(n2ip(e.net) + '/' + e.pfx, 20).padStart(21) + pad(P[e.code][0], 8) + pad(P[e.code][1], 5) + pad(e.metric, 10) + pad(e.code === 'C' ? 'D' : 'RD', 6) + pad(n2ip(nh), 16) + vName(D, e.ifn));
    }
    if (!rib.length) L.push(' Info: The route does not exist.');
    s.say(L.join('\n'));
  }
  function vOspfPeer(s, brief) {
    const D = s.dev, n = s.net;
    if (!D.ospf) { s.say('Info: OSPF is not enabled.'); return; }
    const nb = n.ospfNeighbors(s.id);
    const L = [`\t OSPF Process ${D.ospf.pid} with Router ID ${n2ip(n.rid(s.id))}`];
    if (brief) {
      L.push('\t\t  Peer Statistic Information', ' ' + '-'.repeat(76), ' ' + pad('Area Id', 17) + pad('Interface', 33) + pad('Neighbor id', 17) + 'State');
      for (const x of nb) L.push(' ' + pad(areaStr(n.ospfIf(s.id, x.ifn).area), 17) + pad(vName(D, x.ifn), 33) + pad(n2ip(x.rid), 17) + STATE[x.state]);
      L.push(' ' + '-'.repeat(76));
    } else {
      for (const x of nb) L.push('', `\t\t Neighbors`, ` Area ${areaStr(n.ospfIf(s.id, x.ifn).area)} interface ${n2ip(D.ifaces[x.ifn].ip)}(${vName(D, x.ifn)})'s neighbors`,
        ` Router ID: ${n2ip(x.rid)}         Address: ${n2ip(x.ip)}`, `   State: ${STATE[x.state]}  Mode:Nbr is  Master  Priority: 1`, '   Dead timer due in 35  sec');
    }
    s.say(L.join('\n'));
  }
  function vOspfIf(s, ifn) {
    const D = s.dev, n = s.net;
    if (!D.ospf) { s.say('Info: OSPF is not enabled.'); return; }
    const L = [`\t OSPF Process ${D.ospf.pid} with Router ID ${n2ip(n.rid(s.id))}`, '\t\t Interfaces'];
    const byArea = {};
    for (const i of Object.keys(D.ifaces)) { const o = n.ospfIf(s.id, i); if (o && (!ifn || i === ifn)) (byArea[o.area] = byArea[o.area] || []).push([i, o]); }
    for (const [a, list] of Object.entries(byArea)) {
      L.push('', ` Area: ${areaStr(+a)}          (MPLS TE not enabled)`);
      if (ifn) {
        for (const [i, o] of list) {
          const f = D.ifaces[i];
          L.push(` Interface: ${n2ip(f.ip)} (${vName(D, i)})`, ` Cost: 1       State: ${n.ifUp(s.id, i) ? 'P-2-P' : 'Down'}    Type: P2P       MTU: ${f.mtu}`,
            ` Timers: Hello ${f.hello} , Dead ${f.hello * 4} , Poll  120 , Retransmit 5 , Transmit Delay 1 `, o.passive ? ' Silent interface (no hello sent)' : '');
        }
      } else {
        L.push(' ' + pad('IP Address', 16) + pad('Type', 13) + pad('State', 9) + pad('Cost', 8) + pad('Pri', 6) + pad('DR', 16) + 'BDR');
        for (const [i, o] of list) L.push(' ' + pad(n2ip(D.ifaces[i].ip), 16) + pad(o.passive ? 'Broadcast' : 'P2P', 13) + pad(n.ifUp(s.id, i) ? (o.passive ? 'DR' : 'P-2-P') : 'Down', 9) + pad(1, 8) + pad(1, 6) + pad('0.0.0.0', 16) + '0.0.0.0');
      }
    }
    s.say(L.join('\n'));
  }
  function vLogLine(line, D, k) {
    let m;
    if ((m = line.match(/MACFLAP_NOTIF: Host (\S+) in vlan (\d+) is flapping between port (\S+) and port (\S+)/)))
      return `${stamp(k)} ${D.name} L2IFPPI/4/MFLPVLANALARM:OID 1.3.6.1.4.1.2011.5.25.160.3.7 MAC move detected, VlanId = ${m[2]}, MacAddress = ${m[1].replace(/\./g, '-')}, Original-Port = ${vShort(D, m[3])}, Flapping port = ${vShort(D, m[4])}.`;
    if ((m = line.match(/BPDU on port (\S+) with BPDU Guard/)))
      return `${stamp(k)} ${D.name} MSTP/4/BPDU_PROTECTION:This edged-port ${vName(D, m[1])} that enabled BPDU-Protection will be shutdown, because it received BPDU packet!`;
    if ((m = line.match(/bpduguard error detected on (\S+),/)))
      return `${stamp(k)} ${D.name} ERROR-DOWN/4/ERRORDOWN:Interface ${vName(D, m[1])} has turned into Error-Down state (cause=bpdu-protection).`;
    if ((m = line.match(/^%LINK-3-UPDOWN: Interface \S+?(\d+)\/(\d+), changed state to (\S+)/)))
      return `${stamp(k)} ${D.name} IFNET/4/LINK_STATE:The line protocol IP on the interface ${vName(D, (D.ifaces['Fa' + m[1] + '/' + m[2]] ? 'Fa' : 'Gi') + m[1] + '/' + m[2])} has entered the ${m[3] === 'up' ? 'UP' : 'DOWN'} state.`;
    return line.startsWith('Nov') ? line : `${stamp(k)} ${D.name} ${line}`;
  }
  function vPool(s, name) {
    const D = s.dev, L = [];
    const pools = Object.entries(D.dhcp.pools).filter(([pn]) => !name || pn === name);
    if (!pools.length) { s.say(name ? 'Error: The pool does not exist.' : 'Info: No IP pool is configured.'); return; }
    for (const [pn, p] of pools) {
      const used = p.net === null ? 0 : Object.values(D.dhcp.bindings).filter(ip => sameNet(ip, p.net, p.pfx)).length;
      const gws = [p.gw].concat(p.gw2 || []).filter(x => x !== null);
      L.push(`  Pool-name      : ${pn}`, '  Pool-No        : 0', '  Lease          : 1 Days 0 Hours 0 Minutes', '  Domain-name    : -',
        `  DNS-server0    : ${p.dns !== null ? n2ip(p.dns) : '-'}`, ...(gws.length ? gws.map((g, k) => `  Gateway-${k}      : ${n2ip(g)}`) : ['  Gateway-0      : -']),
        `  Network        : ${p.net !== null ? n2ip(p.net) : '-'}`, `  Mask           : ${p.pfx !== null ? n2ip(pfx2mask(p.pfx)) : '-'}`,
        `  Used           : ${used}`, '');
      if (name && D.dhcp.excluded.length) L.push('  Excluded       : ' + D.dhcp.excluded.map(([a, b]) => a === b ? n2ip(a) : n2ip(a) + ' - ' + n2ip(b)).join(', '));
    }
    s.say(L.join('\n'));
  }
  function vIfConfig(D, i) {
    const f = D.ifaces[i], L = ['interface ' + vName(D, i)];
    if (f.desc) L.push(' description ' + f.desc);
    if (D.type === 'sw') {
      L.push(' port link-type ' + f.mode);
      if (f.mode === 'access' && f.vlan !== 1) L.push(' port default vlan ' + f.vlan);
      if (f.mode === 'trunk') L.push(' port trunk allow-pass vlan ' + (f.allowed === null ? 'all' : vList(f.allowed)));
      if (f.portfast) L.push(' stp edged-port enable');
    } else {
      if (f.ip !== null) L.push(` ip address ${n2ip(f.ip)} ${n2ip(pfx2mask(f.pfx))}`);
      if (f.mtu !== 1500) L.push(' mtu ' + f.mtu);
      if (f.hello !== 10) L.push(' ospf timer hello ' + f.hello);
      if (f.dhcpSelect) L.push(' dhcp select ' + f.dhcpSelect);
      f.helper.forEach(h => L.push(' dhcp relay server-ip ' + n2ip(h)));
    }
    if (f.shut) L.push(' shutdown');
    return L;
  }
  function vConfig(s) {
    const D = s.dev, L = ['#', ' sysname ' + D.name, '#'];
    if (D.type === 'sw') {
      const vl = Object.keys(D.vlans).map(Number).filter(v => v !== 1);
      if (vl.length) L.push('vlan batch ' + vList(vl.sort((a, b) => a - b)), '#');
      const stp = [];
      if (D.stpAllOff) stp.push('stp disable');
      if (D.prioAll) stp.push('stp priority ' + D.prioAll);
      if (Object.values(D.ifaces).some(f => f.bpduguard)) stp.push('stp bpdu-protection');
      if (stp.length) L.push(...stp, '#');
    } else {
      if (D.dhcpEn) L.push('dhcp enable', '#');
      for (const [pn, p] of Object.entries(D.dhcp.pools)) {
        L.push('ip pool ' + pn);
        [p.gw].concat(p.gw2 || []).filter(x => x !== null).forEach(g => L.push(' gateway-list ' + n2ip(g)));
        if (p.net !== null) L.push(` network ${n2ip(p.net)} mask ${n2ip(pfx2mask(p.pfx))}`);
        D.dhcp.excluded.filter(([a]) => p.net !== null && sameNet(a, p.net, p.pfx)).forEach(([a, b]) => L.push(' excluded-ip-address ' + n2ip(a) + (a !== b ? ' ' + n2ip(b) : '')));
        if (p.dns !== null) L.push(' dns-list ' + n2ip(p.dns));
        L.push('#');
      }
    }
    for (const i of Object.keys(D.ifaces)) L.push(...vIfConfig(D, i), '#');
    if (D.type === 'rt') {
      if (D.ospf) {
        L.push(`ospf ${D.ospf.pid}${D.rid ? ' router-id ' + D.rid : ''}`);
        D.ospf.passive.forEach(p => L.push(' silent-interface ' + vName(D, p)));
        const areas = [...new Set(D.ospf.networks.map(x => x.area))].sort((a, b) => a - b);
        for (const a of areas) {
          L.push(' area ' + areaStr(a));
          D.ospf.networks.filter(x => x.area === a).forEach(x => L.push(`  network ${n2ip(x.net)} ${n2ip(x.wc)}`));
        }
        L.push('#');
      }
      D.routes.forEach(r => L.push(`ip route-static ${n2ip(r.net)} ${n2ip(pfx2mask(r.pfx))} ${n2ip(r.nh)}`));
      if (D.routes.length) L.push('#');
    }
    L.push('return');
    s.say(L.join('\n'));
  }
  function vPing(s, dstS) {
    const { r, ttl } = pingData(s, dstS), L = [`  PING ${dstS}: 56  data bytes, press CTRL_C to break`];
    for (let k = 1; k <= 5; k++) L.push(r.ok ? `    Reply from ${dstS}: bytes=56 Sequence=${k} ttl=${ttl} time=${k === 1 ? 2 : 1} ms` : '    Request time out');
    L.push('', `  --- ${dstS} ping statistics ---`, '    5 packet(s) transmitted', `    ${r.ok ? 5 : 0} packet(s) received`, `    ${r.ok ? '0.00' : '100.00'}% packet loss`);
    if (r.ok) L.push('    round-trip min/avg/max = 1/1/2 ms');
    s.say(L.join('\n'));
  }
  function vTrace(s, dstS) {
    const t = traceData(s, dstS), L = [` traceroute to  ${dstS}(${dstS}), max hops: 30 ,packet length: 40,press CTRL_C to break`];
    t.rows.forEach((ip, k) => L.push(ip ? ` ${k + 1} ${ip} 10 ms  1 ms  1 ms` : ` ${k + 1} * * *`));
    s.say(L.join('\n'));
  }
  function vSetShut(s, on) { const f = s.dev.ifaces[s.ifn]; if (on) { f.shut = true; f.err = false; } else f.shut = false; }
  function vStpAll(s, on) { s.dev.stpAllOff = !on; s.dev.stpOff = []; if (on) s.say('Info: This operation may take a few seconds. Please wait for a moment...done.'); }

  const VALL = ['user', 'sys', 'if', 'ospf', 'area', 'pool', 'vlan'];
  const VSUB = ['if', 'ospf', 'area', 'pool', 'vlan'];
  const VRP_GRAMMAR = [
    // display — доступно в любом режиме
    G(VALL, R, 'display ip interface brief', s => vIpIntBrief(s), 'интерфейсы, IP, статус'),
    G(VALL, RS, 'display interface brief', s => vIntBrief(s), 'статус всех портов'),
    G(VALL, RS, 'display interface <if>', (s, a) => vInterface(s, a[0]), 'состояние порта, MTU, ошибки'),
    G(VALL, S, 'display vlan', s => vVlan(s), 'VLAN и порты (UT/TG)'),
    G(VALL, S, 'display port vlan', s => vPortVlan(s), 'тип порта, PVID, VLAN транка'),
    G(VALL, S, 'display stp brief', s => vStpBrief(s), 'роли и состояния портов STP'),
    G(VALL, S, 'display stp', s => vStp(s), 'STP: корень, мост, порты'),
    G(VALL, RS, 'display current-configuration', s => vConfig(s), 'текущая конфигурация'),
    G(['if'], RS, 'display this', s => s.say(vIfConfig(s.dev, s.ifn).concat('#', 'return').join('\n')), 'конфигурация этого интерфейса'),
    G(VALL, R, 'display ip routing-table', s => vRoutes(s), 'таблица маршрутизации'),
    G(VALL, R, 'display ip routing-table <ip>', (s, a) => vRoutes(s, a[0]), 'маршрут до адреса'),
    G(VALL, R, 'display ospf peer brief', s => vOspfPeer(s, true), 'соседи OSPF кратко'),
    G(VALL, R, 'display ospf peer', s => vOspfPeer(s, false), 'соседи OSPF подробно'),
    G(VALL, R, 'display ospf interface', s => vOspfIf(s), 'интерфейсы OSPF по областям'),
    G(VALL, R, 'display ospf interface <if>', (s, a) => vOspfIf(s, a[0]), 'интерфейс OSPF: таймеры, MTU'),
    G(VALL, R, 'display ip pool', s => vPool(s), 'DHCP-пулы'),
    G(VALL, R, 'display ip pool name <word>', (s, a) => vPool(s, a[0]), 'пул подробно'),
    G(VALL, RS, 'display logbuffer', s => s.say(s.dev.log.length ? s.dev.log.map((l, k) => vLogLine(l, s.dev, k)).join('\n') : 'Logging buffer: пусто'), 'журнал событий'),
    G(VALL, RS, 'display cpu-usage', s => s.say(s.net.l2view().stormSw.has(s.id)
      ? 'CPU Usage Stat. Cycle: 60 (Second)\nCPU Usage            : 99% Max: 100%\nCPU Usage Stat. Time : 2026-11-01  07:31:12\n\nTaskName        CPU  Runtime(CPU Tick High/Tick Low)  Task Explanation\nSOCK            61%        0/ 9812341        SOCK\nFTS             24%        0/ 4123123        FTS\nVPR             11%        0/ 1231231        VPR'
      : 'CPU Usage Stat. Cycle: 60 (Second)\nCPU Usage            : 4% Max: 9%\nCPU Usage Stat. Time : 2026-11-01  07:31:12'), 'загрузка CPU'),
    // user view
    G(['user'], RS, 'system-view', s => { s.mode = 'sys'; s.say('Enter system view, return user view with return command.'); }, 'режим настройки'),
    G(['user'], RS, 'save', s => s.say('The current configuration will be written to the device.\nAre you sure to continue? [Y/N]:y\nNow saving the current configuration to the slot 0.\nSave the configuration successfully.'), 'сохранить конфиг'),
    G(['user'], R, 'ping <ip>', (s, a) => vPing(s, a[0]), 'проверка доступности'),
    G(['user'], R, 'tracert <ip>', (s, a) => vTrace(s, a[0]), 'путь до узла'),
    G(['user'], RS, 'quit', s => s.say('(сессия продолжается — это симулятор)')),
    // переходы между видами
    G(VSUB, RS, 'quit', s => { s.mode = s.mode === 'area' ? 'ospf' : 'sys'; }, 'на уровень выше'),
    G(['sys'], RS, 'quit', s => { s.mode = 'user'; }, 'в user view'),
    G(['sys'].concat(VSUB), RS, 'return', s => { s.mode = 'user'; }, 'сразу в user view'),
    G(['sys'], RS, 'interface <if>', (s, a) => { s.mode = 'if'; s.ifn = a[0]; }, 'настроить интерфейс'),
    // switch: VLAN, STP
    G(['sys'], S, 'vlan <num>', (s, a) => { const v = +a[0]; if (!s.dev.vlans[v]) s.dev.vlans[v] = 'VLAN ' + String(v).padStart(4, '0'); s.vlan = v; s.mode = 'vlan'; }, 'создать VLAN'),
    G(['sys'], S, 'vlan batch <rest>', (s, a) => {
      const l = vParseVlans(a[0]); if (!l || l === 'all') { s.say("Error: Wrong parameter found at '^' position."); return; }
      l.forEach(v => { if (!s.dev.vlans[v]) s.dev.vlans[v] = 'VLAN ' + String(v).padStart(4, '0'); });
      s.say('Info: This operation may take a few seconds. Please wait for a moment...done.');
    }, 'создать несколько VLAN'),
    G(['vlan'], S, 'description <rest>', (s, a) => { s.dev.vlans[s.vlan] = a[0]; }, 'описание VLAN'),
    G(['sys'], S, 'stp enable', s => vStpAll(s, true), 'включить STP'),
    G(['sys'], S, 'stp disable', s => vStpAll(s, false), 'выключить STP (опасно!)'),
    G(['sys'], S, 'undo stp enable', s => vStpAll(s, false)),
    G(['sys'], S, 'stp priority <num>', (s, a) => {
      const p = +a[0]; if (p % 4096 || p > 61440) { s.say('Error: The priority must be a multiple of 4096 (0-61440).'); return; }
      s.dev.prioAll = p; s.dev.prio = {};
    }, 'приоритет моста (меньше — главнее)'),
    G(['sys'], S, 'undo stp priority', s => { s.dev.prioAll = 0; s.dev.prio = {}; }),
    G(['sys'], S, 'stp bpdu-protection', s => Object.values(s.dev.ifaces).forEach(f => { if (f.portfast) f.bpduguard = true; }), 'BPDU-защита edge-портов'),
    G(['if'], S, 'port link-type (access|trunk)', (s, a) => { s.dev.ifaces[s.ifn].mode = a[0]; }, 'тип порта'),
    G(['if'], S, 'port default vlan <num>', (s, a) => {
      const v = +a[0]; if (!s.dev.vlans[v]) { s.say('Error: The VLAN does not exist.'); return; }
      const f = s.dev.ifaces[s.ifn]; if (f.mode !== 'access') { s.say('Error: Please set the link-type of the port to access first.'); return; }
      f.vlan = v;
    }, 'VLAN порта доступа'),
    G(['if'], S, 'undo port default vlan', s => { s.dev.ifaces[s.ifn].vlan = 1; }),
    G(['if'], S, 'port trunk allow-pass vlan <rest>', (s, a) => {
      const f = s.dev.ifaces[s.ifn], l = vParseVlans(a[0]);
      if (f.mode !== 'trunk') { s.say('Error: Please set the link-type of the port to trunk first.'); return; }
      if (!l) { s.say("Error: Wrong parameter found at '^' position."); return; }
      if (l === 'all') f.allowed = null;
      else if (f.allowed !== null) f.allowed = [...new Set(f.allowed.concat(l))].sort((x, y) => x - y);
    }, 'ДОБАВИТЬ VLAN на транк'),
    G(['if'], S, 'undo port trunk allow-pass vlan <rest>', (s, a) => {
      const f = s.dev.ifaces[s.ifn], l = vParseVlans(a[0]); if (!l) return;
      const base = f.allowed === null ? Array.from({ length: 4094 }, (_, k) => k + 1) : f.allowed;
      f.allowed = l === 'all' ? [1] : base.filter(v => !l.includes(v));
    }, 'убрать VLAN с транка'),
    G(['if'], S, 'stp edged-port enable', s => { s.dev.ifaces[s.ifn].portfast = true; }, 'edge-порт (как portfast)'),
    G(['if'], RS, 'shutdown', s => vSetShut(s, true), 'выключить порт'),
    G(['if'], RS, 'undo shutdown', s => vSetShut(s, false), 'включить порт'),
    G(['if'], RS, 'description <rest>', (s, a) => { s.dev.ifaces[s.ifn].desc = a[0]; }, 'описание порта'),
    // router: IP, MTU, маршруты
    G(['if'], R, 'ip address <ip> <ml>', (s, a) => Object.assign(s.dev.ifaces[s.ifn], { ip: ip2n(a[0]), pfx: parseMl(a[1]) }), 'IP-адрес (маска или длина)'),
    G(['if'], R, 'undo ip address', s => Object.assign(s.dev.ifaces[s.ifn], { ip: null, pfx: null }), 'удалить IP'),
    G(['if'], R, 'mtu <num>', (s, a) => { s.dev.ifaces[s.ifn].mtu = +a[0]; }, 'MTU интерфейса'),
    G(['if'], R, 'undo mtu', s => { s.dev.ifaces[s.ifn].mtu = 1500; }),
    G(['if'], R, 'ospf timer hello <num>', (s, a) => { s.dev.ifaces[s.ifn].hello = +a[0]; }, 'таймер hello'),
    G(['if'], R, 'undo ospf timer hello', s => { s.dev.ifaces[s.ifn].hello = 10; }),
    G(['sys'], R, 'ip route-static <ip> <ml> <ip>', (s, a) => {
      const r = { net: ip2n(a[0]), pfx: parseMl(a[1]), nh: ip2n(a[2]) };
      if (netOf(r.net, r.pfx) !== r.net) { s.say('Error: The destination address and mask do not match.'); return; }
      if (!s.dev.routes.some(x => x.net === r.net && x.pfx === r.pfx && x.nh === r.nh)) s.dev.routes.push(r);
    }, 'статический маршрут'),
    G(['sys'], R, 'undo ip route-static <ip> <ml> <ip>', (s, a) => {
      const b = s.dev.routes.length, net = ip2n(a[0]), p = parseMl(a[1]), nh = ip2n(a[2]);
      s.dev.routes = s.dev.routes.filter(x => !(x.net === net && x.pfx === p && x.nh === nh));
      if (b === s.dev.routes.length) s.say('Error: The route does not exist.');
    }, 'удалить маршрут'),
    // OSPF
    G(['sys'], R, 'ospf <num>', (s, a) => {
      if (!s.dev.ospf) s.dev.ospf = { pid: +a[0], networks: [], passive: [] };
      else if (s.dev.ospf.pid !== +a[0]) { s.say(`Error: OSPF process ${s.dev.ospf.pid} already exists (в симуляторе — один процесс).`); return; }
      s.mode = 'ospf';
    }, 'войти в процесс OSPF'),
    G(['ospf'], R, 'area <area>', (s, a) => { s.area = parseArea(a[0]); s.mode = 'area'; }, 'войти в область'),
    G(['ospf'], R, 'silent-interface <if>', (s, a) => { if (!s.dev.ospf.passive.includes(a[0])) s.dev.ospf.passive.push(a[0]); }, 'без hello (как passive)'),
    G(['ospf'], R, 'undo silent-interface <if>', (s, a) => { s.dev.ospf.passive = s.dev.ospf.passive.filter(x => x !== a[0]); }),
    G(['area'], R, 'network <ip> <ip>', (s, a) => {
      const nw = { net: ip2n(a[0]), wc: ip2n(a[1]), area: s.area };
      const ex = s.dev.ospf.networks.find(x => x.net === nw.net && x.wc === nw.wc);
      if (ex) { if (ex.area !== nw.area) s.say(`Error: The network ${a[0]} ${a[1]} has been configured in area ${areaStr(ex.area)}.`); return; }
      s.dev.ospf.networks.push(nw);
    }, 'включить OSPF на интерфейсах'),
    G(['area'], R, 'undo network <ip> <ip>', (s, a) => {
      const o = s.dev.ospf, b = o.networks.length;
      o.networks = o.networks.filter(x => !(x.net === ip2n(a[0]) && x.wc === ip2n(a[1]) && x.area === s.area));
      if (b === o.networks.length) s.say('Error: The network does not exist in this area.');
    }, 'убрать network из области'),
    // DHCP
    G(['sys'], R, 'dhcp enable', s => { s.dev.dhcpEn = true; }, 'включить DHCP глобально'),
    G(['sys'], R, 'ip pool <word>', (s, a) => {
      if (!s.dev.dhcp.pools[a[0]]) { s.dev.dhcp.pools[a[0]] = { net: null, pfx: null, gw: null, dns: null, gw2: [] }; s.say('Info: It\'s successful to create an IP address pool.'); }
      s.pool = a[0]; s.mode = 'pool';
    }, 'глобальный DHCP-пул'),
    G(['pool'], R, 'network <ip> mask <ml>', (s, a) => { const p = parseMl(a[1]); Object.assign(s.dev.dhcp.pools[s.pool], { net: netOf(ip2n(a[0]), p), pfx: p }); }, 'сеть пула'),
    G(['pool'], R, 'gateway-list <ip>', (s, a) => {
      const p = s.dev.dhcp.pools[s.pool], g = ip2n(a[0]); p.gw2 = p.gw2 || [];
      if (p.gw === null) p.gw = g; else if (p.gw !== g && !p.gw2.includes(g)) p.gw2.push(g); // список: клиент получает первый
    }, 'ДОБАВИТЬ шлюз в список (клиенту — первый)'),
    G(['pool'], R, 'undo gateway-list <ip>', (s, a) => {
      const p = s.dev.dhcp.pools[s.pool], g = ip2n(a[0]); p.gw2 = p.gw2 || [];
      if (p.gw === g) p.gw = p.gw2.length ? p.gw2.shift() : null;
      else if (p.gw2.includes(g)) p.gw2 = p.gw2.filter(x => x !== g);
      else s.say('Error: The gateway does not exist.');
    }, 'убрать шлюз из списка'),
    G(['pool'], R, 'dns-list <ip>', (s, a) => { s.dev.dhcp.pools[s.pool].dns = ip2n(a[0]); }, 'DNS для клиентов'),
    G(['pool'], R, 'excluded-ip-address <ip>', (s, a) => { s.dev.dhcp.excluded.push([ip2n(a[0]), ip2n(a[0])]); }, 'не выдавать адрес'),
    G(['pool'], R, 'excluded-ip-address <ip> <ip>', (s, a) => { s.dev.dhcp.excluded.push([ip2n(a[0]), ip2n(a[1])]); }, 'не выдавать диапазон'),
    G(['if'], R, 'dhcp select (global|relay|interface)', (s, a) => { s.dev.ifaces[s.ifn].dhcpSelect = a[0]; if (!s.dev.dhcpEn) s.say('Warning: DHCP is disabled globally (dhcp enable).'); }, 'режим DHCP на интерфейсе'),
    G(['if'], R, 'undo dhcp select (global|relay|interface)', (s, a) => { const f = s.dev.ifaces[s.ifn]; if (f.dhcpSelect === a[0]) f.dhcpSelect = null; if (a[0] === 'relay') f.helper = []; }),
    G(['if'], R, 'dhcp relay server-ip <ip>', (s, a) => {
      const f = s.dev.ifaces[s.ifn];
      if (f.dhcpSelect !== 'relay') { s.say('Error: Please configure dhcp select relay first.'); return; }
      const h = ip2n(a[0]); if (!f.helper.includes(h)) f.helper.push(h);
    }, 'адрес DHCP-сервера для relay'),
    G(['if'], R, 'undo dhcp relay server-ip <ip>', (s, a) => { const f = s.dev.ifaces[s.ifn]; f.helper = f.helper.filter(h => h !== ip2n(a[0])); }),
  ];

  N.DIALECTS.vrp = {
    name: 'Huawei VRP', startMode: 'user', init: vInit, prompt: vPrompt,
    grammar: VRP_GRAMMAR.concat(pcGrammar()), normIf: vNorm, ifShort: vShort,
    fallback: mode => mode === 'area' ? ['ospf', 'sys'] : VSUB.includes(mode) ? ['sys'] : [],
    errors: { invalid: "Error: Unrecognized command found at '^' position.", incomplete: "Error: Incomplete command found at '^' position.", ambiguous: "Error: Ambiguous command found at '^' position." },
    event(s, kind, D, d) {
      const k = D.log.length;
      if (kind === 'link') return { print: true, lines: [`${stamp(k)} ${D.name} %%01IFNET/4/LINK_STATE(l)[${k}]:The line protocol IP on the interface ${vName(D, d.ifn)} has entered the ${d.up ? 'UP' : 'DOWN'} state.`] };
      const x = d.nbr, ev = d.to === 'FULL' ? 'LoadingDone' : d.to === 'DOWN' ? 'KillNbr' : 'NegotiationDone';
      return { print: true, lines: [`${stamp(k)} ${D.name} %%01OSPF/4/NBR_CHANGE_E(l)[${k}]:Neighbor changes event: neighbor status changed. (ProcessId=${D.ospf.pid}, NeighborAddress=${n2ip(x.ip)}, NeighborEvent=${ev}, NeighborPreviousState=${STATE[d.from]}, NeighborCurrentState=${STATE[d.to]})`] };
    },
  };

  /* =====================================================================
     JUNIPER JUNOS
     ===================================================================== */
  function jName(dev, n) {
    const p = ifParts(n); if (!p) return n;
    return (p.t === 'Gi' && hasFa(dev) ? 'xe-0/1/' : 'ge-0/0/') + p.n;
  }
  function jNorm(dev, tok) {
    const t = String(tok).toLowerCase().replace(/\.0$/, '');
    for (const n of Object.keys(dev.ifaces)) if (n !== 'eth0' && jName(dev, n) === t) return n;
    return null;
  }
  const clone = o => JSON.parse(JSON.stringify(o));
  function jInit(s) {
    const D = s.dev;
    if (D.type === 'rt' && D.ospf && !D.ospf.ifs) { // network-команды → OSPF по интерфейсам
      const ifs = [];
      for (const [i, f] of Object.entries(D.ifaces)) {
        if (f.ip === null) continue;
        const nw = D.ospf.networks.find(x => ((f.ip & ~x.wc) >>> 0) === ((x.net & ~x.wc) >>> 0));
        if (nw) ifs.push({ ifn: i, area: nw.area });
      }
      D.ospf.ifs = ifs; D.ospf.networks = [];
    }
    s.cand = null;
  }
  function jSetLines(D) {
    const L = ['set system host-name ' + D.name];
    for (const [i, f] of Object.entries(D.ifaces)) {
      const n = jName(D, i);
      if (f.desc) L.push(`set interfaces ${n} description "${f.desc}"`);
      if (f.shut) L.push(`set interfaces ${n} disable`);
      if (f.ip !== null) L.push(`set interfaces ${n} unit 0 family inet address ${n2ip(f.ip)}/${f.pfx}`);
      if (f.mtu !== 1500) L.push(`set interfaces ${n} unit 0 family inet mtu ${f.mtu}`);
    }
    if (D.rid) L.push('set routing-options router-id ' + D.rid);
    D.routes.forEach(r => L.push(`set routing-options static route ${n2ip(r.net)}/${r.pfx} next-hop ${n2ip(r.nh)}`));
    if (D.ospf && D.ospf.ifs) for (const e of D.ospf.ifs) {
      const base = `set protocols ospf area ${areaStr(e.area)} interface ${jName(D, e.ifn)}.0`;
      L.push(base);
      if (D.ospf.passive.includes(e.ifn)) L.push(base + ' passive');
      if (D.ifaces[e.ifn].hello !== 10) L.push(base + ' hello-interval ' + D.ifaces[e.ifn].hello);
    }
    return L;
  }
  const PAIR = new Set(['unit', 'family', 'area', 'interface', 'route', 'address', 'host-name', 'mtu', 'next-hop', 'hello-interval', 'router-id']);
  function jElems(line) {
    const t = line.replace(/^set /, '').match(/"[^"]*"|\S+/g), out = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === 'description') { out.push(t.slice(i).join(' ')); break; }
      if (PAIR.has(t[i]) && i + 1 < t.length) { out.push(t[i] + ' ' + t[i + 1]); i++; } else out.push(t[i]);
    }
    return out;
  }
  function jHier(lines) {
    const tree = { k: [], c: {} };
    for (const l of lines) {
      let node = tree;
      for (const e of jElems(l)) { if (!node.c[e]) { node.c[e] = { k: [], c: {} }; node.k.push(e); } node = node.c[e]; }
    }
    const out = [];
    const walk = (node, ind) => node.k.forEach(k => {
      const ch = node.c[k];
      if (ch.k.length) { out.push(ind + k + ' {'); walk(ch, ind + '    '); out.push(ind + '}'); } else out.push(ind + k + ';');
    });
    walk(tree, '');
    return out.join('\n');
  }
  function jCompare(a, b) {
    const A = new Set(a), B = new Set(b), out = [];
    const diff = [...a.filter(x => !B.has(x)).map(x => ['-', x]), ...b.filter(x => !A.has(x)).map(x => ['+', x])];
    let last = null;
    for (const [sgn, l] of diff) {
      const e = jElems(l), head = '[edit ' + e.slice(0, -1).join(' ') + ']';
      if (head !== last) { out.push(head); last = head; }
      out.push(`${sgn}   ${e[e.length - 1]};`);
    }
    return out.join('\n');
  }
  const jDirty = s => s.cand && jSetLines(s.cand).join('\n') !== jSetLines(s.dev).join('\n');
  function jIfTerse(s) {
    const D = s.dev, L = [pad('Interface', 24) + pad('Admin', 6) + pad('Link', 5) + pad('Proto', 9) + pad('Local', 22) + 'Remote'];
    for (const [i, f] of Object.entries(D.ifaces)) {
      const st = ifState(s, i), n = jName(D, i);
      L.push(pad(n, 24) + pad(st.admin ? 'up' : 'down', 6) + (st.up ? 'up' : 'down'));
      if (f.ip !== null) L.push(pad(n + '.0', 24) + pad('up', 6) + pad(st.up ? 'up' : 'down', 5) + pad('inet', 9) + n2ip(f.ip) + '/' + f.pfx);
    }
    s.say(L.join('\n'));
  }
  function jInterface(s, ifn, ext) {
    const D = s.dev, f = D.ifaces[ifn], st = ifState(s, ifn), n = jName(D, ifn), idx = 512 + Object.keys(D.ifaces).indexOf(ifn) * 2;
    const L = [`Physical interface: ${n}, ${st.admin ? 'Enabled' : 'Administratively down'}, Physical link is ${st.up ? 'Up' : 'Down'}`,
      `  Interface index: ${140 + idx % 50}, SNMP ifIndex: ${idx}`];
    if (f.desc) L.push('  Description: ' + f.desc);
    L.push('  Link-level type: Ethernet, MTU: 1514, Speed: 1000mbps, Duplex: Full-Duplex');
    if (ext) L.push('  Input errors:', '    Errors: 0, Drops: 0, Framing errors: 0, Runts: 0, Giants: 0', '  Output errors:', '    Carrier transitions: 1, Errors: 0, Drops: 0, Collisions: 0');
    if (f.ip !== null) {
      L.push(`  Logical interface ${n}.0 (Index ${330 + idx % 50}) (SNMP ifIndex ${idx + 1})`, `    Flags: ${st.up ? 'Up' : 'Down'} SNMP-Traps 0x4000 Encapsulation: ENET2`,
        `    Protocol inet, MTU: ${f.mtu}`, '      Addresses, Flags: Is-Preferred Is-Primary',
        `        Destination: ${n2ip(netOf(f.ip, f.pfx))}/${f.pfx}, Local: ${n2ip(f.ip)}, Broadcast: ${n2ip(netOf(f.ip, f.pfx) + 2 ** (32 - f.pfx) - 1)}`);
    }
    s.say(L.join('\n'));
  }
  function jRoutes(s, dstS) {
    const D = s.dev, n = s.net;
    let rib = n.rib(s.id);
    if (dstS) { const e = n.lookup(s.id, ip2n(dstS)); rib = e ? [e] : []; }
    const rows = [];
    for (const e of rib) {
      const pre = (n2ip(e.net) + '/' + e.pfx).padEnd(19);
      if (e.code === 'C') {
        rows.push(`${pre}*[Direct/0] 00:42:17`, `                    >  via ${jName(D, e.ifn)}.0`);
        if (!dstS) rows.push(`${(n2ip(D.ifaces[e.ifn].ip) + '/32').padEnd(19)}*[Local/0] 00:42:17`, `                       Local via ${jName(D, e.ifn)}.0`);
      } else if (e.code === 'S') rows.push(`${pre}*[Static/5] 00:12:03`, `                    >  to ${n2ip(e.nh)} via ${jName(D, e.ifn)}.0`);
      else rows.push(`${pre}*[OSPF/10] 00:0${e.metric}:21, metric ${e.metric}`, `                    >  to ${n2ip(e.nh)} via ${jName(D, e.ifn)}.0`);
    }
    const cnt = rows.filter(r => r.includes('*[')).length;
    s.say([`\ninet.0: ${cnt} destinations, ${cnt} routes (${cnt} active, 0 holddown, 0 hidden)`, '+ = Active Route, - = Last Active, * = Both', ''].concat(rows).join('\n'));
  }
  function jOspfNbr(s) {
    const D = s.dev, n = s.net;
    if (!D.ospf) { s.say('error: OSPF instance is not running'); return; }
    const L = [pad('Address', 17) + pad('Interface', 23) + pad('State', 10) + pad('ID', 17) + pad('Pri', 5) + 'Dead'];
    for (const x of n.ospfNeighbors(s.id)) L.push(pad(n2ip(x.ip), 17) + pad(jName(D, x.ifn) + '.0', 23) + pad(STATE[x.state], 10) + pad(n2ip(x.rid), 17) + pad(128, 5) + '35');
    s.say(L.join('\n'));
  }
  function jOspfIf(s, detail) {
    const D = s.dev, n = s.net;
    if (!D.ospf) { s.say('error: OSPF instance is not running'); return; }
    const nb = n.ospfNeighbors(s.id), L = [pad('Interface', 20) + pad('State', 8) + pad('Area', 16) + pad('DR ID', 16) + pad('BDR ID', 16) + 'Nbrs'];
    for (const i of Object.keys(D.ifaces)) {
      const o = n.ospfIf(s.id, i); if (!o) continue;
      const f = D.ifaces[i], up = n.ifUp(s.id, i);
      L.push(pad(jName(D, i) + '.0', 20) + pad(!up ? 'Down' : o.passive ? 'DR' : 'PtToPt', 8) + pad(areaStr(o.area), 16) + pad('0.0.0.0', 16) + pad('0.0.0.0', 16) + nb.filter(x => x.ifn === i).length);
      if (detail) L.push(`  Type: P2P, Address: ${n2ip(f.ip)}, Mask: ${n2ip(pfx2mask(f.pfx))}, MTU: ${f.mtu}, Cost: 1`,
        `  Adj count: ${nb.filter(x => x.ifn === i && x.state === 'FULL').length}${o.passive ? ', Passive' : ''}`, `  Hello: ${f.hello}, Dead: ${f.hello * 4}, ReXmit: 5, Not Stub`, '');
    }
    s.say(L.join('\n'));
  }
  function jPing(s, dstS) {
    const { r, ttl } = pingData(s, dstS), L = [`PING ${dstS} (${dstS}): 56 data bytes`];
    if (r.ok) for (let k = 0; k < 5; k++) L.push(`64 bytes from ${dstS}: icmp_seq=${k} ttl=${ttl} time=${(1.1 + k * 0.07).toFixed(3)} ms`);
    L.push('', `--- ${dstS} ping statistics ---`, `5 packets transmitted, ${r.ok ? 5 : 0} packets received, ${r.ok ? 0 : 100}% packet loss`);
    if (r.ok) L.push('round-trip min/avg/max/stddev = 1.100/1.240/1.380/0.099 ms');
    s.say(L.join('\n'));
  }
  function jTrace(s, dstS) {
    const t = traceData(s, dstS), L = [`traceroute to ${dstS} (${dstS}), 30 hops max, 40 byte packets`];
    t.rows.forEach((ip, k) => L.push(ip ? ` ${k + 1}  ${ip} (${ip})  1.012 ms  0.871 ms  0.802 ms` : ` ${k + 1}  * * *`));
    s.say(L.join('\n'));
  }
  function jCommit(s, check) {
    const C = s.cand;
    if (C.ospf && C.ospf.ifs) {
      const seen = {};
      for (const e of C.ospf.ifs) {
        if (seen[e.ifn] !== undefined && seen[e.ifn] !== e.area) {
          s.say(`[edit protocols ospf]\n  'area ${areaStr(e.area)}'\n    interface ${jName(C, e.ifn)}.0 configured in more than one area\nerror: configuration check-out failed`);
          return false;
        }
        seen[e.ifn] = e.area;
      }
    }
    if (check) { s.say('configuration check succeeds'); return true; }
    const D = s.dev;
    for (const [i, f] of Object.entries(C.ifaces)) {
      const L = D.ifaces[i];
      for (const k of ['ip', 'pfx', 'mtu', 'hello', 'desc']) L[k] = f[k];
      if (f.shut && !L.shut) { L.shut = true; L.err = false; } else if (!f.shut) L.shut = false;
    }
    D.routes = clone(C.routes); D.ospf = clone(C.ospf);
    s.cand = clone(D);
    s.say('commit complete');
    return true;
  }
  // правки кандидата: функция получает (cand, args) и возвращает текст ошибки или ничего
  function J(words, fn, help) {
    return G(['cfg'], R, words, (s, a) => { if (!s.cand) s.cand = clone(s.dev); const err = fn(s.cand, a, s); if (err) s.say(err); }, help);
  }
  const ospfOf = C => { if (!C.ospf) C.ospf = { pid: 1, networks: [], passive: [], ifs: [] }; if (!C.ospf.ifs) C.ospf.ifs = []; return C.ospf; };
  const JUNOS_GRAMMAR = [
    G(['op'], R, 'show interfaces terse', s => jIfTerse(s), 'интерфейсы кратко'),
    G(['op'], R, 'show interfaces <if>', (s, a) => jInterface(s, a[0], false), 'интерфейс: статус, MTU, адрес'),
    G(['op'], R, 'show interfaces <if> extensive', (s, a) => jInterface(s, a[0], true), 'интерфейс + счётчики ошибок'),
    G(['op'], R, 'show route', s => jRoutes(s), 'таблица маршрутизации'),
    G(['op'], R, 'show route <ip>', (s, a) => jRoutes(s, a[0]), 'маршрут до адреса'),
    G(['op'], R, 'show ospf neighbor', s => jOspfNbr(s), 'соседи OSPF'),
    G(['op'], R, 'show ospf interface', s => jOspfIf(s, false), 'интерфейсы OSPF'),
    G(['op'], R, 'show ospf interface detail', s => jOspfIf(s, true), 'интерфейсы OSPF: MTU, таймеры'),
    G(['op'], R, 'show configuration', s => s.say(jHier(jSetLines(s.dev))), 'действующая конфигурация'),
    G(['op'], R, 'show configuration | display set', s => s.say(jSetLines(s.dev).join('\n')), 'конфигурация в виде set-команд'),
    G(['op'], R, 'show log messages', s => s.say(s.dev.log.join('\n') || ''), 'журнал событий'),
    G(['op'], R, 'ping <ip>', (s, a) => jPing(s, a[0]), 'проверка доступности'),
    G(['op'], R, 'traceroute <ip>', (s, a) => jTrace(s, a[0]), 'путь до узла'),
    G(['op'], R, 'configure', s => {
      if (!s.cand) s.cand = clone(s.dev);
      s.mode = 'cfg';
      s.say('Entering configuration mode' + (jDirty(s) ? '\nThe configuration has been changed but not committed' : '') + '\n\n[edit]');
    }, 'режим настройки (кандидат)'),
    // режим конфигурации: правки идут в кандидат и применяются только по commit
    J('set interfaces <if> unit 0 family inet address <pfx>', (C, a) => {
      const f = C.ifaces[a[0]], [ip, p] = a[1].split('/');
      if (f.ip !== null && !(f.ip === ip2n(ip) && f.pfx === +p)) return `в симуляторе на интерфейсе один адрес — сначала delete interfaces ${jName(C, a[0])} unit 0 family inet address ${n2ip(f.ip)}/${f.pfx}`;
      Object.assign(f, { ip: ip2n(ip), pfx: +p });
    }, 'IP-адрес на unit 0'),
    J('delete interfaces <if> unit 0 family inet address <pfx>', (C, a) => {
      const f = C.ifaces[a[0]], [ip, p] = a[1].split('/');
      if (f.ip !== ip2n(ip) || f.pfx !== +p) return 'warning: statement not found';
      Object.assign(f, { ip: null, pfx: null });
    }, 'удалить адрес'),
    J('set interfaces <if> disable', (C, a) => { C.ifaces[a[0]].shut = true; }, 'выключить интерфейс'),
    J('delete interfaces <if> disable', (C, a) => { C.ifaces[a[0]].shut = false; }, 'включить интерфейс'),
    J('set interfaces <if> description <rest>', (C, a) => { C.ifaces[a[0]].desc = a[1].replace(/^"|"$/g, ''); }, 'описание'),
    J('set interfaces <if> unit 0 family inet mtu <num>', (C, a) => { C.ifaces[a[0]].mtu = +a[1]; }, 'IP MTU'),
    J('delete interfaces <if> unit 0 family inet mtu', (C, a) => { C.ifaces[a[0]].mtu = 1500; }, 'MTU по умолчанию'),
    J('set routing-options static route <pfx> next-hop <ip>', (C, a) => {
      const [ip, p] = a[0].split('/'), r = { net: ip2n(ip), pfx: +p, nh: ip2n(a[1]) };
      if (netOf(r.net, r.pfx) !== r.net) return 'error: invalid prefix: host bits are set';
      C.routes = C.routes.filter(x => !(x.net === r.net && x.pfx === r.pfx)); C.routes.push(r);
    }, 'статический маршрут'),
    J('delete routing-options static route <pfx>', (C, a) => {
      const [ip, p] = a[0].split('/'), b = C.routes.length;
      C.routes = C.routes.filter(x => !(x.net === ip2n(ip) && x.pfx === +p));
      if (b === C.routes.length) return 'warning: statement not found';
    }, 'удалить маршрут'),
    J('set protocols ospf area <area> interface <if>', (C, a) => {
      const o = ospfOf(C), ar = parseArea(a[0]);
      if (!o.ifs.some(e => e.ifn === a[1] && e.area === ar)) o.ifs.push({ ifn: a[1], area: ar });
    }, 'включить OSPF на интерфейсе'),
    J('delete protocols ospf area <area> interface <if>', (C, a) => {
      const o = ospfOf(C), ar = parseArea(a[0]), b = o.ifs.length;
      o.ifs = o.ifs.filter(e => !(e.ifn === a[1] && e.area === ar));
      if (b === o.ifs.length) return 'warning: statement not found';
      o.passive = o.passive.filter(x => o.ifs.some(e => e.ifn === x));
    }, 'убрать интерфейс из OSPF'),
    J('set protocols ospf area <area> interface <if> passive', (C, a) => {
      const o = ospfOf(C), ar = parseArea(a[0]);
      if (!o.ifs.some(e => e.ifn === a[1] && e.area === ar)) o.ifs.push({ ifn: a[1], area: ar });
      if (!o.passive.includes(a[1])) o.passive.push(a[1]);
    }, 'passive: без соседства'),
    J('delete protocols ospf area <area> interface <if> passive', (C, a) => { const o = ospfOf(C); o.passive = o.passive.filter(x => x !== a[1]); }),
    J('set protocols ospf area <area> interface <if> hello-interval <num>', (C, a) => {
      const o = ospfOf(C), ar = parseArea(a[0]);
      if (!o.ifs.some(e => e.ifn === a[1] && e.area === ar)) o.ifs.push({ ifn: a[1], area: ar });
      C.ifaces[a[1]].hello = +a[2];
    }, 'таймер hello'),
    J('delete protocols ospf area <area> interface <if> hello-interval', (C, a) => { C.ifaces[a[1]].hello = 10; }),
    G(['cfg'], R, 'show', s => s.say(jHier(jSetLines(s.cand || s.dev)) + '\n\n[edit]'), 'конфигурация-кандидат'),
    G(['cfg'], R, 'show | compare', s => { const d = jCompare(jSetLines(s.dev), jSetLines(s.cand || s.dev)); s.say((d || '') + '\n\n[edit]'); }, 'что изменится при commit'),
    G(['cfg'], R, 'show | display set', s => s.say(jSetLines(s.cand || s.dev).join('\n') + '\n\n[edit]'), 'кандидат в виде set'),
    G(['cfg'], R, 'commit', s => { if (!s.cand) s.cand = clone(s.dev); jCommit(s, false); }, 'применить изменения'),
    G(['cfg'], R, 'commit check', s => { if (!s.cand) s.cand = clone(s.dev); jCommit(s, true); }, 'проверить без применения'),
    G(['cfg'], R, 'commit confirmed <num>', (s, a) => {
      if (!s.cand) s.cand = clone(s.dev);
      if (jCommit(s, false)) s.say(`commit confirmed will be automatically rolled back in ${a[0]} minutes unless confirmed\n(в симуляторе отката не будет; на живом железе подтвердите повторным commit)`);
    }, 'применить с автооткатом'),
    G(['cfg'], R, 'rollback', s => { s.cand = clone(s.dev); s.say('load complete'); }, 'отменить несохранённые правки'),
    G(['cfg'], R, 'rollback 0', s => { s.cand = clone(s.dev); s.say('load complete'); }, 'отменить несохранённые правки'),
    G(['cfg'], R, 'run <rest>', (s, a) => {
      const m = s.match(a[0].split(/\s+/), 'op');
      if (m && typeof m === 'object') m.g.run(s, m.args); else s.say('unknown command.');
    }, 'выполнить operational-команду'),
    G(['cfg'], R, 'exit', s => {
      if (jDirty(s)) s.say('The configuration has been changed but not committed\nExit with uncommitted changes? [yes,no] (yes) yes');
      s.say('Exiting configuration mode'); s.mode = 'op';
    }, 'выйти из конфигурации'),
    G(['cfg'], R, 'quit', s => { s.say('Exiting configuration mode'); s.mode = 'op'; }),
    G(['op'], R, 'exit', s => s.say('(сессия продолжается — это симулятор)')),
  ];

  N.DIALECTS.junos = {
    name: 'Juniper Junos', startMode: 'op', init: jInit, keepMode: true,
    prompt: s => `user@${s.dev.name}${s.mode === 'cfg' ? '#' : '>'}`,
    grammar: JUNOS_GRAMMAR.concat(pcGrammar()), normIf: jNorm, ifShort: (dev, n) => jName(dev, n),
    errors: { invalid: 'unknown command.', incomplete: 'syntax error, expecting <statement>.', ambiguous: 'error: ambiguous command' },
    event(s, kind, D, d) { // Junos пишет события в журнал, но не в CLI-сессию
      if (kind === 'link') return { print: false, lines: [`Nov  1 07:31:02  ${D.name} mib2d[1824]: SNMP_TRAP_LINK_${d.up ? 'UP' : 'DOWN'}: ifIndex 516, ifAdminStatus ${d.admin ? 'down(2)' : 'up(1)'}, ifOperStatus ${d.up ? 'up(1)' : 'down(2)'}, ifName ${jName(D, d.ifn)}`] };
      const x = d.nbr;
      return { print: false, lines: [`Nov  1 07:31:04  ${D.name} rpd[1452]: RPD_OSPF_NBR${d.to === 'FULL' ? 'UP' : 'DOWN'}: OSPF neighbor ${n2ip(x.ip)} (realm ospf-v2 ${jName(D, x.ifn)}.0 area 0.0.0.0) state changed from ${STATE[d.from]} to ${STATE[d.to]} due to ${d.to === 'FULL' ? 'LoadDone' : 'KillNbr'}`] };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = N.DIALECTS;
})(typeof window !== 'undefined' ? window : globalThis);
