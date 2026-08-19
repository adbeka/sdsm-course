#!/usr/bin/env python3
"""Static site generator for the SDSM course portal.

Reads data/modules/*.json, renders each module through one shared page
template plus a home dashboard, and writes plain static HTML/CSS/JS to
dist/. No runtime dependencies in the output; Python (stdlib only, this
script) is only needed to build.
"""
import html
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data" / "modules"
DIST = ROOT / "dist"

GROUP_LABEL = {
    "foundations": "Основы",
    "l2": "L2 layer",
    "l3": "L3 layer",
    "mpls": "Провайдерские сервисы",
}
GROUP_ORDER = ["foundations", "l2", "l3", "mpls"]

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700'
         '&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">')


def chapter_of(m):
    src = m["meta"].get("ИСТОЧНИК", "")
    match = re.search(r"гл\.\s*(.+)$", src)
    return match.group(1).strip() if match else src


def strip_tags(html):
    return re.sub(r"<[^>]+>", "", html).strip()


def build_search_index(modules):
    index = []
    for m in modules:
        index.append({
            "type": "module", "title": m["tab_label"], "module": m["tab_label"],
            "snippet": m["subtitle"], "url": f'modules/{m["id"]}.html',
        })
        if m.get("cli_example"):
            index.append({
                "type": "cli", "title": m["cli_example"]["label"], "module": m["tab_label"],
                "snippet": m["cli_example"].get("note", ""),
                "url": f'modules/{m["id"]}.html#cli',
            })
        for i, g in enumerate(m["glossary"]):
            index.append({
                "type": "term", "title": g["term"], "module": m["tab_label"],
                "snippet": strip_tags(g["def_html"])[:140],
                "url": f'modules/{m["id"]}.html#gloss-{m["id"]}-{i}',
            })
        for i, c in enumerate(m["theory"]["cards"]):
            index.append({
                "type": "theory", "title": c["title"], "module": m["tab_label"],
                "snippet": strip_tags(c["body_html"])[:140],
                "url": f'modules/{m["id"]}.html#theory-{m["id"]}-{i}',
            })
        for i, it in enumerate(m.get("misconceptions") or []):
            index.append({
                "type": "misconception", "title": it["wrong"], "module": m["tab_label"],
                "snippet": it["right"][:140],
                "url": f'modules/{m["id"]}.html#misc-{m["id"]}-{i}',
            })
    return index


def linkify_terms(html, glossary_terms, skip_title=None):
    """Auto-link the first mention of a module's own glossary term inside
    a block of prose to that term's definition further down the page.
    Only touches plain-text nodes (splits on tags first) and links at most
    one term per text node, to stay safe and avoid visual clutter."""
    terms = sorted(
        ((g["term"], href, tooltip) for g, href, tooltip in glossary_terms),
        key=lambda t: len(t[0]), reverse=True,
    )
    parts = re.split(r"(<[^>]+>)", html)
    used = set()
    for i in range(0, len(parts), 2):
        text = parts[i]
        if not text.strip():
            continue
        for term, href, tooltip in terms:
            if term in used or term == skip_title:
                continue
            m = re.search(r"\b" + re.escape(term) + r"\b", text)
            if m:
                tip = tooltip.replace('"', "&quot;")
                link = f'<a class="term-link" href="{href}" title="{tip}">{m.group(0)}</a>'
                text = text[:m.start()] + link + text[m.end():]
                used.add(term)
                break
        parts[i] = text
    return "".join(parts)


def glossary_terms_for(m):
    return [
        (g, f'#gloss-{m["id"]}-{i}', strip_tags(g["def_html"]))
        for i, g in enumerate(m["glossary"])
    ]


def diagram_legend_html(svg_html):
    items = []
    if 'class="node-id self"' in svg_html or "node-id self" in svg_html:
        items.append('<span class="legend-item"><span class="legend-dot self"></span>ключевой узел на схеме</span>')
    if "node-id" in svg_html:
        items.append('<span class="legend-item"><span class="legend-dot"></span>соседний / промежуточный узел</span>')
    if "blocked" in svg_html:
        items.append('<span class="legend-item"><span class="legend-dash"></span>путь заблокирован / не пересылает</span>')
    if not items:
        return ""
    return f'<div class="diagram-legend">{"".join(items)}</div>'


