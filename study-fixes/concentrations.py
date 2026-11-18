"""Every requirement-group label that names a concentration, track, option or specialization
inside a program, and which programs have graduation plans with a credit total (no model call)."""

import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402

facts, gateway, engine, ledger = common.build(0.0)
version, identity_hash = facts.active_release()
print("release", version)
WORD = re.compile(r"concentration|track|option|specialization|specialisation|emphasis|focus",
                  re.I)
labels: Counter[str] = Counter()
with_plan = without_plan = 0
for program in facts.identities(("program",)):
    found = facts.get_program_facts(program["id"], version, identity_hash=identity_hash)
    props = {p["key"]: p for p in found["properties"]}
    names = set()
    for value in (props.get("requirements") or {}).get("values", []):
        label = str(value["value"].get("label") or "")
        if WORD.search(label):
            names.add(label)
    if names:
        print(f"{program['name']}: {sorted(names)}")
    labels.update(WORD.search(n).group(0).lower() for n in names)
    plans = (props.get("plans") or {}).get("values", [])
    totals = {t for v in plans for t in (v["value"].get("totals") or []) if "credit" in str(t).lower()}
    if plans:
        with_plan += 1
    elif re.search(r"\b(BA|BS|BSN|BFA|BSW)\b", str(program["name"])):
        without_plan += 1
        print(f"  NO PLAN: {program['name']}")
print("words:", dict(labels), "| programs with plans:", with_plan,
      "| bachelor's without:", without_plan)
