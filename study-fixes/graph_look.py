"""Search the graph's records for words (no model call): where does a fact live, if anywhere?
LOOK holds patterns separated by ";;". Prints each hit with its collection, owner and context."""

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402

facts, gateway, engine, ledger = common.build(0.0)
patterns = [re.compile(p, re.I) for p in os.environ["LOOK"].split(";;") if p]
print("release", facts.active_release()[0])
seen: set[tuple[str, str]] = set()
hits: Counter[str] = Counter()
with facts.snapshot() as snapshot:
    kinds = Counter(e["kind"] for e in snapshot.entities)
    print("entity kinds:", dict(kinds))
    for entity in snapshot.entities:
        for link in entity["links"]:
            collection = link.get("collection")
            try:
                rows = list(snapshot.record_reader(entity, collection))
            except Exception:  # noqa: BLE001
                continue
            for row in rows:
                key = (collection, str(row.get("id")))
                if key in seen:
                    continue
                seen.add(key)
                text = json.dumps(row, ensure_ascii=False, default=str)
                for p in patterns:
                    for m in list(p.finditer(text))[:3]:
                        hits[p.pattern] += 1
                        if hits[p.pattern] <= 25:
                            print(f"[{p.pattern}] {collection} | {entity['kind']}:{entity['name']} | "
                                  f"{row.get('url') or ''} | ...{text[max(0, m.start()-200): m.end()+250]}...")
    # Entities whose names match.
    for entity in snapshot.entities:
        for p in patterns:
            if p.search(entity["name"]):
                print(f"ENTITY [{p.pattern}] {entity['kind']}: {entity['name']} links="
                      f"{sorted({l.get('collection') for l in entity['links']})}")
print("hits", dict(hits))
