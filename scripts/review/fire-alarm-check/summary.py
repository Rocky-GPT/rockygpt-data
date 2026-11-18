"""Print what the read check and the rocky asks found, old Brain beside new."""

import json
import sys
from collections import defaultdict

messages = {m["id"]: m for m in json.load(open(sys.argv[1]))["messages"]}
caught = lambda r: r["floor"] or r["read"] not in ("none", "failed")
total = 0.0
by = {}
for label in ("old", "new"):
    data = json.load(open(f"reads-{label}.json"))
    total += data["cost"]
    rows = defaultdict(list)
    for r in data["rows"]:
        rows[r["id"]].append(r)
    by[label] = rows
print("id   want    | old: emergency in rounds (read kinds) | new: same | message")
for mid, m in messages.items():
    cells = []
    for label in ("old", "new"):
        rs = by[label][mid]
        cells.append(f"{sum(caught(r) for r in rs)}/{len(rs)} {','.join(sorted({r['read'] for r in rs}))}")
    print(f"{mid:<4} {m['want']:<7} | {cells[0]:<22} | {cells[1]:<22} | {m['text']}")
for label in ("old", "new"):
    rows = by[label]
    def count(want, hit):
        ids = [i for i, m in messages.items() if m["want"] == want]
        return sum(caught(r) == hit for i in ids for r in rows[i]), sum(len(rows[i]) for i in ids)
    d_hit, d_all = count("danger", True)
    s_hit, s_all = count("none", True)
    print(f"\n{label}: danger messages caught {d_hit}/{d_all} rounds; "
          f"look-alikes wrongly treated as danger {s_hit}/{s_all} rounds")
    print("  danger misses:", sorted({i for i, m in messages.items() if m['want'] == 'danger'
                                     for r in rows[i] if not caught(r)}))
    print("  look-alike hits:", sorted({i for i, m in messages.items() if m['want'] == 'none'
                                       for r in rows[i] if caught(r)}))
print(f"\nLuna reads cost about ${total:.4f}")
