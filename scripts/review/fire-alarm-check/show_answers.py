"""Print how each Brain's reply to each rocky question starts, and whether it leads with an emergency text."""

import json
import sys

from rockygpt_brain.boundary import situation_of

old, new = (json.load(open(p)) for p in sys.argv[1:3])
new_by = {(r["id"], r.get("run")): r for r in new}
for r in old:
    n = new_by[(r["id"], r.get("run"))]
    print(f"\n{r['id']}: {r['question']}")
    for label, row in (("old", r), ("new", n)):
        answer = row["body"].get("answer") or json.dumps(row["body"])[:200]
        lead = situation_of(answer) or "-"
        print(f"  {label} emergency={lead:<9} {' '.join(answer.split())[:260]}")
