"""Step 3 of the plan "Keep student conditions in answers": sort every answer the pair check
marked as not keeping the student's conditions by WHERE the condition was lost, from the
answer's own trace (temporary, never merged). Free: reads a results folder written by pairs.py
and scored by check.py (its report.json holds each answer's verdict and the read check).

  read    the read (the model step that turns the message into picks) chose the wrong kind of
          question (topic), or its picks differ from the labels (a condition dropped or changed)
  lookup  the read kept the condition, but the path that answered never applied it (no receipt
          on that path, or the receipt says "asked, not used")
  data    the condition is one no list has a field for ("for commuters"), and the answer listed
          items without naming it
  reply   the lookup used every condition, but the answer still lists items that do not fit;
          "labelled in prose" when the answer first says none fits and the other items come
          after, labelled as later or next (the script check counts those, a reader would not)
  error   the run failed for that question

  python sort_misses.py conditions1119/results3
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

TOPICS = {"teams": {"team"}, "events": {"event", "club"}}
NONE_FIRST = re.compile(r"^(?:[^.]*?\b(?:lists? no|lists? nothing|no \w+ (?:events?|games?)|none)\b)",
                        re.I)


def only_added_other(entry: dict) -> bool:
    """The read differs from the labels only by an extra "other" phrase (the answer names it)."""
    label, read = entry.get("label") or {}, dict(entry.get("read") or {})
    if label.get("other") or not read.get("other"):
        return False
    read.pop("other")
    return all(read.get(k) == v for k, v in label.items() if k in ("when", "weekday", "home_away"))


def sort(row: dict, verdict: str, wrong: dict[str, dict]) -> str:
    if row.get("err") or row.get("by") == "error":
        return "error"
    read = row.get("read") or {}
    if read.get("topic") not in TOPICS[row["area"]]:
        return f"read: topic ({read.get('topic')})"
    if row["id"] in wrong and not only_added_other(wrong[row["id"]]):
        return "read: conditions"
    receipt = row.get("conditions")
    if not receipt:
        return "lookup: no condition lookup on this path"
    if receipt.get("not_used") or receipt.get("unsure"):
        if verdict != "dropped_other":
            return "lookup: asked, not used"
    if verdict == "dropped_other":
        return "data: no field"
    if NONE_FIRST.search(" ".join(row["answer"].split())[:300]):
        return "reply: labelled in prose"
    return "reply"


def main(folder: str) -> None:
    root = Path(folder)
    report = json.loads((root / "report.json").read_text())
    rows = {r["id"]: r for r in json.loads((root / "after.json").read_text())["rows"]}
    wrong = {w["id"]: w for w in report["read_after"]["wrong"]}
    out: dict = {"misses": {}, "read_differed_but_kept": []}
    for part in ("after_same_set", "after_unseen"):
        sorted_part = []
        for rid, verdict in report[part]["per_row"].items():
            if verdict == "kept":
                if rid in wrong:
                    out["read_differed_but_kept"].append(rid)
                continue
            kind = sort(rows[rid], verdict, wrong)
            sorted_part.append({"id": rid, "verdict": verdict, "where": kind,
                                "by": rows[rid].get("by"), "question": rows[rid]["question"]})
        out["misses"][part] = sorted_part
        counts = Counter(m["where"].split(":")[0] for m in sorted_part)
        print(f"{part}: {len(sorted_part)} misses of {len(report[part]['per_row'])}; "
              f"{dict(counts)}")
        for m in sorted_part:
            print(f"  {m['id']:6} {m['where']:42} {m['verdict']:34} {m['question'][:60]}")
    print(f"read differed from the labels but the answer kept the conditions: "
          f"{len(out['read_differed_but_kept'])} {out['read_differed_but_kept']}")
    (root / "where-lost.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1])