def readout_block_html(diagram):
    readout = diagram.get("readout")
    if not readout:
        return ""
    kind = readout.get("kind", "plain")
    lines = readout["lines"]
    items = []
    for i, line in enumerate(lines):
        cls = "plain"
        if kind == "stp":
            if i == 0:
                cls = "dim"
            elif i == len(lines) - 1:
                cls = "good"
            else:
                cls = "amber"
        items.append(
            f'<li class="readout-step {cls}"><span class="readout-step-num">{i+1}</span>'
            f'<span class="readout-step-text">{line}</span></li>'
        )
    return f'<ol class="readout-steps">{"".join(items)}</ol>'


def load_modules():
    mods = []
    for f in sorted(DATA.glob("*.json")):
        mods.append(json.loads(f.read_text(encoding="utf-8")))
    mods.sort(key=lambda m: m["order"])
    return mods


def topnav_html(modules, active_id=None, depth="../", show_section_links=True, has_media=False, has_cli=False):
    groups = {}
    for m in modules:
        groups.setdefault(m["group"], []).append(m)

    dropdowns = []
    for g in GROUP_ORDER:
        items = sorted(groups.get(g, []), key=lambda m: m["order"])
        if not items:
            continue
        group_active = any(m["id"] == active_id for m in items)
        menu_items = []
        for m in items:
            active = " active" if m["id"] == active_id else ""
            href = f'{depth}modules/{m["id"]}.html'
            menu_items.append(
                f'<a class="nav-group-item{active}" href="{href}" data-progress-id="{m["id"]}">'
                f'{m["tab_label"]}<span class="tab-check"></span></a>'
            )
        dropdowns.append(f'''<div class="nav-group{" active" if group_active else ""}">
      <button type="button" class="nav-group-trigger">{GROUP_LABEL[g]}
        <svg class="nav-group-chevron" width="9" height="6" viewBox="0 0 9 6" fill="none"><path d="M1 1l3.5 3.5L8 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="nav-group-menu">{"".join(menu_items)}</div>
    </div>''')

    section_links = ""
    if show_section_links:
        media_link = '<a href="#media">Видео</a>' if has_media else ""
        cli_link = '<a href="#cli">CLI</a>' if has_cli else ""
        section_links = ('<div class="topnav-links">'
                          '<a href="#theory">Теория</a><a href="#process">Схема</a>'
                          f'{media_link}{cli_link}'
                          '<a href="#glossary">Глоссарий</a><a href="#quiz">Квиз</a></div>')

    return f'''<nav class="topnav">
  <div class="topnav-inner">
    <a class="topnav-brand" href="{depth}index.html">БЗПД · <b>учебный портал</b>
      <span class="topnav-progress-pill"><span class="val">0/{len(modules)}</span></span>
    </a>
    <div class="nav-groups">{"".join(dropdowns)}</div>
    <a class="nav-glossary-link" href="{depth}glossary.html">Глоссарий</a>
    <button type="button" class="search-trigger" aria-label="Поиск по сайту">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
    {section_links}
  </div>
</nav>
<div class="search-overlay">
  <div class="search-panel">
    <div class="search-input-row">
      <svg width="16" height="16" viewBox="0 0 15 15" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <input type="text" class="search-input" placeholder="Искать тему или термин…" autocomplete="off">
      <button type="button" class="search-close" aria-label="Закрыть">Esc</button>
    </div>
    <div class="search-results"></div>
  </div>
</div>'''


def breadcrumb_html(m, depth="../"):
    return (f'<div class="breadcrumb"><a href="{depth}index.html">Главная</a>'
            f'<span class="sep">/</span><span>{GROUP_LABEL[m["group"]]}</span>'
            f'<span class="sep">/</span><span class="current">{m["tab_label"]}</span></div>')


