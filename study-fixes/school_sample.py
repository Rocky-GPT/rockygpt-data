"""40 random school and program site pages from the graph (seeded), each with its owner and the
start of a few sections, to write fresh test questions from (no model call)."""

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402
from rockygpt_brain.retrieval.entity_facts import linked_rows  # noqa: E402

SITES = json.loads((Path(__file__).parents[1] / "src/reference/academic-sites.json").read_text())
FOLDERS = {s["folder"] for s in SITES["sites"]}
facts, gateway, engine, ledger = common.build(0.0)
print("release", facts.active_release()[0])
rows = []
with facts.snapshot() as snapshot:
    for entity in snapshot.entities:
        if not any(link.get("collection") == "office_sections" for link in entity["links"]):
            continue
        for row in linked_rows(entity, snapshot.record_reader(entity, "office_sections"),
                               "office_sections"):
            parts = str(row.get("url") or "").split("/")
            if len(parts) > 3 and parts[3] in FOLDERS:
                rows.append((entity["name"], row))
random.Random(1118).shuffle(rows)
for owner, row in rows[:40]:
    print(f"##### {row.get('url')} | {owner}")
    for section in (row.get("sections") or [])[:4]:
        if isinstance(section, dict):
            text = " ".join(str(section.get("text") or "").split())
            print(f"   [{section.get('heading')}] {text[:260]}")
