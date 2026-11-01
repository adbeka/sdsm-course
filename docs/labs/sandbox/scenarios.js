/* Сценарии сетевой песочницы. Каждый — сломанная сеть, которую нужно починить через CLI.
   goals: проверки, которые движок прогоняет после каждой команды.
   solution: эталонные команды (используются в «Показать решение» и в автотесте). */
(function (root) {
  'use strict';
  const N = root.NetSim || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const { PC, SW, RT } = N;
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

  if (typeof module !== 'undefined' && module.exports) module.exports = SCENARIOS;
  else root.SANDBOX_SCENARIOS = SCENARIOS;
})(typeof window !== 'undefined' ? window : globalThis);