def theory_section(m):
    glossary_terms = glossary_terms_for(m)
    cards = "".join(
        f'<div class="theory-card" id="theory-{m["id"]}-{i}"><div class="theory-card-title">{c["title"]}</div>'
        f'<div class="theory-card-body">{linkify_terms(c["body_html"], glossary_terms, skip_title=c["title"])}</div></div>'
        for i, c in enumerate(m["theory"]["cards"])
    )
    tldr = m["theory"].get("tldr")
    tldr_html = f'<p class="theory-tldr">{tldr}</p>' if tldr else ""
    return f'''<section id="theory">
    <div class="section-head">
      <div class="section-num">01 — ТЕОРИЯ</div>
      <div class="section-title">{m["theory"]["title"]}</div>
      <p class="section-desc">{m["theory"]["desc"]}</p>
      {tldr_html}
    </div>
    <div class="theory-grid">{cards}</div>
  </section>'''


def process_section(m):
    glossary_terms = glossary_terms_for(m)
    steps = "".join(
        f'<li class="step"><span class="step-num">{s["num"]}</span>'
        f'<span class="step-text">{linkify_terms(s["body_html"], glossary_terms)}</span></li>'
        for s in m["process"]["steps"]
    )
    return f'''<section id="process">
    <div class="section-head">
      <div class="section-num">02 — ПРОЦЕСС</div>
      <div class="section-title">{m["process"]["title"]}</div>
      <p class="section-desc">{m["process"]["desc"]}</p>
    </div>
    <ul class="steps">{steps}</ul>
  </section>'''


def glossary_section(m):
    items = "".join(
        f'<div class="gloss-item" id="gloss-{m["id"]}-{i}"><div class="gloss-term">{g["term"]}</div>'
        f'<div class="gloss-def">{g["def_html"]}</div></div>'
        for i, g in enumerate(m["glossary"])
    )
    return f'''<section id="glossary">
    <div class="section-head">
      <div class="section-num">03 — ГЛОССАРИЙ</div>
      <div class="section-title">Термины модуля</div>
      <p class="section-desc">Короткий справочник — можно оставить открытым рядом с CLI.</p>
    </div>
    <div class="glossary-grid">{items}</div>
  </section>'''


def quiz_section(m):
    q = m["quiz"]
    correct_attr = ",".join(str(c) for c in q["correct"])
    cards = []
    for i, question in enumerate(q["questions"]):
        opts = "".join(
            f'<label class="quiz-opt"><input type="radio" name="{q["slug"]}-q{i}" value="{oi}"> {opt}</label>'
            for oi, opt in enumerate(question["options"])
        )
        cards.append(
            f'<div class="quiz-card"><div class="quiz-q"><span class="quiz-q-num">{i+1}</span>{question["q"]}</div>'
            f'<div class="quiz-options" data-q="{i}">{opts}</div></div>'
        )
    return f'''<section id="quiz">
    <div class="section-head">
      <div class="section-num">04 — ПРОВЕРКА</div>
      <div class="section-title">Квиз ({len(q["questions"])} вопросов)</div>
      <p class="section-desc">Без подвохов — если теория выше прочитана, займёт минуту.</p>
    </div>
    <div class="quiz" data-quiz="{q["slug"]}" data-module="{m["id"]}" data-correct="{correct_attr}">
      {"".join(cards)}
      <div class="quiz-footer">
        <button type="button" class="btn quiz-check">Проверить результат</button>
        <button type="button" class="btn secondary quiz-reset">Сбросить</button>
        <span class="quiz-score"></span>
      </div>
    </div>
  </section>'''


def video_embed_html(url):
    yt = re.search(r"(?:youtu\.be/|youtube\.com/watch\?v=|youtube\.com/embed/)([\w-]+)", url)
    if yt:
        src = f"https://www.youtube.com/embed/{yt.group(1)}"
    elif "vimeo.com" in url:
        vid = re.search(r"vimeo\.com/(\d+)", url)
        src = f"https://player.vimeo.com/video/{vid.group(1)}" if vid else url
    else:
        return f'<video class="media-video" controls src="{url}"></video>'
    fallback = (
        f'<p class="media-video-fallback">Если видео не загрузилось (например, страница открыта '
        f'напрямую как файл, без локального сервера) — <a href="{url}" target="_blank" rel="noopener">'
        f'открыть на YouTube ↗</a></p>'
    )
    return (f'<div class="media-video-frame"><iframe src="{src}" title="Видео" frameborder="0" '
            f'allowfullscreen loading="lazy"></iframe></div>{fallback}')


