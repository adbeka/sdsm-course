/* Сетевая песочница — интерфейс: список сценариев, схема, консоли устройств, подсказки. */
(function () {
  'use strict';
  const N = window.NetSim, SC = window.SANDBOX_SCENARIOS;
  const $ = s => document.querySelector(s);
  const SVG = 'http://www.w3.org/2000/svg';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const KEY = 'sdsm_sandbox_solved';

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(tag, attrs, parent) { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }

  const CHIPS = {
    pc: ['ipconfig', 'ping ', 'tracert ', 'telnet '],
    sw: ['show vlan brief', 'show interfaces status', 'show interfaces trunk', 'show logging', 'show running-config', 'configure terminal'],
    rt: ['show ip interface brief', 'show ip route', 'show ip ospf neighbor', 'show ip ospf interface brief', 'show access-lists', 'show running-config', 'ping ', 'configure terminal'],
  };

  const S = { sc: null, net: null, sess: {}, buf: {}, cur: null, hints: 0, sol: false, solved: load(), won: false, hist: {}, hpos: 0, anim: 0 };

  /* ---------- список сценариев ---------- */
  function renderList() {
    const L = $('#list'); L.innerHTML = '';
    L.appendChild(el('p', 'list-h', 'СЦЕНАРИИ'));
    SC.forEach((sc, i) => {
      const b = el('button', 'sc' + (S.sc && S.sc.id === sc.id ? ' on' : '')); b.type = 'button';
      b.appendChild(el('span', 'sc-n', sc.diff ? String(i + 1) : '∞'));
      const body = el('span', 'sc-b');
      body.appendChild(el('span', 'sc-t', sc.title));
      const m = el('span', 'sc-m'); m.appendChild(el('span', null, sc.topic));
      if (sc.diff) m.appendChild(el('span', 'dots', '●'.repeat(sc.diff) + '○'.repeat(3 - sc.diff)));
      body.appendChild(m); b.appendChild(body);
      if (sc.goals.length) b.appendChild(el('span', 'sc-ok' + (S.solved[sc.id] ? ' done' : '')));
      b.addEventListener('click', () => select(sc.id));
      L.appendChild(b);
    });
    const total = SC.filter(s => s.goals.length).length;
    $('#progress').textContent = 'Решено ' + SC.filter(s => s.goals.length && S.solved[s.id]).length + '/' + total;
  }

  /* ---------- выбор и сброс сценария ---------- */
  function select(id, keepHash) {
    const sc = SC.find(s => s.id === id) || SC[0];
    S.sc = sc; S.net = new N.Net(sc.build()); S.sess = {}; S.buf = {}; S.hist = {}; S.hints = 0; S.sol = false; S.won = false;
    for (const d of Object.keys(S.net.dev)) {
      S.sess[d] = new N.Session(S.net, d, { changed: onChange, trace: animate });
      S.buf[d] = [{ c: 'sys', t: `${S.net.dev[d].name} — ${{ pc: 'компьютер', sw: 'коммутатор Cisco IOS', rt: 'маршрутизатор Cisco IOS' }[S.net.dev[d].type]} (симуляция). ? — список команд, Tab — дополнение, ↑↓ — история.` }];
      S.hist[d] = [];
    }
    if (!keepHash) history.replaceState(null, '', '#' + sc.id);
    $('#tTopic').textContent = sc.topic;
    $('#tDiff').textContent = sc.diff ? 'СЛОЖНОСТЬ ' + '●'.repeat(sc.diff) + '○'.repeat(3 - sc.diff) : 'СВОБОДНЫЙ РЕЖИМ';
    $('#tTitle').textContent = sc.title;
    $('#tStory').textContent = sc.story;
    gPkt().innerHTML = ''; clearNote();
    renderList(); renderHints(); renderMap(); renderGoals(true);
    const first = Object.keys(S.net.dev).find(d => S.net.dev[d].type === 'pc') || Object.keys(S.net.dev)[0];
    openDev(first, true);
  }

  /* ---------- цели ---------- */
  function goalState() {
    return S.sc.goals.map(g => {
      const r = S.net.ping(g.from, N.ip2n(g.to), g.proto ? { proto: g.proto, dport: g.port } : {});
      return g.expect === 'deny' ? !r.ok : r.ok;
    });
  }
  function renderGoals(initial) {
    const box = $('#goals'); box.innerHTML = '';
    if (!S.sc.goals.length) {
      box.appendChild(el('p', 'goals-h', 'ЗАДАНИЕ'));
      box.appendChild(el('div', 'goal', 'Целей нет — экспериментируйте. «Сбросить сценарий» вернёт всё как было.'));
      return;
    }
    box.appendChild(el('p', 'goals-h', 'ЧТО ДОЛЖНО РАБОТАТЬ'));
    const st = goalState();
    S.sc.goals.forEach((g, i) => { const d = el('div', 'goal' + (st[i] ? ' ok' : '')); d.appendChild(el('i')); d.appendChild(document.createTextNode(g.label)); box.appendChild(d); });
    if (!initial && !S.won && st.every(Boolean)) win();
  }
  function win() {
    S.won = true; S.solved[S.sc.id] = true; save(S.solved); renderList();
    $('#winTitle').textContent = S.sc.title;
    $('#winLesson').innerHTML = '<b>Что запомнить.</b> ' + S.sc.lesson;
    const idx = SC.indexOf(S.sc), next = SC.slice(idx + 1).find(s => s.goals.length && !S.solved[s.id]) || SC.slice(idx + 1)[0];
    $('#winNext').hidden = !next;
    $('#winNext').onclick = () => { $('#win').hidden = true; select(next.id); };
    setTimeout(() => { $('#win').hidden = false; $('#winNext').focus(); }, reduce ? 0 : 900);
  }

  /* ---------- подсказки ---------- */
  function renderHints() {
    const box = $('#hints'); box.innerHTML = '';
    S.sc.hints.slice(0, S.hints).forEach((h, i) => { const d = el('div', 'hint'); d.appendChild(el('b', null, 'ПОДСКАЗКА ' + (i + 1))); d.appendChild(document.createTextNode(h)); box.appendChild(d); });
    if (S.sol && S.sc.solution.length) box.appendChild(el('div', 'sol', S.sc.solution.map(s => '! ' + S.net.dev[s.dev].name + '\n' + s.cmds.join('\n')).join('\n\n')));
    const left = S.sc.hints.length - S.hints;
    $('#hintBtn').textContent = left ? `Подсказка (${S.hints + 1}/${S.sc.hints.length})` : 'Подсказки закончились';
    $('#hintBtn').disabled = !left;
    $('#solBtn').hidden = !S.sc.solution.length;
    $('#solBtn').disabled = S.sol;
  }

  /* ---------- схема ---------- */
  const gL = () => $('#gLinks'), gD = () => $('#gDevs'), gPkt = () => $('#gPkt');
  function renderMap() {
    const n = S.net; gL().innerHTML = ''; gD().innerHTML = '';
    // подгоняем viewBox под топологию, чтобы схема занимала всё окно
    const xs = Object.values(n.dev).map(d => d.x), ys = Object.values(n.dev).map(d => d.y);
    const x0 = Math.min(...xs) - 80, x1 = Math.max(...xs) + 80, y0 = Math.min(...ys) - 70, y1 = Math.max(...ys) + 100;
    $('#svg').setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${Math.max(y1 - y0, 200)}`);
    n.links.forEach(l => {
      const A = n.dev[l.a[0]], B = n.dev[l.b[0]], up = n.linkUp(l);
      svg('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, stroke: up ? '#4FD08E' : '#FF7A6B', 'stroke-width': 3, 'stroke-dasharray': up ? '' : '7 6', opacity: up ? 0.85 : 0.9 }, gL());
      [[A, B, l.a[1], n.portUp(l.a[0], l.a[1])], [B, A, l.b[1], n.portUp(l.b[0], l.b[1])]].forEach(([P, Q, name, pu]) => {
        if (name === 'eth0') return;
        const x = P.x + (Q.x - P.x) * 0.26, y = P.y + (Q.y - P.y) * 0.26 - 8;
        const t = svg('text', { x, y, 'text-anchor': 'middle', fill: pu ? '#93A2B5' : '#FF7A6B', 'font-family': 'JetBrains Mono, monospace', 'font-size': 11 }, gL());
        t.textContent = name;
      });
    });
    for (const [id, D] of Object.entries(n.dev)) {
      const g = svg('g', { class: 'dev', tabindex: 0, role: 'button', 'aria-label': 'Консоль ' + D.name }, gD());
      if (S.cur === id) svg('circle', { cx: D.x, cy: D.y, r: 38, fill: 'none', stroke: '#F2A541', 'stroke-width': 2, 'stroke-dasharray': '4 4' }, g);
      if (D.type === 'rt') {
        svg('circle', { cx: D.x, cy: D.y, r: 26, fill: '#2F6FE0', stroke: '#9CC4FF', 'stroke-width': 1.5, class: 'dev-shape' }, g);
        svg('path', { d: `M${D.x - 12} ${D.y - 5}h18l-5 -5M${D.x + 12} ${D.y + 5}h-18l5 5`, stroke: '#F7F9FC', 'stroke-width': 2.2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      } else if (D.type === 'sw') {
        svg('rect', { x: D.x - 34, y: D.y - 17, width: 68, height: 34, rx: 7, fill: '#3A4A62', stroke: '#93A2B5', 'stroke-width': 1.5, class: 'dev-shape' }, g);
        svg('path', { d: `M${D.x - 18} ${D.y - 5}h30l-5 -5M${D.x + 18} ${D.y + 5}h-30l5 5`, stroke: '#E6ECF3', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      } else {
        svg('rect', { x: D.x - 22, y: D.y - 18, width: 44, height: 29, rx: 4, fill: '#F5F7FA', stroke: '#C9D3E0', class: 'dev-shape' }, g);
        svg('rect', { x: D.x - 17, y: D.y - 13, width: 34, height: 19, rx: 2, fill: '#2F6FE0' }, g);
        svg('rect', { x: D.x - 10, y: D.y + 13, width: 20, height: 4, rx: 2, fill: '#C9D3E0' }, g);
      }
      const name = svg('text', { x: D.x, y: D.y + (D.type === 'pc' ? 36 : 44), 'text-anchor': 'middle', fill: '#E6ECF3', 'font-family': 'IBM Plex Sans, sans-serif', 'font-size': 14, 'font-weight': 600 }, g);
      name.textContent = D.name;
      if (D.type === 'pc' && D.ifaces.eth0.ip !== null) {
        const ip = svg('text', { x: D.x, y: D.y + 52, 'text-anchor': 'middle', fill: '#93A2B5', 'font-family': 'JetBrains Mono, monospace', 'font-size': 11 }, g);
        ip.textContent = N.n2ip(D.ifaces.eth0.ip) + '/' + D.ifaces.eth0.pfx;
      }
      g.addEventListener('click', () => openDev(id));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDev(id); } });
    }
  }

  /* ---------- анимация пакета ---------- */
  function clearNote() { const n = $('#map .drop-note'); if (n) n.remove(); }
  function note(text, ok) { clearNote(); const d = el('div', 'drop-note' + (ok ? ' ok-note' : ''), text); $('#map').appendChild(d); }
  function animate(r) {
    const run = ++S.anim, n = S.net;
    gPkt().innerHTML = ''; clearNote();
    const legs = [{ path: r.fwd.path, color: '#F2A541' }];
    if (r.back) legs.push({ path: r.back.path, color: '#6FA8FF' });
    const failLeg = r.fail;
    const dot = svg('circle', { r: 8, fill: '#F2A541', stroke: '#0E1622', 'stroke-width': 2 }, gPkt());
    const pts = legs.map(L => ({ color: L.color, p: L.path.filter((d, i, a) => i === 0 || a[i - 1] !== d).map(d => [n.dev[d].x, n.dev[d].y]) }));
    const finish = () => {
      if (run !== S.anim) return;
      dot.remove();
      if (failLeg) {
        const D = n.dev[failLeg.at];
        const g = svg('g', {}, gPkt());
        svg('circle', { cx: D.x, cy: D.y - 34, r: 13, fill: '#FF7A6B' }, g);
        svg('path', { d: `M${D.x - 5} ${D.y - 39}l10 10M${D.x + 5} ${D.y - 39}l-10 10`, stroke: '#0E1622', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, g);
        note(`${r.back && failLeg === r.back ? 'Ответ' : 'Запрос'} потерялся на ${D.name}`);
      } else note(r.back ? 'Пакет дошёл и вернулся ✓' : 'Запрос дошёл до цели ✓', true);
    };
    if (reduce) { finish(); return; }
    let leg = 0, seg = 0, t0 = null;
    const SPEED = 520;
    function step(ts) {
      if (run !== S.anim) return;
      const L = pts[leg];
      if (!L || L.p.length < 2) { finish(); return; }
      dot.setAttribute('fill', L.color);
      const a = L.p[seg], b = L.p[seg + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (t0 === null) t0 = ts;
      const f = Math.min(1, (ts - t0) / (len / SPEED * 1000));
      dot.setAttribute('cx', a[0] + (b[0] - a[0]) * f); dot.setAttribute('cy', a[1] + (b[1] - a[1]) * f);
      if (f >= 1) { seg++; t0 = null; if (seg >= L.p.length - 1) { leg++; seg = 0; if (leg >= pts.length) { finish(); return; } } }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---------- консоль ---------- */
  function openDev(id, quiet) {
    S.cur = id; S.hpos = S.hist[id].length;
    const tabs = $('#tabs'); tabs.innerHTML = '';
    for (const [d, D] of Object.entries(S.net.dev)) {
      const b = el('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', d === id ? 'true' : 'false');
      b.appendChild(document.createTextNode(D.name)); b.appendChild(el('span', 'k', { pc: 'PC', sw: 'SW', rt: 'R' }[D.type]));
      b.addEventListener('click', () => openDev(d)); tabs.appendChild(b);
    }
    const chips = $('#chips'); chips.innerHTML = '';
    CHIPS[S.net.dev[id].type].forEach(c => {
      const b = el('button', 'chip', c.trim() + (c.endsWith(' ') ? ' …' : '')); b.type = 'button';
      b.addEventListener('click', () => { const i = $('#cmd'); if (c.endsWith(' ')) { i.value = c; i.focus(); } else exec(c); });
      chips.appendChild(b);
    });
    renderOut(); renderMap();
    if (!quiet) $('#cmd').focus();
  }
  function renderOut() {
    const o = $('#out'); o.innerHTML = '';
    for (const line of S.buf[S.cur]) { const sp = el('span', line.c, line.t + '\n'); o.appendChild(sp); }
    o.scrollTop = o.scrollHeight;
    $('#prompt').textContent = S.sess[S.cur].prompt();
  }
  function exec(line) {
    const s = S.sess[S.cur], buf = S.buf[S.cur];
    buf.push({ c: 'cmd', t: s.prompt() + ' ' + line });
    if (line.trim()) { S.hist[S.cur].push(line); S.hpos = S.hist[S.cur].length; }
    for (const out of s.run(line)) {
      for (const part of String(out).split('\n')) buf.push({ c: /^%(LINK|LINEPROTO|OSPF|SPANTREE|PM)/.test(part) ? 'ev' : /^%/.test(part) ? 'err' : '', t: part });
    }
    if (buf.length > 600) buf.splice(0, buf.length - 600);
    renderOut();
  }
  function onChange() { renderMap(); renderGoals(false); }

  $('#cmd').addEventListener('keydown', e => {
    const i = e.target, h = S.hist[S.cur];
    if (e.key === 'Enter') { const v = i.value; i.value = ''; exec(v); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (S.hpos > 0) { S.hpos--; i.value = h[S.hpos]; } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (S.hpos < h.length - 1) { S.hpos++; i.value = h[S.hpos]; } else { S.hpos = h.length; i.value = ''; } }
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (!i.value.trim()) return;
      const r = S.sess[S.cur].complete(i.value);
      if (r.options.length > 1) { S.buf[S.cur].push({ c: 'cmd', t: S.sess[S.cur].prompt() + ' ' + i.value }, { c: 'sys', t: r.options.join('   ') }); renderOut(); }
      else i.value = r.line;
    } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); S.buf[S.cur] = []; renderOut(); }
  });
  $('#out').addEventListener('click', () => { if (!window.getSelection().toString()) $('#cmd').focus(); });
  $('#hintBtn').addEventListener('click', () => { S.hints = Math.min(S.sc.hints.length, S.hints + 1); renderHints(); });
  $('#solBtn').addEventListener('click', () => { S.sol = true; renderHints(); });
  $('#resetBtn').addEventListener('click', () => select(S.sc.id));
  $('#winStay').addEventListener('click', () => { $('#win').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#win').hidden) $('#win').hidden = true; });
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && (!S.sc || id !== S.sc.id)) select(id, true); });

  select((location.hash || '').slice(1) || SC[0].id, true);
})();
