# Module JSON schema

Each file in `data/modules/*.json` describes one course module. `build.py` renders
it through one shared page template — content authors never touch HTML/CSS.

```jsonc
{
  "id": "bgp",                          // slug, used for URL /modules/<id>.html
  "order": 8,                           // position in course order (0-indexed, matches SDSM chapter order)
  "group": "overlay",                   // one of: foundations, l2, l3, overlay, mpls, hardware
  "tab_label": "BGP",                   // short label in the top nav dropdown
  "title_html": "BGP: <span>путь вектора</span>, а не карта сети",  // <span> = teal accent
  "subtitle": "1-2 sentence thesis, plain text",
  "meta": {
    "ИСТОЧНИК": "linkmeup / СДСМ, гл. 8 и 8.1",
    "ФОРМАТ": "теория + схема + квиз",
    "ВРЕМЯ": "~12 минут"
  },
  "diagram": {
    "label": "short uppercase caption above the diagram",
    "svg_html": "<svg class=\"path-svg\" ...>...</svg>",   // raw, hand-authored SVG — reuses .node-id/.node-id.self/.link-line/.link-line.blocked classes so diagram_legend_html() in build.py can auto-detect what legend items to show
    "readout": {
      "kind": "plain" | "stp",          // "stp" colors stages dim -> amber -> amber -> good; "plain" is teal throughout
      "lines": ["stage 1 text", "stage 2 text", "stage 3 text", "stage 4 text"]  // rendered as a numbered, always-visible list (readout_block_html)
    },
    "caption": "1-3 sentences explaining what the diagram shows."
  },
  "theory": {
    "title": "Из чего состоит решение BGP",
    "desc": "1 sentence framing the section",
    "tldr": "Проще говоря: ...",         // optional — plain-language one-liner rendered as a highlighted callout above the cards
    "cards": [                          // 5-6 cards
      {"title": "Автономная система (AS)", "body_html": "...text with <code>code</code>..."}
    ]
  },
  "process": {
    "title": "Как BGP решает, какой путь лучший",
    "desc": "1 sentence framing why order matters",
    "steps": [                          // 4-6 steps
      {"num": "1", "body_html": "<b>Выше LOCAL_PREFERENCE</b> — rest of the sentence"}
    ]
  },
  "glossary": [                         // 6-8 terms
    {"term": "NLRI", "def_html": "..."}
  ],
  "quiz": {
    "slug": "bgp",                      // used to namespace radio input names
    "correct": [1, 1, 1, 1, 1],         // 5 correct option indices
    "questions": [
      {"q": "...", "options": ["...", "...", "...", "..."]}
    ]
  },
  "media": {                            // OPTIONAL — omit entirely until real content exists; section auto-hides when absent
    "video_url": "https://youtube.com/watch?v=...",   // YouTube/Vimeo link (auto-embedded) or a direct .mp4 URL
    "images": [
      {"src": "https://...", "caption": "optional caption text"}
    ]
  },
  "misconceptions": [                   // OPTIONAL — 2-3 items, rendered as "Кажется / На деле" cards right after Theory
    {"wrong": "common wrong belief, plain text", "right": "the correction, plain text"}
  ],
  "related": ["ospf", "l3vpn", "multicast"],  // OPTIONAL — 2-3 other module ids, rendered as cards before the prev/next footer nav
  "cli_example": {                      // OPTIONAL — rendered as a dark terminal panel with a Copy button, between Process and Glossary
    "label": "short heading for the block, e.g. 'Базовая настройка OSPF'",
    "code": "raw multi-line CLI text, plain text — no markup, gets html-escaped at build time",
    "note": "optional 1-sentence caption below the block"
  },
  "lab": {                              // OPTIONAL — rendered right after cli_example: scenario + task checklist + collapsible solution (native <details>)
    "scenario": "1-2 sentence realistic setup, plain text",
    "tasks": ["imperative task 1", "imperative task 2", "..."],   // 4-6 items, numbered list
    "solution_code": "raw multi-line CLI text — same treatment as cli_example.code, shown inside the spoiler",
    "verify": "optional 1-sentence hint on how to confirm it actually worked"
  }
}
```

We cannot generate real Packet Tracer (.pkt) or GNS3 project files — those are binary formats owned by the respective apps. `lab` is deliberately text-only: a scenario + checklist the reader carries out themselves in their own simulator/lab, with the CLI solution hidden behind a spoiler for self-checking rather than shown upfront.

**Auto-linked terms**: `theory.cards[].body_html` and `process.steps[].body_html` are run through `linkify_terms()` at build time — the *first* mention of one of that module's own `glossary` terms gets turned into a dotted-underline link (with the definition as a hover tooltip) pointing to that term's entry further down the same page. No authoring needed; it just works off whatever terms already exist in `glossary`. At most one link per text block, so it never turns a paragraph into a wall of links.

