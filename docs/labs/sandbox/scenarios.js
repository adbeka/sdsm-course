/* Сценарии сетевой песочницы. Каждый — сломанная сеть, которую нужно починить через CLI.
   goals: проверки, которые движок прогоняет после каждой команды.
   solution: эталонные команды (используются в «Показать решение» и в автотесте). */
(function (root) {
  'use strict';
  const N = root.NetSim || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const { PC, SW, RT, ip2n } = N;
  const SRVICON = { icon: 'server' };
  const M24 = '255.255.255.0', M30 = '255.255.255.252';

  const SCENARIOS = [
    {
      id: 'vlan', title: 'Соседи не видят друг друга', topic: 'VLAN', diff: 1, modules: ['vlan'],
      story: 'Два ПК бухгалтерии стоят рядом, в одной подсети 10.0.10.0/24, включены в один коммутатор — и не пингуют друг друга. Вчера SW1 «немного донастраивали».',
      goals: [{ from: 'PC1', to: '10.0.10.12', label: 'PC1 → PC2 (10.0.10.12)' }],
      build: () => ({
        devices: {
          PC1: PC('PC1', 170, 110, '10.0.10.11', M24, '10.0.10.1'),
          PC2: PC('PC2', 730, 110, '10.0.10.12', M24, '10.0.10.1'),
          SW1: SW('SW1', 450, 290, {
            'Fa0/1': { vlan: 10, desc: 'PC1-buh' }, 'Fa0/2': { vlan: 20, desc: 'PC2-buh' },
            'Fa0/3': {}, 'Fa0/4': {},
          }, { 10: 'BUH', 20: 'VOICE' }),
        },
        links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['PC2', 'eth0', 'SW1', 'Fa0/2']],
      }),
      hints: [
        'Адреса из одной подсети — значит, ПК общаются напрямую через ARP, без шлюза. ARP-запрос — широковещательный: он не выходит за пределы своего VLAN.',
        'Зайдите на SW1 и посмотрите, в каком VLAN каждый порт: show vlan brief.',
        'Fa0/2 (PC2) находится в VLAN 20, а PC1 — в VLAN 10. Переведите Fa0/2 в VLAN 10.',
      ],
      solution: [{ dev: 'SW1', cmds: ['configure terminal', 'interface fa0/2', 'switchport access vlan 10', 'end'] }],
      lesson: '<b>VLAN — это отдельный широковещательный домен.</b> Хосты в разных VLAN не видят друг друга даже на одном коммутаторе и даже с адресами из одной подсети: ARP-запрос просто не доходит. Первая команда при «не пингуется сосед» — <code>show vlan brief</code> или <code>show interfaces status</code>.',
    },
    {
      id: 'trunk', title: 'Транк пропускает не всех', topic: 'Trunk 802.1Q', diff: 1, modules: ['vlan', 'lag'],
      story: 'Офис на двух этажах: SW1 и SW2 соединены транком. Телефоны (VLAN 20) работают между этажами, а компьютеры (VLAN 10) — нет. Почините VLAN 10 и не сломайте VLAN 20.',
      goals: [
        { from: 'PC1', to: '10.0.10.12', label: 'PC1 → PC2, VLAN 10' },
        { from: 'PC3', to: '10.0.20.12', label: 'PC3 → PC4, VLAN 20 (не сломать!)' },
      ],
      build: () => ({
        devices: {
          PC1: PC('PC1', 110, 90, '10.0.10.11', M24), PC3: PC('PC3', 110, 340, '10.0.20.11', M24),
          PC2: PC('PC2', 790, 90, '10.0.10.12', M24), PC4: PC('PC4', 790, 340, '10.0.20.12', M24),
          SW1: SW('SW1', 320, 215, { 'Fa0/1': { vlan: 10 }, 'Fa0/2': { vlan: 20 }, 'Gi0/1': { mode: 'trunk', allowed: [1, 20], desc: 'to-SW2' } }, { 10: 'PC', 20: 'VOICE' }),
          SW2: SW('SW2', 580, 215, { 'Fa0/1': { vlan: 10 }, 'Fa0/2': { vlan: 20 }, 'Gi0/1': { mode: 'trunk', desc: 'to-SW1' } }, { 10: 'PC', 20: 'VOICE' }),
        },
        links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['PC3', 'eth0', 'SW1', 'Fa0/2'], ['PC2', 'eth0', 'SW2', 'Fa0/1'], ['PC4', 'eth0', 'SW2', 'Fa0/2'], ['SW1', 'Gi0/1', 'SW2', 'Gi0/1']],
      }),
      hints: [
        'VLAN 20 между этажами работает, значит, сам транк поднят. Вопрос в том, какие VLAN он пропускает.',
        'На обоих коммутаторах: show interfaces trunk — сравните «Vlans allowed on trunk».',
        'На SW1 транк разрешает только 1,20. Добавьте VLAN 10 командой с add — без add список заменится целиком и VLAN 20 пропадёт.',
      ],
      solution: [{ dev: 'SW1', cmds: ['configure terminal', 'interface gi0/1', 'switchport trunk allowed vlan add 10', 'end'] }],
      lesson: '<b>Транк пропускает только разрешённые VLAN, и VLAN должен быть разрешён с обеих сторон.</b> Самая дорогая ошибка на транке: <code>switchport trunk allowed vlan 10</code> без <code>add</code> <i>заменяет</i> список — и все остальные VLAN на этом линке падают. Добавляйте через <code>add</code>, проверяйте через <code>show interfaces trunk</code>.',
    },
    {
      id: 'errdisable', title: 'Порт выключился сам', topic: 'err-disabled', diff: 1, modules: ['stp', 'portup'],
      story: 'Вчера пользователь PC2 принёс маленький свитч, чтобы подключить ещё и ноутбук. Свитч уже убрали, PC2 снова воткнут напрямую — но сети у него нет до сих пор.',
      goals: [{ from: 'PC1', to: '10.0.10.12', label: 'PC1 → PC2 (10.0.10.12)' }],
      build: () => {
        const sw = SW('SW1', 450, 290, {
          'Fa0/1': { vlan: 10, portfast: true, bpduguard: true }, 'Fa0/2': { vlan: 10, portfast: true, bpduguard: true, err: true },
          'Fa0/3': { vlan: 10, portfast: true, bpduguard: true },
        }, { 10: 'USERS' });
        sw.log.push('%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port Fa0/2 with BPDU Guard enabled. Disabling port.',
          '%PM-4-ERR_DISABLE: bpduguard error detected on Fa0/2, putting Fa0/2 in err-disable state',
          '%LINK-3-UPDOWN: Interface FastEthernet0/2, changed state to down');
        return {
          devices: { PC1: PC('PC1', 170, 110, '10.0.10.11', M24), PC2: PC('PC2', 730, 110, '10.0.10.12', M24), SW1: sw },
          links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['PC2', 'eth0', 'SW1', 'Fa0/2']],
        };
      },
      hints: [
        'Кабель на месте, VLAN правильный — но линк на схеме красный. Посмотрите статус портов на SW1.',
        'show interfaces status покажет err-disabled на Fa0/2, а show logging — причину: BPDU Guard.',
        'Причина уже устранена (свитч убрали). err-disabled-порт сам не поднимется: на Fa0/2 выполните shutdown, затем no shutdown.',
      ],
      solution: [{ dev: 'SW1', cmds: ['configure terminal', 'interface fa0/2', 'shutdown', 'no shutdown', 'end'] }],
      lesson: '<b>err-disabled — защитное отключение порта</b> (BPDU Guard, port-security, storm-control, UDLD). Порт не поднимется сам, даже когда причины уже нет: сначала выясните причину (<code>show logging</code>, <code>show interfaces status err-disabled</code>), устраните её, затем <code>shutdown</code> / <code>no shutdown</code>. Просто <code>no shutdown</code> без <code>shutdown</code> не поможет.',
    },
    {
      id: 'stploop', title: 'Утром легло всё', topic: 'STP / петля', diff: 2, modules: ['stp'],
      story: 'Утром в офисе не работает ничего, лампочки на коммутаторах мигают синхронно. Ночью подрядчик проложил резервный кабель SW2–SW3 «для надёжности». А месяц назад кто-то выключил STP в VLAN 10, «чтобы порты быстрее поднимались». Резервный кабель должен остаться.',
      goals: [
        { from: 'PC1', to: '10.0.10.12', label: 'PC1 → PC2 (10.0.10.12)' },
        { label: 'Корень STP в VLAN 10 — SW1 (ядро)', check: n => ['SW1', 'SW2', 'SW3'].every(sw => n.stpOn(sw, 10) && n.stp(10).rootFor[sw] === 'SW1') },
        { label: 'Резервный линк SW2–SW3 подключён', check: n => n.linkUp(n.links.find(l => l.a[0] === 'SW2' && l.b[0] === 'SW3')) },
      ],
      build: () => {
        const tr = desc => ({ mode: 'trunk', desc });
        const sw1 = SW('SW1', 450, 90, { 'Gi0/1': tr('to-SW2'), 'Gi0/2': tr('to-SW3') }, { 10: 'USERS' }, { stpOff: [10], prio: { 10: 4096 } });
        const sw2 = SW('SW2', 250, 270, { 'Fa0/1': { vlan: 10 }, 'Gi0/1': tr('to-SW1'), 'Gi0/2': tr('to-SW3 backup') }, { 10: 'USERS' }, { stpOff: [10] });
        const sw3 = SW('SW3', 650, 270, { 'Fa0/1': { vlan: 10 }, 'Gi0/1': tr('to-SW1'), 'Gi0/2': tr('to-SW2 backup') }, { 10: 'USERS' }, { stpOff: [10] });
        const flap = (a, b) => `%SW_MATM-4-MACFLAP_NOTIF: Host 0050.7966.6801 in vlan 10 is flapping between port ${a} and port ${b}`;
        sw1.log.push(flap('Gi0/1', 'Gi0/2'), flap('Gi0/2', 'Gi0/1'));
        sw2.log.push(flap('Gi0/1', 'Gi0/2'), flap('Gi0/2', 'Gi0/1'), flap('Gi0/1', 'Gi0/2'));
        sw3.log.push(flap('Gi0/2', 'Gi0/1'), flap('Gi0/1', 'Gi0/2'));
        return {
          devices: { SW1: sw1, SW2: sw2, SW3: sw3, PC1: PC('PC1', 90, 360, '10.0.10.11', M24), PC2: PC('PC2', 810, 360, '10.0.10.12', M24) },
          links: [['SW1', 'Gi0/1', 'SW2', 'Gi0/1'], ['SW1', 'Gi0/2', 'SW3', 'Gi0/1'], ['SW2', 'Gi0/2', 'SW3', 'Gi0/2'], ['PC1', 'eth0', 'SW2', 'Fa0/1'], ['PC2', 'eth0', 'SW3', 'Fa0/1']],
        };
      },
      hints: [
        'Легло всё и сразу, у всех. Зайдите на любой коммутатор: show processes cpu и show logging.',
        'CPU 99% и MAC flapping — признаки широковещательного шторма: SW1–SW2–SW3 образуют кольцо, и кадры бегают по нему бесконечно. Кто должен разрывать кольцо? show spanning-tree vlan 10.',
        'Включите STP в VLAN 10 на всех трёх коммутаторах: configure terminal → spanning-tree vlan 10. Корнем станет SW1 (priority 4096), а один порт на линке SW2–SW3 перейдёт в BLK.',
      ],
      solution: ['SW1', 'SW2', 'SW3'].map(dev => ({ dev, cmds: ['configure terminal', 'spanning-tree vlan 10', 'end'] })),
      lesson: '<b>L2-петля без STP — это широковещательный шторм.</b> У Ethernet-кадра нет TTL: broadcast кружит по кольцу бесконечно и размножается на каждом коммутаторе. CPU 100%, MAC flapping в логах, лежит весь сегмент. STP выбирает корень и переводит лишний порт в BLK, а резервный линк остаётся на случай аварии. Не выключайте STP «для скорости»: для пользовательских портов есть <code>portfast</code> + <code>bpduguard</code>. Корень назначайте явно (<code>spanning-tree vlan N priority</code>) — на ядре.',
    },
    {
      id: 'dhcpgw', title: 'Адрес есть, интернета нет', topic: 'DHCP', diff: 1, modules: ['dhcpdns'],
      story: 'Сеть пользователей перенесли на новый роутер R1, раздачу адресов настроили на нём же. Компьютеры получают адреса, но до сервера 10.0.2.10 не достучаться. Статикой на ПК лечить нельзя: завтра их будет 200.',
      goals: [
        { from: 'PC1', to: '10.0.2.10', label: 'PC1 → сервер 10.0.2.10' },
        { from: 'PC2', to: '10.0.2.10', label: 'PC2 → сервер 10.0.2.10' },
        { label: 'Оба ПК настроены по DHCP (без статики)', check: n => n.dev.PC1.dhcp && n.dev.PC2.dhcp },
      ],
      build: () => {
        const r1 = RT('R1', 470, 220, { 'Gi0/0': { ip: '10.0.10.1', mask: M24, desc: 'USERS' }, 'Gi0/1': { ip: '10.0.2.1', mask: M24, desc: 'SERVERS' } },
          { dhcp: { excluded: [['10.0.10.1', '10.0.10.10']], pools: { USERS: { net: '10.0.10.0', mask: M24, gw: '10.0.10.254', dns: '10.0.2.10' } } } });
        r1.dhcp.bindings = { PC2: ip2n('10.0.10.11'), PC1: ip2n('10.0.10.12') };
        return {
          devices: {
            PC1: PC('PC1', 90, 110, '10.0.10.12', M24, '10.0.10.254', { dhcp: true }),
            PC2: PC('PC2', 90, 330, '10.0.10.11', M24, '10.0.10.254', { dhcp: true }),
            SW1: SW('SW1', 260, 220, { 'Fa0/1': {}, 'Fa0/2': {}, 'Gi0/1': { desc: 'to-R1' } }),
            R1: r1,
            SRV: PC('SRV', 760, 220, '10.0.2.10', M24, '10.0.2.1', SRVICON),
          },
          links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['PC2', 'eth0', 'SW1', 'Fa0/2'], ['SW1', 'Gi0/1', 'R1', 'Gi0/0'], ['SRV', 'eth0', 'R1', 'Gi0/1']],
        };
      },
      hints: [
        'Адрес получен — значит, DHCP работает. Посмотрите, какие ещё параметры пришли на PC1: ipconfig.',
        'Шлюз 10.0.10.254, а у R1 в этой сети адрес 10.0.10.1. Откуда клиент взял шлюз? На R1: show ip dhcp pool.',
        'На R1: ip dhcp pool USERS → default-router 10.0.10.1. Затем на каждом ПК ipconfig /renew: клиент узнает о новых настройках только при продлении аренды.',
      ],
      solution: [
        { dev: 'R1', cmds: ['configure terminal', 'ip dhcp pool USERS', 'default-router 10.0.10.1', 'end'] },
        { dev: 'PC1', cmds: ['ipconfig /renew'] }, { dev: 'PC2', cmds: ['ipconfig /renew'] },
      ],
      lesson: '<b>DHCP выдаёт не только адрес</b>, но и маску, шлюз (option 3), DNS (option 6) и другие параметры. Ошибка в пуле тиражируется на всех клиентов сразу. После правки пула клиенты получат новые параметры только при продлении аренды: <code>ipconfig /renew</code> или автоматически по истечении половины срока. Адреса шлюза и серверов исключайте из пула: <code>ip dhcp excluded-address</code>.',
    },
    {
      id: 'dhcprelay', title: 'Новый отдел получает 169.254', topic: 'DHCP relay', diff: 2, modules: ['dhcpdns'],
      story: 'Для нового отдела сделали подсеть 10.0.20.0/24 на R1. Пул для неё на центральном DHCP-сервере 10.0.1.5 уже создан, но компьютеры отдела получают адрес 169.254.x.x и никуда не ходят.',
      goals: [
        { label: 'PC1 получил по DHCP адрес из 10.0.20.0/24', check: n => { const e = n.dev.PC1.ifaces.eth0; return n.dev.PC1.dhcp && e.ip !== null && (e.ip >>> 8) === (ip2n('10.0.20.0') >>> 8); } },
        { from: 'PC1', to: '10.0.1.5', label: 'PC1 → DHCP-сервер 10.0.1.5' },
      ],
      build: () => ({
        devices: {
          PC1: PC('PC1', 90, 220, '169.254.87.12', '255.255.0.0', null, { dhcp: true }),
          SW1: SW('SW1', 260, 220, { 'Fa0/1': {}, 'Gi0/1': { desc: 'to-R1' } }),
          R1: RT('R1', 470, 220, { 'Gi0/0': { ip: '10.0.20.1', mask: M24, desc: 'DEPT-NEW' }, 'Gi0/1': { ip: '10.0.1.1', mask: M24, desc: 'SERVERS' } }),
          DHCP: RT('DHCP', 740, 220, { 'Gi0/0': { ip: '10.0.1.5', mask: M24 } }, {
            icon: 'server', routes: [['0.0.0.0', '0.0.0.0', '10.0.1.1']],
            dhcp: { excluded: [['10.0.20.1', '10.0.20.10']], pools: { DEPT20: { net: '10.0.20.0', mask: M24, gw: '10.0.20.1', dns: '10.0.1.5' } } },
          }),
        },
        links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['SW1', 'Gi0/1', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'DHCP', 'Gi0/0']],
      }),
      hints: [
        '169.254.x.x (APIPA) — ПК не дождался ответа от DHCP. А DHCP Discover — широковещательный: он не выходит за пределы своей подсети.',
        'Сервер в другой подсети, значит, роутер должен переслать запрос (DHCP relay). Посмотрите интерфейс R1, смотрящий в сеть ПК: show running-config.',
        'На R1: interface gi0/0 → ip helper-address 10.0.1.5. Затем на PC1: ipconfig /renew.',
      ],
      solution: [
        { dev: 'R1', cmds: ['configure terminal', 'interface gi0/0', 'ip helper-address 10.0.1.5', 'end'] },
        { dev: 'PC1', cmds: ['ipconfig /renew'] },
      ],
      lesson: '<b>DHCP Discover — broadcast, а роутер broadcast не пропускает.</b> Если сервер в другой подсети, на интерфейсе-шлюзе клиентов нужен relay: <code>ip helper-address</code>. Роутер пересылает запрос unicast\'ом и вписывает свой адрес (giaddr) — по нему сервер выбирает пул. Поэтому пул должен совпадать с подсетью клиентов, а у сервера должен быть маршрут обратно. Адрес 169.254.x.x на клиенте означает «DHCP не ответил».',
    },
    {
      id: 'gateway', title: 'В свою сеть — да, дальше — нет', topic: 'Шлюз', diff: 1, modules: ['staticroute', 'planning'],
      story: 'PC1 после переустановки системы видит всё в своей подсети, но не может достучаться до сервера в соседней сети 10.0.2.0/24. У всех остальных всё работает.',
      goals: [{ from: 'PC1', to: '10.0.2.10', label: 'PC1 → сервер 10.0.2.10' }],
      build: () => ({
        devices: {
          PC1: PC('PC1', 140, 210, '10.0.1.10', M24, '10.0.1.254'),
          R1: RT('R1', 450, 210, { 'Gi0/0': { ip: '10.0.1.1', mask: M24, desc: 'LAN1' }, 'Gi0/1': { ip: '10.0.2.1', mask: M24, desc: 'LAN2' } }),
          SRV: PC('SRV', 760, 210, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['PC1', 'eth0', 'R1', 'Gi0/0'], ['SRV', 'eth0', 'R1', 'Gi0/1']],
      }),
      hints: [
        'Чтобы отправить пакет в чужую подсеть, хост сначала ищет через ARP MAC-адрес своего шлюза. Проверьте, какой шлюз у PC1: ipconfig.',
        'Сравните шлюз PC1 с адресом R1 в этой сети: на R1 — show ip interface brief.',
        'На PC1 шлюз 10.0.1.254, а R1 — 10.0.1.1. Задайте: ipconfig 10.0.1.10 255.255.255.0 10.0.1.1',
      ],
      solution: [{ dev: 'PC1', cmds: ['ipconfig 10.0.1.10 255.255.255.0 10.0.1.1'] }],
      lesson: '<b>В чужую подсеть хост отправляет через шлюз</b>, и первым делом спрашивает по ARP его MAC. Неверный шлюз даёт характерную картину: внутри своей подсети всё работает, дальше — ничего. Поэтому первый шаг при «нет интернета» — <code>ping</code> своего шлюза.',
    },
    {
      id: 'returnpath', title: 'Туда дошло, обратно — нет', topic: 'Статическая маршрутизация', diff: 2, modules: ['staticroute', 'troubleshooting'],
      story: 'Новый филиал подключили через R2. На R1 добавили маршрут в сеть филиала 10.0.2.0/24, но ping из офиса до PC2 не проходит. Инженер клянётся, что маршрут есть.',
      goals: [{ from: 'PC1', to: '10.0.2.10', label: 'PC1 → PC2 (10.0.2.10)' }],
      build: () => ({
        devices: {
          PC1: PC('PC1', 80, 210, '10.0.1.10', M24, '10.0.1.1'),
          R1: RT('R1', 320, 210, { 'Gi0/0': { ip: '10.0.1.1', mask: M24 }, 'Gi0/1': { ip: '10.0.12.1', mask: M30, desc: 'to-R2' } }, { routes: [['10.0.2.0', M24, '10.0.12.2']] }),
          R2: RT('R2', 580, 210, { 'Gi0/1': { ip: '10.0.12.2', mask: M30, desc: 'to-R1' }, 'Gi0/0': { ip: '10.0.2.1', mask: M24 } }),
          PC2: PC('PC2', 820, 210, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['PC1', 'eth0', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'R2', 'Gi0/1'], ['PC2', 'eth0', 'R2', 'Gi0/0']],
      }),
      hints: [
        'Ping — это два пакета: Echo Request туда и Echo Reply обратно. Маршрут нужен в обе стороны. Посмотрите на анимацию: где теряется пакет?',
        'Сделайте tracert с PC1 и посмотрите show ip route на R2: знает ли R2, где сеть 10.0.1.0/24?',
        'На R2 нет маршрута в 10.0.1.0/24. Добавьте: ip route 10.0.1.0 255.255.255.0 10.0.12.1',
      ],
      solution: [{ dev: 'R2', cmds: ['configure terminal', 'ip route 10.0.1.0 255.255.255.0 10.0.12.1', 'end'] }],
      lesson: '<b>Маршрут нужен туда и обратно.</b> Запрос дошёл до PC2, но R2 не знает, куда вернуть ответ. Это одна из самых частых «загадочных» проблем: при проверке всегда смотрите таблицу маршрутизации на <i>каждом</i> устройстве по пути — в обе стороны. Звёздочки в <code>traceroute</code> часто означают не «узел недоступен», а «узлу некуда отправить ответ».',
    },
    {
      id: 'mask', title: 'Одна цифра в маске', topic: 'Адресация', diff: 2, modules: ['planning', 'staticroute'],
      story: 'После замены роутера сервер 10.0.2.10 пропал для всех. Кабель, порт и VLAN проверили — линк поднят, адрес шлюза на сервере правильный. Конфиг на новый роутер переносили вручную.',
      goals: [{ from: 'PC1', to: '10.0.2.10', label: 'PC1 → сервер 10.0.2.10' }],
      build: () => ({
        devices: {
          PC1: PC('PC1', 140, 210, '10.0.1.10', M24, '10.0.1.1'),
          R1: RT('R1', 450, 210, { 'Gi0/0': { ip: '10.0.1.1', mask: M24 }, 'Gi0/1': { ip: '10.0.2.1', mask: M30, desc: 'SERVERS /24' } }),
          SRV: PC('SRV', 760, 210, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['PC1', 'eth0', 'R1', 'Gi0/0'], ['SRV', 'eth0', 'R1', 'Gi0/1']],
      }),
      hints: [
        'Линк зелёный, адрес шлюза совпадает с адресом R1 — значит, L1 и L2 в порядке. Смотрите, что R1 думает о сети серверов.',
        'show ip route на R1: какая сеть подключена к Gi0/1? Попадает ли 10.0.2.10 в неё?',
        'На Gi0/1 маска /30 (10.0.2.0–10.0.2.3), а сервер — 10.0.2.10. Исправьте: interface gi0/1 → ip address 10.0.2.1 255.255.255.0',
      ],
      solution: [{ dev: 'R1', cmds: ['configure terminal', 'interface gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'end'] }],
      lesson: '<b>Маска определяет connected-маршрут.</b> С маской /30 роутер считает своей только сеть 10.0.2.0–10.0.2.3, и для 10.0.2.10 у него просто нет маршрута — хотя кабель, VLAN и адрес шлюза верные. Сверяйте маску на роутере с планом адресации и с маской на хостах: <code>show ip route</code> показывает правду.',
    },
    {
      id: 'ospfarea', title: 'OSPF: соседи молчат', topic: 'OSPF', diff: 2, modules: ['ospf'],
      story: 'Статику между офисом и филиалом решили заменить на OSPF. Настроили оба роутера, но соседство не поднимается, а маршрутов в сети друг друга нет.',
      goals: [{ from: 'PC1', to: '10.0.2.10', label: 'PC1 → PC2 (10.0.2.10)' }],
      build: () => ({
        devices: {
          PC1: PC('PC1', 80, 210, '10.0.1.10', M24, '10.0.1.1'),
          R1: RT('R1', 320, 210, { 'Gi0/0': { ip: '10.0.1.1', mask: M24 }, 'Gi0/1': { ip: '10.0.12.1', mask: M30 } },
            { rid: '1.1.1.1', ospf: { networks: [['10.0.1.0', '0.0.0.255', 0], ['10.0.12.0', '0.0.0.3', 0]], passive: ['Gi0/0'] } }),
          R2: RT('R2', 580, 210, { 'Gi0/1': { ip: '10.0.12.2', mask: M30 }, 'Gi0/0': { ip: '10.0.2.1', mask: M24 } },
            { rid: '2.2.2.2', ospf: { networks: [['10.0.2.0', '0.0.0.255', 0], ['10.0.12.0', '0.0.0.3', 1]], passive: ['Gi0/0'] } }),
          PC2: PC('PC2', 820, 210, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['PC1', 'eth0', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'R2', 'Gi0/1'], ['PC2', 'eth0', 'R2', 'Gi0/0']],
      }),
      hints: [
        'Чтобы стать соседями OSPF, у интерфейсов должны совпадать: подсеть и маска, area, hello/dead, тип сети, аутентификация. Проверьте соседей: show ip ospf neighbor.',
        'Сравните интерфейсы на R1 и R2: show ip ospf interface brief — колонка Area.',
        'На R2 линк 10.0.12.0/30 в area 1, на R1 — в area 0. На R2: router ospf 1 → no network 10.0.12.0 0.0.0.3 area 1 → network 10.0.12.0 0.0.0.3 area 0',
      ],
      solution: [{ dev: 'R2', cmds: ['configure terminal', 'router ospf 1', 'no network 10.0.12.0 0.0.0.3 area 1', 'network 10.0.12.0 0.0.0.3 area 0', 'end'] }],
      lesson: '<b>OSPF-соседство требует совпадения параметров с обеих сторон:</b> подсеть и маска, area, hello/dead-таймеры, тип сети, аутентификация, флаги area (stub/NSSA). Если хоть что-то не совпало — соседа просто нет, без громких ошибок. <code>show ip ospf interface</code> на обеих сторонах — быстрый способ сравнить всё сразу.',
    },
    {
      id: 'ospfmtu', title: 'OSPF застрял на полпути', topic: 'OSPF / MTU', diff: 3, modules: ['ospf', 'mplsbase'],
      story: 'На линке R1–R2 хотели включить jumbo-кадры и поменяли MTU только на одной стороне. Соседи OSPF вроде бы видят друг друга, но маршрутов нет.',
      goals: [{ from: 'PC1', to: '10.0.2.10', label: 'PC1 → PC2 (10.0.2.10)' }],
      build: () => ({
        devices: {
          PC1: PC('PC1', 80, 210, '10.0.1.10', M24, '10.0.1.1'),
          R1: RT('R1', 320, 210, { 'Gi0/0': { ip: '10.0.1.1', mask: M24 }, 'Gi0/1': { ip: '10.0.12.1', mask: M30 } },
            { rid: '1.1.1.1', ospf: { networks: [['10.0.0.0', '0.0.255.255', 0]], passive: ['Gi0/0'] } }),
          R2: RT('R2', 580, 210, { 'Gi0/1': { ip: '10.0.12.2', mask: M30, mtu: 1400 }, 'Gi0/0': { ip: '10.0.2.1', mask: M24 } },
            { rid: '2.2.2.2', ospf: { networks: [['10.0.0.0', '0.0.255.255', 0]], passive: ['Gi0/0'] } }),
          PC2: PC('PC2', 820, 210, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['PC1', 'eth0', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'R2', 'Gi0/1'], ['PC2', 'eth0', 'R2', 'Gi0/0']],
      }),
      hints: [
        'Соседи есть, но в каком состоянии? show ip ospf neighbor — рабочее состояние только FULL.',
        'EXSTART/EXCHANGE — соседи не могут обменяться описанием базы (DBD). В DBD передаётся MTU интерфейса: сравните show interfaces gi0/1 на обоих роутерах.',
        'На R2 Gi0/1 MTU 1400, на R1 — 1500. Выровняйте: на R2 interface gi0/1 → no ip mtu (или ip mtu 1500).',
      ],
      solution: [{ dev: 'R2', cmds: ['configure terminal', 'interface gi0/1', 'no ip mtu', 'end'] }],
      lesson: '<b>Соседи OSPF, застрявшие в EXSTART/EXCHANGE, — почти всегда несовпадение MTU.</b> Hello проходят (они маленькие), а DBD с MTU интерфейса отвергается. Лечится выравниванием MTU с обеих сторон. <code>ip ospf mtu-ignore</code> поднимет соседство, но спрячет реальную проблему: большие пакеты всё равно будут теряться.',
    },
    {
      id: 'acl', title: 'Безопасник перестарался', topic: 'ACL', diff: 3, modules: ['aaa8021x', 'troubleshooting'],
      story: 'Задача была: запретить из сети LAN2 (10.0.2.0/24) telnet на сервер 10.0.1.10. После правки ACL на R1 сервер перестал отвечать вообще. Верните ping, но telnet из LAN2 должен остаться запрещён — ACL просто снять нельзя.',
      goals: [
        { from: 'SRV', to: '10.0.2.10', label: 'SRV → PC2 (ping)' },
        { from: 'PC2', to: '10.0.1.10', label: 'PC2 → SRV (ping)' },
        { from: 'PC2', to: '10.0.1.10', proto: 'tcp', port: 23, expect: 'deny', label: 'telnet PC2 → SRV запрещён' },
      ],
      build: () => ({
        devices: {
          SRV: PC('SRV', 140, 210, '10.0.1.10', M24, '10.0.1.1'),
          R1: RT('R1', 450, 210, { 'Gi0/0': { ip: '10.0.1.1', mask: M24, desc: 'SERVERS' }, 'Gi0/1': { ip: '10.0.2.1', mask: M24, desc: 'LAN2', aclIn: 'FROM-LAN2' } },
            { acls: { 'FROM-LAN2': ['deny ip 10.0.2.0 0.0.0.255 any', 'permit ip any any'] } }),
          PC2: PC('PC2', 760, 210, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['SRV', 'eth0', 'R1', 'Gi0/0'], ['PC2', 'eth0', 'R1', 'Gi0/1']],
      }),
      hints: [
        'ACL читается сверху вниз до первого совпадения, в конце — неявный deny. Посмотрите, что сейчас в списке: show access-lists.',
        'Строка 10 запрещает из LAN2 весь IP, а не только telnet. Строки можно удалять и вставлять по номеру в режиме ip access-list extended FROM-LAN2.',
        'ip access-list extended FROM-LAN2 → no 10 → 10 deny tcp 10.0.2.0 0.0.0.255 host 10.0.1.10 eq telnet',
      ],
      solution: [{ dev: 'R1', cmds: ['configure terminal', 'ip access-list extended FROM-LAN2', 'no 10', '10 deny tcp 10.0.2.0 0.0.0.255 host 10.0.1.10 eq telnet', 'end'] }],
      lesson: '<b>ACL — первое совпадение побеждает, в конце неявный deny any.</b> Пишите правила максимально узко (протокол, хост, порт) и вставляйте строки по номерам последовательности, а не пересоздавайте весь список. И помните про обратный трафик: ACL на входе LAN2 режет и <i>ответы</i> сервера, если они идут из этой сети.',
    },
    {
      id: 'natpat', title: 'Офис не выходит в интернет', topic: 'NAT / PAT', diff: 2, modules: ['nat'],
      story: 'Офис подключили к провайдеру: внутри сеть 10.0.1.0/24, снаружи один адрес 203.0.113.2. NAT «настроили по инструкции», но сайт 198.51.100.10 не открывается ни у кого.',
      goals: [
        { from: 'PC1', to: '198.51.100.10', label: 'PC1 → сайт 198.51.100.10' },
        { from: 'PC2', to: '198.51.100.10', label: 'PC2 → сайт 198.51.100.10' },
      ],
      build: () => ({
        devices: {
          PC1: PC('PC1', 80, 120, '10.0.1.10', M24, '10.0.1.1'),
          PC2: PC('PC2', 80, 320, '10.0.1.11', M24, '10.0.1.1'),
          SW1: SW('SW1', 240, 220, { 'Fa0/1': {}, 'Fa0/2': {}, 'Gi0/1': { desc: 'to-R1' } }),
          R1: RT('R1', 430, 220, { 'Gi0/0': { ip: '10.0.1.1', mask: M24, desc: 'LAN' }, 'Gi0/1': { ip: '203.0.113.2', mask: M30, desc: 'ISP', nat: 'outside' } },
            { routes: [['0.0.0.0', '0.0.0.0', '203.0.113.1']], stdAcls: { 1: ['permit 10.0.1.0 0.0.0.255'] }, nat: { dyn: [['1', 'Gi0/1']] } }),
          ISP: RT('ISP', 630, 220, { 'Gi0/1': { ip: '203.0.113.1', mask: M30, desc: 'client-office' }, 'Gi0/0': { ip: '198.51.100.1', mask: M24, desc: 'internet' } }),
          WEB: PC('WEB', 820, 220, '198.51.100.10', M24, '198.51.100.1', SRVICON),
        },
        links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['PC2', 'eth0', 'SW1', 'Fa0/2'], ['SW1', 'Gi0/1', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'ISP', 'Gi0/1'], ['WEB', 'eth0', 'ISP', 'Gi0/0']],
      }),
      hints: [
        'Внутри частные адреса (10.0.0.0/8), а в интернете маршрутов в частные сети нет: ответу просто некуда вернуться. Сделайте ping с PC1 и посмотрите, где теряется ответ; затем show ip route на ISP.',
        'Значит, на R1 адрес отправителя должен подменяться. show ip nat translations после ping пустая? Посмотрите show ip nat statistics: какие интерфейсы inside, а какие outside.',
        'Gi0/0 (в сторону LAN) не помечен как inside. На R1: interface gi0/0 → ip nat inside.',
      ],
      solution: [{ dev: 'R1', cmds: ['configure terminal', 'interface gi0/0', 'ip nat inside', 'end'] }],
      lesson: '<b>NAT срабатывает только на переходе inside → outside.</b> Нужны три части: роли интерфейсов (<code>ip nat inside</code> / <code>outside</code>), ACL «кого транслировать» и само правило <code>ip nat inside source list … overload</code>. Забыли любую — пакеты уходят к провайдеру с частным адресом, и ответ теряется у него. Проверка: ping, затем <code>show ip nat translations</code> и <code>show ip nat statistics</code>.',
    },
    {
      id: 'natstatic', title: 'Сайт компании не виден снаружи', topic: 'Static NAT', diff: 3, modules: ['nat'],
      story: 'Сервер компании SRV (10.0.1.20) должен быть доступен из интернета по адресу 203.0.113.5 — провайдер маршрутизирует его к нам. Сотрудники в интернет ходят, а клиенты сайт не видят. PAT для сотрудников не сломайте.',
      goals: [
        { from: 'CLIENT', to: '203.0.113.5', label: 'Клиент из интернета → 203.0.113.5 (сайт)' },
        { from: 'PC1', to: '198.51.100.10', label: 'PC1 → интернет (PAT не сломать)' },
      ],
      build: () => ({
        devices: {
          PC1: PC('PC1', 80, 120, '10.0.1.10', M24, '10.0.1.1'),
          SRV: PC('SRV', 80, 320, '10.0.1.20', M24, '10.0.1.1', SRVICON),
          SW1: SW('SW1', 240, 220, { 'Fa0/1': {}, 'Fa0/2': {}, 'Gi0/1': { desc: 'to-R1' } }),
          R1: RT('R1', 430, 220, { 'Gi0/0': { ip: '10.0.1.1', mask: M24, desc: 'LAN', nat: 'inside' }, 'Gi0/1': { ip: '203.0.113.2', mask: M30, desc: 'ISP', nat: 'outside' } },
            { routes: [['0.0.0.0', '0.0.0.0', '203.0.113.1']], stdAcls: { 1: ['permit 10.0.1.0 0.0.0.255'] }, nat: { dyn: [['1', 'Gi0/1']], stat: [['10.0.1.21', '203.0.113.5']] } }),
          ISP: RT('ISP', 630, 220, { 'Gi0/1': { ip: '203.0.113.1', mask: M30, desc: 'client-office' }, 'Gi0/0': { ip: '198.51.100.1', mask: M24, desc: 'internet' } },
            { routes: [['203.0.113.4', M30, '203.0.113.2']] }),
          CLIENT: PC('CLIENT', 820, 220, '198.51.100.10', M24, '198.51.100.1'),
        },
        links: [['PC1', 'eth0', 'SW1', 'Fa0/1'], ['SRV', 'eth0', 'SW1', 'Fa0/2'], ['SW1', 'Gi0/1', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'ISP', 'Gi0/1'], ['CLIENT', 'eth0', 'ISP', 'Gi0/0']],
      }),
      hints: [
        'Запрос клиента приходит на R1 на адрес 203.0.113.5, и R1 должен подменить адрес назначения на внутренний. Сделайте ping с CLIENT: где теряется пакет?',
        'На R1: show ip nat translations — на какой внутренний адрес смотрит 203.0.113.5? Сравните с адресом SRV (ipconfig на SRV).',
        'Статика указывает на 10.0.1.21, а сервер — 10.0.1.20. На R1: no ip nat inside source static 10.0.1.21 203.0.113.5, затем ip nat inside source static 10.0.1.20 203.0.113.5.',
      ],
      solution: [{ dev: 'R1', cmds: ['configure terminal', 'no ip nat inside source static 10.0.1.21 203.0.113.5', 'ip nat inside source static 10.0.1.20 203.0.113.5', 'end'] }],
      lesson: '<b>Статический NAT — постоянная пара «внутренний ↔ внешний адрес»</b>: по ней сервер доступен снаружи. Входящий пакет транслируется <i>до</i> маршрутизации, поэтому опечатка в одной цифре выглядит как «ARP без ответа» уже внутри LAN. Статика имеет приоритет над PAT. Внешний адрес должен маршрутизироваться к вам у провайдера, иначе запрос до вас просто не дойдёт.',
    },
    {
      id: 'free', title: 'Свободный стенд: сломай и почини', topic: 'OSPF · эксперименты', diff: 0, modules: ['ospf', 'troubleshooting'],
      story: 'Здесь всё работает: три роутера в OSPF-треугольнике и два ПК. Экспериментируйте. Например: выключите линк R1–R2 (на R1: interface gi0/1 → shutdown) и посмотрите, как OSPF перестроит маршрут через R3 — show ip route, tracert с PC1. Потом поменяйте MTU или area и наблюдайте, как падает соседство.',
      goals: [],
      build: () => ({
        devices: {
          PC1: PC('PC1', 80, 120, '10.0.1.10', M24, '10.0.1.1'),
          R1: RT('R1', 300, 120, { 'Gi0/0': { ip: '10.0.1.1', mask: M24 }, 'Gi0/1': { ip: '10.0.12.1', mask: M30 }, 'Gi0/2': { ip: '10.0.13.1', mask: M30 } },
            { rid: '1.1.1.1', ospf: { networks: [['10.0.0.0', '0.0.255.255', 0]], passive: ['Gi0/0'] } }),
          R2: RT('R2', 600, 120, { 'Gi0/0': { ip: '10.0.2.1', mask: M24 }, 'Gi0/1': { ip: '10.0.12.2', mask: M30 }, 'Gi0/2': { ip: '10.0.23.2', mask: M30 } },
            { rid: '2.2.2.2', ospf: { networks: [['10.0.0.0', '0.0.255.255', 0]], passive: ['Gi0/0'] } }),
          R3: RT('R3', 450, 330, { 'Gi0/1': { ip: '10.0.13.3', mask: M30 }, 'Gi0/2': { ip: '10.0.23.3', mask: M30 } },
            { rid: '3.3.3.3', ospf: { networks: [['10.0.0.0', '0.0.255.255', 0]] } }),
          PC2: PC('PC2', 820, 120, '10.0.2.10', M24, '10.0.2.1'),
        },
        links: [['PC1', 'eth0', 'R1', 'Gi0/0'], ['R1', 'Gi0/1', 'R2', 'Gi0/1'], ['R1', 'Gi0/2', 'R3', 'Gi0/1'], ['R2', 'Gi0/2', 'R3', 'Gi0/2'], ['PC2', 'eth0', 'R2', 'Gi0/0']],
      }),
      hints: [
        'Начните с show ip route и show ip ospf neighbor на R1 — запомните, как выглядит «здоровое» состояние.',
        'Выключите R1 Gi0/1 и снова посмотрите show ip route: маршрут в 10.0.2.0/24 пойдёт через R3 с метрикой больше.',
        'Попробуйте на R3 ip ospf hello-interval 5 на одном интерфейсе — сосед пропадёт. Верните: no ip ospf hello-interval.',
      ],
      solution: [],
      lesson: '',
    },
  ];


  /* ---------- диалекты: Huawei VRP и Juniper Junos ----------
     Для каждого сценария — подсказки и решение в синтаксисе вендора; lesson/note дополняют общий вывод.
     Сценарии без записи для диалекта доступны только на Cisco IOS. */
  const JNOTE = 'В Junos правки попадают в <i>кандидат</i> и вступают в силу только после <code>commit</code>. <code>show | compare</code> показывает, что изменится, а <code>commit confirmed 5</code> страхует от потери доступа.';
  const DX = {
    vlan: { vrp: {
      hints: ['Адреса из одной подсети — ПК общаются напрямую через ARP, а ARP не выходит за пределы VLAN.',
        'На SW1: display port vlan (колонка PVID) или display vlan — в каком VLAN каждый порт.',
        'GE0/0/2 в VLAN 20. system-view → interface GigabitEthernet0/0/2 → port default vlan 10.'],
      solution: [{ dev: 'SW1', cmds: ['system-view', 'interface GigabitEthernet0/0/2', 'port default vlan 10', 'return'] }],
      note: 'В VRP VLAN порта доступа задаётся как <code>port default vlan</code> (PVID), а проверяется через <code>display port vlan</code>.' } },
    trunk: { vrp: {
      hints: ['VLAN 20 между этажами работает — транк поднят. Вопрос в том, какие VLAN он пропускает.',
        'На обоих коммутаторах: display port vlan — колонка Trunk VLAN List (или display vlan: TG — tagged).',
        'На SW1 транк XGE0/0/1 пропускает только 1 и 20. В VRP port trunk allow-pass vlan ДОБАВЛЯЕТ VLAN к списку: interface XGigabitEthernet0/0/1 → port trunk allow-pass vlan 10.'],
      solution: [{ dev: 'SW1', cmds: ['system-view', 'interface XGigabitEthernet0/0/1', 'port trunk allow-pass vlan 10', 'return'] }],
      lesson: '<b>Транк пропускает только разрешённые VLAN, с обеих сторон.</b> В VRP <code>port trunk allow-pass vlan</code> <i>добавляет</i> VLAN к списку (в IOS без <code>add</code> список заменяется), а по умолчанию транк Huawei пропускает только VLAN 1 — новый VLAN нужно разрешить явно. Проверка: <code>display port vlan</code>, <code>display vlan</code>.' } },
    errdisable: { vrp: {
      hints: ['Кабель на месте, VLAN правильный — но линк красный. Посмотрите статус портов на SW1.',
        'display interface brief — GE0/0/2 down; display interface GigabitEthernet0/0/2 — ERROR DOWN(bpdu-protection); display logbuffer — причина.',
        'Причина устранена. interface GigabitEthernet0/0/2 → shutdown → undo shutdown.'],
      solution: [{ dev: 'SW1', cmds: ['system-view', 'interface GigabitEthernet0/0/2', 'shutdown', 'undo shutdown', 'return'] }],
      note: 'В VRP это состояние называется <b>Error-Down</b> (<code>stp bpdu-protection</code> + <code>stp edged-port enable</code>). Автовосстановление: <code>error-down auto-recovery cause bpdu-protection interval 30</code>.' } },
    stploop: { vrp: {
      story: 'Утром в офисе не работает ничего, лампочки на коммутаторах мигают синхронно. Ночью подрядчик проложил резервный кабель SW2–SW3 «для надёжности». А месяц назад кто-то выполнил на всех коммутаторах stp disable, «чтобы порты быстрее поднимались». Резервный кабель должен остаться.',
      hints: ['Легло всё и сразу. Зайдите на любой коммутатор: display cpu-usage и display logbuffer.',
        'CPU 99% и «MAC move detected» — шторм: SW1–SW2–SW3 образуют кольцо. Кто должен его разрывать? display stp.',
        'На всех трёх: system-view → stp enable. Корнем станет SW1 (stp priority 4096 уже настроен), а один порт на линке SW2–SW3 станет ALTE / DISCARDING.'],
      solution: ['SW1', 'SW2', 'SW3'].map(dev => ({ dev, cmds: ['system-view', 'stp enable', 'return'] })),
      note: 'Huawei по умолчанию работает в <b>MSTP</b>: один экземпляр (инстанс 0) на все VLAN, поэтому <code>stp enable</code> и <code>stp priority</code> действуют сразу на всю сеть, а не на один VLAN, как PVST у Cisco.' } },
    dhcpgw: { vrp: {
      hints: ['Адрес получен — DHCP работает. Посмотрите, какие ещё параметры пришли на PC1: ipconfig.',
        'Шлюз 10.0.10.254, а у R1 в этой сети 10.0.10.1. На R1: display ip pool name USERS.',
        'В VRP gateway-list — это список, клиент получает первый шлюз. ip pool USERS → undo gateway-list 10.0.10.254 → gateway-list 10.0.10.1, затем на ПК ipconfig /renew.'],
      solution: [{ dev: 'R1', cmds: ['system-view', 'ip pool USERS', 'undo gateway-list 10.0.10.254', 'gateway-list 10.0.10.1', 'return'] },
        { dev: 'PC1', cmds: ['ipconfig /renew'] }, { dev: 'PC2', cmds: ['ipconfig /renew'] }],
      note: 'В VRP <code>gateway-list</code> <i>добавляет</i> шлюз в список (до 8), а клиент получает первый. Поэтому неверный шлюз сначала удаляют через <code>undo gateway-list</code>. Глобальный пул работает на интерфейсе с <code>dhcp select global</code>.' } },
    dhcprelay: { vrp: {
      hints: ['169.254.x.x — ПК не дождался ответа от DHCP. DHCP Discover — широковещательный, за пределы подсети не выходит.',
        'Сервер в другой подсети — нужен relay на интерфейсе R1 в сторону ПК. Посмотрите display current-configuration.',
        'interface GigabitEthernet0/0/0 → dhcp select relay → dhcp relay server-ip 10.0.1.5 (не забудьте dhcp enable), затем PC1: ipconfig /renew.'],
      solution: [{ dev: 'R1', cmds: ['system-view', 'dhcp enable', 'interface GigabitEthernet0/0/0', 'dhcp select relay', 'dhcp relay server-ip 10.0.1.5', 'return'] },
        { dev: 'PC1', cmds: ['ipconfig /renew'] }],
      note: 'Аналог <code>ip helper-address</code> в VRP — пара команд <code>dhcp select relay</code> + <code>dhcp relay server-ip</code> на интерфейсе, плюс глобальный <code>dhcp enable</code>.' } },
    gateway: {
      vrp: { hints: ['Чтобы отправить пакет в чужую подсеть, хост ищет через ARP MAC своего шлюза. Проверьте шлюз PC1: ipconfig.',
        'Сравните его с адресом R1 в этой сети: на R1 — display ip interface brief.',
        'На PC1 шлюз 10.0.1.254, а R1 — 10.0.1.1: ipconfig 10.0.1.10 255.255.255.0 10.0.1.1'],
        solution: [{ dev: 'PC1', cmds: ['ipconfig 10.0.1.10 255.255.255.0 10.0.1.1'] }] },
      junos: { hints: ['Чтобы отправить пакет в чужую подсеть, хост ищет через ARP MAC своего шлюза. Проверьте шлюз PC1: ipconfig.',
        'Сравните его с адресом R1 в этой сети: на R1 — show interfaces terse.',
        'На PC1 шлюз 10.0.1.254, а R1 — 10.0.1.1: ipconfig 10.0.1.10 255.255.255.0 10.0.1.1'],
        solution: [{ dev: 'PC1', cmds: ['ipconfig 10.0.1.10 255.255.255.0 10.0.1.1'] }] } },
    returnpath: {
      vrp: { hints: ['Ping — это запрос туда и ответ обратно. Посмотрите анимацию: где теряется пакет?',
        'tracert с PC1 и display ip routing-table на R2: знает ли R2 сеть 10.0.1.0/24?',
        'На R2: system-view → ip route-static 10.0.1.0 24 10.0.12.1'],
        solution: [{ dev: 'R2', cmds: ['system-view', 'ip route-static 10.0.1.0 24 10.0.12.1', 'return'] }],
        note: 'В VRP статический маршрут — <code>ip route-static</code>, маску можно задать длиной (<code>24</code>). Приоритет static в Huawei — 60, OSPF — 10 (в Cisco наоборот: static 1, OSPF 110).' },
      junos: { hints: ['Ping — это запрос туда и ответ обратно. Посмотрите анимацию: где теряется пакет?',
        'tracert с PC1 и show route на R2: знает ли R2 сеть 10.0.1.0/24?',
        'На R2: configure → set routing-options static route 10.0.1.0/24 next-hop 10.0.12.1 → commit. Без commit ничего не применится!'],
        solution: [{ dev: 'R2', cmds: ['configure', 'set routing-options static route 10.0.1.0/24 next-hop 10.0.12.1', 'commit', 'exit'] }],
        note: JNOTE } },
    mask: {
      vrp: { hints: ['Линк зелёный, адрес шлюза совпадает с R1 — L1 и L2 в порядке. Что R1 думает о сети серверов?',
        'display ip routing-table на R1: какая сеть подключена к GE0/0/1? Попадает ли в неё 10.0.2.10?',
        'На GE0/0/1 маска /30. interface GigabitEthernet0/0/1 → ip address 10.0.2.1 24'],
        solution: [{ dev: 'R1', cmds: ['system-view', 'interface GigabitEthernet0/0/1', 'ip address 10.0.2.1 24', 'return'] }] },
      junos: { hints: ['Линк зелёный, адрес шлюза совпадает с R1 — L1 и L2 в порядке. Что R1 думает о сети серверов?',
        'show route и show interfaces terse на R1: какая сеть на ge-0/0/1?',
        'configure → delete interfaces ge-0/0/1 unit 0 family inet address 10.0.2.1/30 → set interfaces ge-0/0/1 unit 0 family inet address 10.0.2.1/24 → show | compare → commit'],
        solution: [{ dev: 'R1', cmds: ['configure', 'delete interfaces ge-0/0/1 unit 0 family inet address 10.0.2.1/30', 'set interfaces ge-0/0/1 unit 0 family inet address 10.0.2.1/24', 'commit', 'exit'] }],
        note: JNOTE + ' Учтите: в Junos <code>set ... address</code> <i>добавляет</i> ещё один адрес, а не заменяет старый — неверный нужно удалить через <code>delete</code>.' } },
    ospfarea: {
      vrp: { hints: ['Чтобы стать соседями OSPF, должны совпасть подсеть, area, таймеры, аутентификация. Проверьте: display ospf peer brief.',
        'Сравните display ospf interface на R1 и R2 — заголовки Area.',
        'На R2 линк в area 0.0.0.1. ospf 1 → area 1 → undo network 10.0.12.0 0.0.0.3 → quit → area 0 → network 10.0.12.0 0.0.0.3'],
        solution: [{ dev: 'R2', cmds: ['system-view', 'ospf 1', 'area 1', 'undo network 10.0.12.0 0.0.0.3', 'quit', 'area 0', 'network 10.0.12.0 0.0.0.3', 'return'] }],
        note: 'В VRP <code>network</code> задаётся внутри вида области (<code>ospf 1</code> → <code>area 0</code>), поэтому область видна прямо в конфиге — <code>display current-configuration configuration ospf</code>.' },
      junos: { hints: ['Чтобы стать соседями OSPF, должны совпасть подсеть, area, таймеры, аутентификация. Проверьте: show ospf neighbor.',
        'Сравните show ospf interface на R1 и R2 — колонка Area.',
        'На R2: configure → delete protocols ospf area 0.0.0.1 interface ge-0/0/1.0 → set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 → commit'],
        solution: [{ dev: 'R2', cmds: ['configure', 'delete protocols ospf area 0.0.0.1 interface ge-0/0/1.0', 'set protocols ospf area 0.0.0.0 interface ge-0/0/1.0', 'commit', 'exit'] }],
        note: 'В Junos OSPF включается на интерфейсе по имени (<code>protocols ospf area … interface ge-0/0/1.0</code>), без network/wildcard. Если оставить интерфейс в двух областях, <code>commit</code> не пройдёт. ' + JNOTE } },
    ospfmtu: {
      junos: { hints: ['Соседи есть, но в каком состоянии? show ospf neighbor — рабочее только Full.',
        'ExStart/Exchange — не проходит обмен DBD, а в нём передаётся MTU. Сравните show interfaces ge-0/0/1 на обоих: строка Protocol inet, MTU.',
        'На R2 IP MTU 1400. configure → delete interfaces ge-0/0/1 unit 0 family inet mtu → commit'],
        solution: [{ dev: 'R2', cmds: ['configure', 'delete interfaces ge-0/0/1 unit 0 family inet mtu', 'commit', 'exit'] }],
        note: 'Junos сравнивает MTU в DBD так же, как Cisco, — это частая проблема на стыке Juniper ↔ Cisco: у Junos физический MTU 1514 (с L2-заголовком), а IP MTU 1500. Huawei по умолчанию MTU в DBD не проверяет (<code>ospf mtu-enable</code>). ' + JNOTE } },
    free: {
      vrp: { story: 'Здесь всё работает: три роутера Huawei в OSPF-треугольнике и два ПК. Выключите линк R1–R2 (на R1: system-view → interface GigabitEthernet0/0/1 → shutdown) и посмотрите, как OSPF перестроит маршрут через R3 — display ip routing-table, tracert с PC1.',
        hints: ['Начните с display ip routing-table и display ospf peer brief на R1 — запомните «здоровое» состояние.',
          'Выключите GE0/0/1 на R1 и снова посмотрите таблицу: маршрут в 10.0.2.0/24 пойдёт через R3.',
          'На R3 на одном интерфейсе ospf timer hello 5 — сосед пропадёт. Верните: undo ospf timer hello.'], solution: [] },
      junos: { story: 'Здесь всё работает: три роутера Juniper в OSPF-треугольнике и два ПК. Выключите линк R1–R2 (на R1: configure → set interfaces ge-0/0/1 disable → commit) и посмотрите, как OSPF перестроит маршрут через R3 — show route, tracert с PC1. Попробуйте изменить что-нибудь без commit и сравните show | compare.',
        hints: ['Начните с show route и show ospf neighbor на R1 — запомните «здоровое» состояние.',
          'configure → set interfaces ge-0/0/1 disable → show | compare → commit. Потом show route: маршрут пойдёт через R3.',
          'Верните: delete interfaces ge-0/0/1 disable → commit. Или rollback 1, если бы он был (в симуляторе — rollback отменяет несохранённые правки).'], solution: [] } },
  };
  SCENARIOS.forEach(sc => Object.assign(sc, DX[sc.id] || {}));

  if (typeof module !== 'undefined' && module.exports) module.exports = SCENARIOS;
  else root.SANDBOX_SCENARIOS = SCENARIOS;
})(typeof window !== 'undefined' ? window : globalThis);
