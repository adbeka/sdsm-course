#!/usr/bin/env python3
"""Extract module content from the original prototype HTML into per-module JSON.

The prototype (bgp-module-beta_3.html) already has real, reviewed content for
all 18 modules, built on one consistent template. We keep that content
verbatim (including the hand-tuned SVG diagrams) and re-theme/re-lay-out it
under a new design system, rather than regenerating 18 modules of networking
content from scratch.
"""
import json
import re
from pathlib import Path
from bs4 import BeautifulSoup

SRC = Path("/Users/bekassyladenov/Downloads/bgp-module-beta_3.html")
OUT = Path(__file__).parent / "data" / "modules"
OUT.mkdir(parents=True, exist_ok=True)

# id -> (order, group, chapter override not needed, we read it from DOM)
ORDER = ["planning", "ciscoconn", "vlan", "staticroute", "stp", "nat", "ospf",
         "vpn", "bgp", "multicast", "mplsbase", "l3vpn", "l2vpn", "evpn",
         "evpnmh", "mplste", "packetlife", "qos"]

GROUP = {
    "planning": "foundations", "ciscoconn": "foundations",
    "vlan": "l2", "stp": "l2",
    "staticroute": "l3", "nat": "l3", "ospf": "l3",
    "vpn": "overlay", "bgp": "overlay", "multicast": "overlay",
    "mplsbase": "mpls", "l3vpn": "mpls", "l2vpn": "mpls",
    "evpn": "mpls", "evpnmh": "mpls", "mplste": "mpls",
    "packetlife": "hardware", "qos": "hardware",
}

TAB_LABEL = {
    "planning": "План", "ciscoconn": "CLI", "vlan": "VLAN", "staticroute": "Static",
    "stp": "STP", "nat": "NAT", "ospf": "OSPF", "vpn": "VPN", "bgp": "BGP",
    "multicast": "Multicast", "mplsbase": "MPLS", "l3vpn": "L3VPN", "l2vpn": "L2VPN",
    "evpn": "EVPN", "evpnmh": "EVPN-MH", "mplste": "MPLS TE", "packetlife": "Packet",
    "qos": "QoS",
}

html = SRC.read_text(encoding="utf-8")
soup = BeautifulSoup(html, "html.parser")


def inner_html(tag):
    if tag is None:
        return ""
    return tag.decode_contents().strip()


def text(tag):
    if tag is None:
        return ""
    return tag.get_text(strip=True)


modules = {}

for panel in soup.select("div.module-panel"):
    mid = panel["data-module"]
    h1 = panel.select_one("h1")
    hero_sub = panel.select_one("p.hero-sub")
    meta_items = panel.select(".hero-meta-item")
    meta = {}
    for mi in meta_items:
        b = mi.find("b")
        label = mi.get_text(strip=True)
        if b:
            val = b.get_text(strip=True)
            label = label[: -len(val)] if label.endswith(val) else label
        meta[label] = val if b else ""

    diagram_label = text(panel.select_one(".diagram-label"))
    svg_tag = panel.select_one(".path-svg")
    readout_tag = panel.select_one(".readout, .readout-stp")
    diagram_caption = text(panel.select_one(".diagram-caption"))

    theory_cards = []
    for card in panel.select(f"#{mid}-theory .theory-card"):
        theory_cards.append({
            "title": text(card.select_one(".theory-card-title")),
            "body_html": inner_html(card.select_one(".theory-card-body")),
        })
    theory_section_title = text(panel.select_one(f"#{mid}-theory .section-title"))
    theory_section_desc = text(panel.select_one(f"#{mid}-theory .section-desc"))

    path_section_title = text(panel.select_one(f"#{mid}-path .section-title"))
    path_section_desc = text(panel.select_one(f"#{mid}-path .section-desc"))
    steps = []
    for li in panel.select(f"#{mid}-path .step"):
        num = text(li.select_one(".step-num"))
        body = inner_html(li.select_one(".step-text"))
        steps.append({"num": num, "body_html": body})

    glossary = []
    for item in panel.select(f"#{mid}-glossary .gloss-item"):
        glossary.append({
            "term": text(item.select_one(".gloss-term")),
            "def_html": inner_html(item.select_one(".gloss-def")),
        })

    quiz_el = panel.select_one(f"#{mid}-quiz .quiz")
    correct = [int(x) for x in quiz_el["data-correct"].split(",")]
    questions = []
    for card in quiz_el.select(".quiz-card"):
        q_full = card.select_one(".quiz-q")
        qnum = q_full.select_one(".quiz-q-num")
        qnum_text = qnum.get_text(strip=True) if qnum else ""
        q_text = q_full.get_text(strip=True)
        if qnum_text and q_text.startswith(qnum_text):
            q_text = q_text[len(qnum_text):].strip()
        opts = []
        for label in card.select(".quiz-opt"):
            lbl_text = label.get_text(strip=True)
            opts.append(lbl_text)
        questions.append({"q": q_text, "options": opts})

    data = {
        "id": mid,
        "order": ORDER.index(mid) if mid in ORDER else 99,
        "group": GROUP.get(mid, "foundations"),
        "tab_label": TAB_LABEL.get(mid, mid.upper()),
        "title_html": inner_html(h1),
        "subtitle": text(hero_sub),
        "meta": meta,
        "diagram": {
            "label": diagram_label,
            "svg_html": str(svg_tag) if svg_tag else "",
            "readout_html": str(readout_tag) if readout_tag else "",
            "caption": diagram_caption,
        },
        "theory": {
            "title": theory_section_title,
            "desc": theory_section_desc,
            "cards": theory_cards,
        },
        "process": {
            "title": path_section_title,
            "desc": path_section_desc,
            "steps": steps,
        },
        "glossary": glossary,
        "quiz": {
            "slug": quiz_el["data-quiz"],
            "correct": correct,
            "questions": questions,
        },
    }
    modules[mid] = data

print(f"Extracted {len(modules)} modules: {sorted(modules.keys())}")
missing = set(ORDER) - set(modules.keys())
if missing:
    print("MISSING:", missing)

for mid, data in modules.items():
    out_path = OUT / f"{mid}.json"
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out_path)
