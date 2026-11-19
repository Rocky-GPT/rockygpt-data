"""Temporary, never merged: the Archway calendar events dated Nov 19 to Nov 30, 2026, as this
morning's data release holds them, for the graders of the sealed run's run_day questions
(the Archway calendar itself needs JavaScript, so it cannot be read by a checker). Written to OUT
on the runner only; it goes into the encrypted bundle. Prints a count only."""

import json
import os
import re
from datetime import date
from pathlib import Path

from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts

DATED = re.compile(r"\((\d{4})-(\d{2})-(\d{2})\)\s*$")
facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
version, identity_hash = facts.active_release()
picked = []
for event in facts.identities(("event",)):
    m = DATED.search(str(event["name"]))
    if m and date(2026, 11, 19) <= date(*map(int, m.groups())) <= date(2026, 11, 30):
        picked.append(event)
rows = []
for k in range(0, len(picked), 10):
    ids = [e["id"] for e in picked[k:k + 10]]
    rows += facts.get_event_facts(ids, version, identity_hash=identity_hash)
Path(os.environ["OUT"]).write_text(json.dumps({"release": version, "events": rows},
                                              ensure_ascii=False, default=str))
print(f"events dated Nov 19-30: {len(picked)}; read {len(rows)}")
