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
  "related": ["ospf", "l3vpn", "multicast"]  // OPTIONAL — 2-3 other module ids, rendered as cards before the prev/next footer nav
}
```

**Auto-linked terms**: `theory.cards[].body_html` and `process.steps[].body_html` are run through `linkify_terms()` at build time — the *first* mention of one of that module's own `glossary` terms gets turned into a dotted-underline link (with the definition as a hover tooltip) pointing to that term's entry further down the same page. No authoring needed; it just works off whatever terms already exist in `glossary`. At most one link per text block, so it never turns a paragraph into a wall of links.

Groups (top-nav dropdown sections, in this order):
- `foundations` — План, CLI
- `l2` — VLAN, STP
- `l3` — Static, NAT, OSPF
- `overlay` — VPN, BGP, Multicast
- `mpls` — MPLS base, L3VPN, L2VPN, EVPN, EVPN-MH, MPLS TE
- `hardware` — Packet Life, QoS

All body text is Russian: precise, no fluff, short sentences, `<code>` for protocol terms/attributes. To add video/images to a module, just add the `media` key to its JSON and rebuild (`python3 build.py`) — no template changes needed.
