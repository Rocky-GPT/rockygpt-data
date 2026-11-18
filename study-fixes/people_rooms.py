"""Study only: where the office_at links of the people the 11-18 prod run lost came from."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402

NAMES = ["Amy Brener", "Angela Moore", "Beth Foster", "Caitlyn Campbell", "Connor Peyton",
         "Dylan Heffernan", "LaQuan Norman", "Julie Kossoy", "School of Social Sciences and Social Work"]
facts, gateway, engine, ledger = common.build(0.0)
print("release", facts.active_release()[0])
with facts.snapshot() as snapshot:
    by_id = {e["id"]: e for e in snapshot.entities}
    for e in snapshot.entities:
        if e["name"] not in NAMES:
            continue
        print("====", e["kind"], e["name"])
        print("  links:", json.dumps(e["links"])[:600])
        for r in e.get("relationships") or []:
            target = by_id.get(r.get("target_entity_id"), {}).get("name")
            print("  REL", r.get("type"), "->", target, "|", json.dumps(r.get("evidence"))[:500])
