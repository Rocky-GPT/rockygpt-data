"""Who owns the school and program site pages in the graph (no model call): for each of the 27
academic folders, how many pages are linked, and to which entity kinds and names."""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402
from rockygpt_brain.retrieval.entity_facts import linked_rows  # noqa: E402

SITES = json.loads((Path(__file__).parents[1] / "src/reference/academic-sites.json").read_text())
FOLDERS = {s["folder"] for s in SITES["sites"]}
facts, gateway, engine, ledger = common.build(0.0)
print("release", facts.active_release()[0])
pages: dict[str, set[str]] = defaultdict(set)
kinds: Counter[str] = Counter()
owners: dict[str, Counter[str]] = defaultdict(Counter)
with facts.snapshot() as snapshot:
    for entity in snapshot.entities:
        if not any(link.get("collection") == "office_sections" for link in entity["links"]):
            continue
        for row in linked_rows(entity, snapshot.record_reader(entity, "office_sections"),
                               "office_sections"):
            url = str(row.get("url") or "")
            parts = url.split("/")
            folder = parts[3] if len(parts) > 3 else ""
            if folder not in FOLDERS:
                continue
            pages[folder].add(url)
            kinds[entity["kind"]] += 1
            owners[folder][f"{entity['kind']}:{entity['name']}"] += 1
print("academic pages linked:", sum(len(v) for v in pages.values()), "kinds:", dict(kinds))
for folder in sorted(FOLDERS):
    print(f"{folder}: {len(pages[folder])} pages | {dict(owners[folder].most_common(4))}")
