"""Study only: what the live graph holds after the 11-18 release (no model call)."""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402
from rockygpt_brain.retrieval.entity_facts import linked_rows  # noqa: E402

SITES = json.loads((Path(__file__).parents[1] / "src/reference/academic-sites.json").read_text())
FOLDERS = {s["folder"] for s in SITES["sites"]}
facts, gateway, engine, ledger = common.build(0.0)
print("release", facts.active_release()[0])
school_pages, athletics, shaped, stem = set(), [], 0, []
with facts.snapshot() as snapshot:
    for entity in snapshot.entities:
        if not any(link.get("collection") == "office_sections" for link in entity["links"]):
            continue
        for row in linked_rows(entity, snapshot.record_reader(entity, "office_sections"), "office_sections"):
            url = str(row.get("url") or "")
            parts = url.split("/")
            if len(parts) > 3 and parts[3] in FOLDERS:
                school_pages.add(url)
            if "ramapoathletics" in url:
                athletics.append((entity["name"], url, [s.get("heading") for s in row.get("sections") or []][:8]))
            for s in row.get("sections") or []:
                if "\n" in str(s.get("text") or ""):
                    shaped += 1
                if "stem-center" in url and "Walk-in" in str(s.get("text") or ""):
                    stem.append((url, s.get("heading"), str(s.get("text"))[:500]))
print("school/program pages linked:", len(school_pages))
print("section texts with lines (linked, counted per link):", shaped)
for a in athletics:
    print("ATHLETICS", a)
for s in stem[:3]:
    print("STEM", s)
LOST = {"Beth Foster", "Jill Pierson", "Kathy Larsen", "Vanessa Ramos"}
with facts.snapshot() as snapshot:
    for entity in snapshot.entities:
        if entity["name"] in LOST:
            print("PERSON", entity["name"], [(l.get("type"), l.get("to") or l.get("target_name") or l.get("collection")) for l in entity["links"]][:12])
            print("  attrs", {k: v for k, v in entity.items() if k not in ("links",)})