Groups (top-nav dropdown sections, in this order):
- `foundations` — Планирование, Подключение к оборудованию, Поднятие порта, DHCP и DNS, Методология траблшутинга
- `l2` — VLAN, LAG / EtherChannel, AAA и 802.1X, STP, Packet Life
- `l3` — Static, NAT, OSPF, IPv6, VPN, BGP, Multicast
- `mpls` — MPLS base, L3VPN, L2VPN, EVPN, EVPN-MH, MPLS TE, QoS

`order` (0-23) drives the linear course sequence (chapter numbering, prev/next footer nav) independently of `group` (dropdown categorization) — the two don't have to line up perfectly; e.g. VPN/BGP/Multicast sit in `l3` despite being conceptually "overlay" topics, and Packet Life sits in `l2` despite being a hardware topic, because that's where they read best in the nav.

All body text is Russian: precise, no fluff, short sentences, `<code>` for protocol terms/attributes. To add video/images to a module, just add the `media` key to its JSON and rebuild (`python3 build.py`) — no template changes needed.

## Инструменты инженера (`data/toolkit.json` → `tools.html`)

Отдельная страница-практикум, не входит в линейный порядок модулей и прогресс. `build.py` рендерит её из `data/toolkit.json`, а калькуляторы (подсети, суммаризация, MTU/MSS, время передачи/BDP, MAC/EUI-64) живут в `assets/app.js` (`initTools()`) и работают целиком в браузере.

Что редактируется в JSON без правки кода:
- `habits` — карточки «Привычки, которые спасают»: `{title, body_html}`
- `ad_table`, `ports_table`, `proto_table`, `mcast_table`, `ethertype_table`, `ranges_table` — справочные таблицы: `{columns: [...], rows: [[...]], note?}` (ячейки — HTML)
- `commands` — шпаргалка `{task, ios, linux}` (plain text, многострочный через `\n`; `—` если аналога нет)
- `checklist` — чек-лист траблшутинга `[{layer, items: [...]}]`; отметки хранятся в `localStorage` (`sdsm_checklist`) по позиции пункта
- `templates` — копируемые шаблоны `{id, label, note, code}`

Таблица масок /8–/32 генерируется в `build.py`, список туннельных накладных расходов для MTU-калькулятора — `MTU_OVERHEADS` в `build.py`. Всё попадает в поиск по сайту с типом «Инструмент».

## Интерактивные лаборатории (`labs/`)

Самостоятельные HTML-страницы в `labs/` копируются в `dist/labs/` как есть. Библиотеки лежат локально в `labs/vendor/` (three.js r128, anime.js 3.2.2, MIT), чтобы лабы работали без CDN — в том числе во внутренней сети. Без WebGL лаба сама переключается на 2D-схему.

Чтобы лаба появилась на сайте, добавьте её в `labs` в `data/toolkit.json`:
`{id, title, url: "labs/<file>.html", desc, tags: [...], modules: ["l2vpn", ...]}` — карточка покажется на главной, на странице «Инструменты» и в разделе «Посмотреть вживую» у каждого модуля из `modules`, а также в поиске.

Репозиторий публичный: перед добавлением лабы замените реальные имена устройств, адреса, клиентов, ID каналов и AS на учебные (192.0.2.0/24, AS 65000 и т. п.).

### Сетевая песочница (`labs/sandbox.html`)

Симулятор с CLI в стиле Cisco IOS — без зависимостей, всё в браузере:
- `labs/sandbox/engine.js` — модель сети и CLI: L2 (VLAN, транки 802.1Q, err-disabled, STP по VLAN с выбором корня и BLK-портами; петля без STP = широковещательный шторм), L3-пересылка с ARP, connected/static/OSPF (соседство: подсеть, area, hello, MTU, passive), extended и standard ACL, NAT (PAT с трансляцией портов и статический), DHCP (пулы, excluded, relay через `ip helper-address`, APIPA), ping/traceroute/telnet с проверкой обратного пути. Без DOM — можно тестировать в Node.
- `labs/sandbox/scenarios.js` — сценарии. Новый сценарий: `{id, title, topic, diff (1-3, 0 = свободный), story, goals: [{from, to, label, proto?, port?, expect?: 'deny'} | {label, check: net => bool}], build() → {devices, links}, hints: [3 строки], solution: [{dev, cmds}], lesson}`. Устройства собираются через `PC()`, `SW()`, `RT()` из движка.
- `labs/sandbox/ui.js` — интерфейс. Прогресс хранится в `localStorage` (`sdsm_sandbox_solved`), сценарий открывается по ссылке `sandbox.html#<id>`.

`module_links` в записи лабы в `toolkit.json` задаёт, какой сценарий открывать из конкретного модуля (`{"vlan": "#vlan"}`).

Проверка после правок сценариев: эталонное `solution` должно переводить все `goals` из «не выполнено» в «выполнено» (до решения хотя бы одна цель должна проваливаться).