def media_section(m):
    media = m.get("media")
    if not media:
        return ""
    video = media.get("video_url")
    images = media.get("images") or []
    if not video and not images:
        return ""

    video_html = video_embed_html(video) if video else ""
    gallery_html = ""
    if images:
        figures = "".join(
            f'<figure class="media-figure"><img src="{img["src"]}" alt="{img.get("caption","")}" loading="lazy">'
            + (f'<figcaption>{img["caption"]}</figcaption>' if img.get("caption") else "")
            + "</figure>"
            for img in images
        )
        gallery_html = f'<div class="media-gallery">{figures}</div>'

    return f'''<section id="media">
    <div class="section-head">
      <div class="section-num">— МАТЕРИАЛЫ</div>
      <div class="section-title">Видео и иллюстрации</div>
      <p class="section-desc">Дополнительные материалы к модулю.</p>
    </div>
    {video_html}
    {gallery_html}
  </section>'''


def misconceptions_section(m):
    items = m.get("misconceptions") or []
    if not items:
        return ""
    cards = "".join(
        f'<div class="misc-card" id="misc-{m["id"]}-{i}">'
        f'<div class="misc-wrong"><span class="misc-tag bad">Кажется</span>{it["wrong"]}</div>'
        f'<div class="misc-right"><span class="misc-tag good">На деле</span>{it["right"]}</div>'
        f'</div>'
        for i, it in enumerate(items)
    )
    return f'''<section id="misconceptions">
    <div class="section-head">
      <div class="section-num">— ЧАСТЫЕ ЗАБЛУЖДЕНИЯ</div>
      <div class="section-title">Что обычно путают</div>
      <p class="section-desc">Типичные неверные представления про эту тему — и как на самом деле.</p>
    </div>
    <div class="misc-grid">{cards}</div>
  </section>'''


def related_section(m, modules_by_id):
    ids = m.get("related") or []
    items = [modules_by_id[rid] for rid in ids if rid in modules_by_id]
    if not items:
        return ""
    cards = "".join(
        f'<a class="related-card" href="{rm["id"]}.html">'
        f'<div class="related-card-chapter">Гл. {chapter_of(rm)}</div>'
        f'<div class="related-card-title">{rm["tab_label"]}</div>'
        f'<div class="related-card-sub">{rm["subtitle"][:90]}{"…" if len(rm["subtitle"]) > 90 else ""}</div>'
        f'</a>'
        for rm in items
    )
    return f'''<section id="related">
    <div class="section-head">
      <div class="section-num">— СВЯЗАННЫЕ ТЕМЫ</div>
      <div class="section-title">Куда это ведёт дальше</div>
      <p class="section-desc">Эти модули опираются на то, что вы только что прочитали, или используются вместе с этим.</p>
    </div>
    <div class="related-grid">{cards}</div>
  </section>'''


def cli_section(m):
    cli = m.get("cli_example")
    if not cli:
        return ""
    code = html.escape(cli["code"])
    note_html = f'<p class="cli-note">{cli["note"]}</p>' if cli.get("note") else ""
    return f'''<section id="cli">
    <div class="section-head">
      <div class="section-num">— ПРИМЕР</div>
      <div class="section-title">CLI-пример</div>
      <p class="section-desc">Готовый конфиг для копирования — синтаксис Cisco IOS, адаптируйте под свою схему адресации.</p>
    </div>
    <div class="cli-panel">
      <div class="cli-header">
        <span class="cli-label">{cli["label"]}</span>
        <button type="button" class="cli-copy" data-copy-target="cli-code-{m["id"]}">Копировать</button>
      </div>
      <pre class="cli-code" id="cli-code-{m["id"]}"><code>{code}</code></pre>
    </div>
    {note_html}
  </section>'''


def module_nav(modules, m):
    idx = next(i for i, x in enumerate(modules) if x["id"] == m["id"])
    parts = []
    if idx > 0:
        prev_m = modules[idx - 1]
        parts.append(
            f'<a class="module-nav-link prev" href="{prev_m["id"]}.html">'
            f'<div class="module-nav-dir">← Предыдущий</div>'
            f'<div class="module-nav-title">{prev_m["tab_label"]}</div></a>'
        )
    if idx < len(modules) - 1:
        next_m = modules[idx + 1]
        parts.append(
            f'<a class="module-nav-link next" href="{next_m["id"]}.html">'
            f'<div class="module-nav-dir">Следующий →</div>'
            f'<div class="module-nav-title">{next_m["tab_label"]}</div></a>'
        )
    return f'<div class="module-nav">{"".join(parts)}</div>'


