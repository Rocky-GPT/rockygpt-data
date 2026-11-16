"""Temporary probe (never merged): what an office page row holds, for the page marks of step 1."""

import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

from rockygpt_brain.retrieval.entity_facts import past_page, past_term
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts, _loads

TODAY = date(2026, 11, 16)
facts = GraphOnlyFacts(Path(".published"))
graph = facts._graph()
connection = graph._lb.Connection(graph._database)
pages: dict[str, dict] = {}
names: dict[str, tuple[str, str]] = {}
for eid, kind, name, rid, doc in connection.execute(
        "MATCH (e:Entity)-[h:HAS_RECORD]->(r:Record) WHERE h.collection = 'office_sections' "
        "RETURN e.id, e.kind, e.name, r.id, r.doc"):
    names[eid] = (kind, name)
    held = pages.setdefault(rid, {"row": _loads(doc), "entities": []})
    held["entities"].append(eid)
print("pages", len(pages))
row0 = next(iter(pages.values()))["row"]
print("row keys", sorted(row0.keys()))
print("linking entities per page", Counter(min(len(p["entities"]), 6) for p in pages.values()))
print("kinds per page", Counter(tuple(sorted({names[e][0] for e in p["entities"]})) for p in pages.values()).most_common(12))
offices = Counter(sum(1 for e in p["entities"] if names[e][0] == "office") for p in pages.values())
print("offices per page", sorted(offices.items()))
print("site_folder set", sum(1 for p in pages.values() if p["row"].get("site_folder")))
print("dated", sum(1 for p in pages.values() if p["row"].get("page_modified_at")))
# Per folder: which entities link how many of its pages.
by_folder: dict[str, Counter] = {}
for p in pages.values():
    by_folder.setdefault(str(p["row"].get("site_folder")), Counter()).update(p["entities"])
size = Counter(str(p["row"].get("site_folder")) for p in pages.values())
multi = [(f, c) for f, c in by_folder.items() if len([e for e in c if names[e][0] == "office"]) > 1]
print("folders", len(by_folder), "with more than one office linking", len(multi))
for f, c in sorted(multi)[:40]:
    print(f"  {f} ({size[f]} pages): " + "; ".join(f"{names[e][1]} [{names[e][0]}] {n}" for e, n in c.most_common(5)))
ARCHIVE = re.compile(r"(?:^|[-/])(?:previous|past|archives?|archived)(?:[-/]|$)")
past = [(p["row"]["url"], past_page(p["row"]["url"], TODAY)) for p in pages.values() if past_page(p["row"]["url"], TODAY)]
print("past by address", len(past))
for u, w in sorted(past):
    print("  P", w, u)
arch = sorted(p["row"]["url"] for p in pages.values() if ARCHIVE.search(p["row"]["url"].split("ramapo.edu", 1)[-1].lower()))
print("archive words", len(arch))
for u in arch:
    print("  A", u)
heads = []
for p in pages.values():
    secs = p["row"].get("sections") or []
    if secs and isinstance(secs[0], dict):
        h = str(secs[0].get("heading") or "")
        w = past_term(h, TODAY)
        if w:
            heads.append((p["row"]["url"], h, w))
print("past by first heading", len(heads))
for u, h, w in sorted(heads):
    print("  H", w, "|", h[:80], "|", u)
print("first headings sample", [str((p["row"].get("sections") or [{}])[0].get("heading"))[:50] for p in list(pages.values())[:15]])