def page_shell(title, body, depth="../"):
    return f'''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
{FONTS}
<link rel="stylesheet" href="{depth}assets/style.css">
</head>
<body data-depth="{depth}">
{body}
<script src="{depth}assets/app.js"></script>
</body>
</html>'''


def render_module(m, modules):
    media = m.get("media") or {}
    has_media = bool(media.get("video_url") or media.get("images"))
    has_cli = bool(m.get("cli_example"))
    nav = topnav_html(modules, active_id=m["id"], depth="../", has_media=has_media, has_cli=has_cli)
    breadcrumb = breadcrumb_html(m, depth="../")
    body = f'''{nav}
<div class="wrap">
  {breadcrumb}
  <section class="hero">
    <div class="eyebrow">Модуль {m["order"]+1} из {len(modules)} · {m["meta"].get("ФОРМАТ", "теория + схема + квиз")}</div>
    <h1>{m["title_html"]}</h1>
    <p class="hero-sub">{m["subtitle"]}</p>
    <div class="hero-meta">
      <div class="hero-meta-item">ИСТОЧНИК<b>{m["meta"].get("ИСТОЧНИК","—")}</b></div>
      <div class="hero-meta-item">ФОРМАТ<b>{m["meta"].get("ФОРМАТ","—")}</b></div>
      <div class="hero-meta-item">ВРЕМЯ<b>{m["meta"].get("ВРЕМЯ","—")}</b></div>
    </div>
    <div class="diagram-panel">
      <div class="diagram-label">{m["diagram"]["label"]}</div>
      {m["diagram"]["svg_html"]}
      {diagram_legend_html(m["diagram"]["svg_html"])}
      {readout_block_html(m["diagram"])}
      <p class="diagram-caption">{m["diagram"]["caption"]}</p>
    </div>
  </section>
  {media_section(m)}
  {theory_section(m)}
  {misconceptions_section(m)}
  {process_section(m)}
  {cli_section(m)}
  {glossary_section(m)}
  {quiz_section(m)}
  {related_section(m, {x["id"]: x for x in modules})}
  {module_nav(modules, m)}
  <div class="footer">
    <div class="feedback-panel">
      <h3>Модуль {m["order"]+1} из {len(modules)}</h3>
      <p>Результат квиза сохраняется локально в браузере — прогресс виден в верхнем меню и на главной странице.</p>
    </div>
  </div>
</div>'''
    return page_shell(f'БЗПД · {m["tab_label"]}', body, depth="../")


def render_home(modules):
    groups = {}
    for m in modules:
        groups.setdefault(m["group"], []).append(m)

    group_blocks = []
    for g in GROUP_ORDER:
        items = sorted(groups.get(g, []), key=lambda m: m["order"])
        cards = []
        for m in items:
            sub = m["subtitle"]
            if len(sub) > 118:
                sub = sub[:115].rsplit(" ", 1)[0] + "…"
            cards.append(
                f'<a class="module-card" href="modules/{m["id"]}.html" data-progress-id="{m["id"]}">'
                f'<div class="module-card-top"><span class="module-card-chapter">Гл. {chapter_of(m)}</span>'
                f'<span class="module-card-badge"></span></div>'
                f'<div class="module-card-title">{m["tab_label"]}</div>'
                f'<div class="module-card-sub">{sub}</div>'
                f'<div class="module-card-time">{m["meta"].get("ВРЕМЯ","")}</div></a>'
            )
        group_blocks.append(f'''<div class="home-group">
      <div class="home-group-head"><div class="home-group-title">{GROUP_LABEL[g]}</div>
      <div class="home-group-count">{len(items)} модул{"ь" if len(items)==1 else ("я" if len(items)<5 else "ей")}</div></div>
      <div class="module-grid">{"".join(cards)}</div>
    </div>''')

    nav = topnav_html(modules, active_id=None, depth="", show_section_links=False)
    body = f'''{nav}
<div class="wrap">
  <section class="home-hero">
    <div class="eyebrow">linkmeup · «Сети для самых маленьких» · внутренний курс</div>
    <h1>Теория сетей: <span>от VLAN до EVPN</span>, по шагам</h1>
    <p>{len(modules)} модулей — от базового плана сети и коммутации до MPLS L3VPN, EVPN и QoS. В каждом: теория, схема с разбором по шагам, CLI-пример, глоссарий и квиз на 5 вопросов.</p>
    <div class="home-progress">
      <div class="home-progress-ring">
        <svg width="64" height="64" viewBox="0 0 64 64">
          <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0D9488"/><stop offset="100%" stop-color="#B45309"/>
          </linearGradient></defs>
          <circle class="track" cx="32" cy="32" r="26"></circle>
          <circle class="fill" cx="32" cy="32" r="26"></circle>
        </svg>
        <div class="home-progress-ring-label">0%</div>
      </div>
      <div class="home-progress-text">Пройдено <b>0 / {len(modules)}</b> модулей</div>
      <a class="btn home-progress-cta" href="modules/{modules[0]["id"]}.html">Начать с первого →</a>
    </div>
  </section>
  {"".join(group_blocks)}
</div>'''
    return page_shell("БЗПД · Учебный портал", body, depth="")


def render_glossary_page(modules):
    nav = topnav_html(modules, active_id=None, depth="", show_section_links=False)

    entries = []
    for m in modules:
        for i, g in enumerate(m["glossary"]):
            entries.append({
                "term": g["term"], "def_html": g["def_html"],
                "module": m["tab_label"], "module_id": m["id"],
                "url": f'modules/{m["id"]}.html#gloss-{m["id"]}-{i}',
            })
    entries.sort(key=lambda e: e["term"].lower().lstrip("("))

    items = "".join(
        f'<a class="gloss-page-item" href="{e["url"]}" data-term="{e["term"].lower()}" data-def="{strip_tags(e["def_html"]).lower()}">'
        f'<div class="gloss-page-item-head"><span class="gloss-term">{e["term"]}</span>'
        f'<span class="gloss-page-module">{e["module"]}</span></div>'
        f'<div class="gloss-def">{e["def_html"]}</div></a>'
        for e in entries
    )

    body = f'''{nav}
<div class="wrap">
  <div class="breadcrumb"><a href="index.html">Главная</a><span class="sep">/</span><span class="current">Глоссарий</span></div>
  <section class="hero" style="padding-bottom:16px;">
    <div class="eyebrow">Все термины курса · {len(entries)}</div>
    <h1>Общий <span>глоссарий</span></h1>
    <p class="hero-sub">Термины из всех {len(modules)} модулей в одном месте — для быстрого поиска по работе, без чтения модуля целиком. Клик по термину открывает его в контексте модуля.</p>
    <div class="gloss-page-filter-row">
      <input type="text" class="gloss-page-filter" placeholder="Фильтр по термину или определению…" autocomplete="off">
      <span class="gloss-page-count">{len(entries)} терминов</span>
    </div>
  </section>
  <section style="padding-top:0;">
    <div class="gloss-page-grid">{items}</div>
    <p class="gloss-page-empty" hidden>Ничего не найдено.</p>
  </section>
</div>'''
    return page_shell("БЗПД · Глоссарий", body, depth="")


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "modules").mkdir(parents=True)
    (DIST / "assets").mkdir(parents=True)

    shutil.copy(ROOT / "assets" / "style.css", DIST / "assets" / "style.css")
    shutil.copy(ROOT / "assets" / "app.js", DIST / "assets" / "app.js")

    modules = load_modules()

    (DIST / "index.html").write_text(render_home(modules), encoding="utf-8")
    (DIST / "glossary.html").write_text(render_glossary_page(modules), encoding="utf-8")
    for m in modules:
        out = DIST / "modules" / f'{m["id"]}.html'
        out.write_text(render_module(m, modules), encoding="utf-8")

    search_index = build_search_index(modules)
    (DIST / "assets" / "search-index.json").write_text(
        json.dumps(search_index, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Built {len(modules)} module pages + home page + glossary into {DIST}")
    print(f"Search index: {len(search_index)} entries")


if __name__ == "__main__":
    main()
