"""Step 3 of the plan "Keep student conditions in answers": the wider pair check (hours,
shuttle, menus, academic dates, people), by script, counts only (temporary, never merged).
For each answer: did the read pick the right kind of question (topic), did its time picks match
the labelled days and clock (same 30-minute starts accepted, as check.py), does the answer say
each labelled condition back, and does the path that answered write a receipt. For each pair:
change one condition, the two answers must differ; nothing fits, the answer must say no.
These flags pick the answers to read; where each lost condition was lost is then read by hand
(where-lost-wider.json). Run with the dev Brain installed and the live graph in .published:

  python check_wider.py conditions1119/results-wider
"""

import json
import re
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any

from check import Live, plain, read_record, record, window_print

TOPICS = {"hours": {"office", "dining"}, "shuttle": {"shuttle"}, "menus": {"dining"},
          "academic_dates": {"dates"}, "people": {"person", "office", "program"}}
TIME_SLOTS = ("when", "weekday", "month", "day", "break_name", "side", "part_of_day", "clock")
RELATION = {"until": "before", "by": "before", "at": "around"}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
SAYS_NO = re.compile(r"\b(?:no|not|isn't|aren't|doesn't|don't|closed|none|nothing|no longer)\b",
                     re.I)
STOP = frozenset("the a an of to for in on at and or my one class course section dept "
                 "department".split())


def time_label(slots: dict[str, Any]) -> dict[str, Any] | None:
    picked = {k: v for k, v in slots.items() if k in TIME_SLOTS}
    if not picked:
        return None
    if "clock" in picked:
        clock = dict(picked["clock"])
        clock["relation"] = RELATION.get(clock.get("relation"), clock.get("relation"))
        picked["clock"] = clock
    return picked


def clock_forms(clock: dict[str, Any]) -> list[str]:
    hour = int(clock.get("hour") or 0)
    if hour == 12:
        return ["noon", "12", "midnight"]
    return [f"{hour}:", f"{hour} ", f"{hour}am", f"{hour}pm", f"{hour} a", f"{hour} p"]


def said(slot: str, value: Any, answer: str, now: datetime) -> bool | None:
    """Whether the answer names a labelled condition (None: not checked by script)."""
    text = plain(answer).casefold()
    if slot == "when":
        return None  # Checked through the weekday or date words below.
    if slot == "weekday":
        return str(value) in text
    if slot == "clock":
        return any(form in text for form in clock_forms(value))
    if slot in ("meal", "diet"):
        word = {"late_night": "late", "gluten_free": "gluten", "dairy_free": "dairy"}.get(
            str(value), str(value))
        return word in text
    if slot == "term":
        return str((value or {}).get("season") or "").casefold() in text
    if slot in ("date_kinds", "course", "destination", "role", "place"):
        phrases = value if isinstance(value, list) else [value]
        found = []
        for phrase in phrases:
            words = [w for w in re.findall(r"[a-z0-9]+", str(phrase).casefold())
                     if w not in STOP and len(w) > 2]
            found.append(not words or sum(w[:5] in text for w in words) * 2 >= len(words))
        return all(found)
    if slot == "break_name":
        return str(value) in text
    if slot == "part_of_day":
        return {"evening": ("evening", "night", "pm"), "morning": ("morning", "am"),
                "afternoon": ("afternoon", "pm")}[str(value)][0] in text or any(
            w in text for w in {"evening": ("tonight", "night"), "morning": ("a.m", "am "),
                                "afternoon": ("p.m", "pm ")}[str(value)])
    return None


def one(row: dict[str, Any], live: Live) -> dict[str, Any]:
    now = datetime.fromisoformat(row["asked_at"])
    read = row.get("read") or {}
    label = time_label(row["slots"])
    read_ok = None
    if label is not None:
        breaks = live.breaks(now)
        got = read_record(read)
        want = record(label)
        read_ok = (got is not None and not got.unsure
                   and window_print(want, now, breaks) - {"site:any", "other:False", "other:True"}
                   == window_print(got, now, breaks) - {"site:any", "other:False", "other:True"})
    checks = {slot: said(slot, value, row["answer"], now) for slot, value in row["slots"].items()}
    return {"id": row["id"], "group": row["group"], "kind": row["kind"], "area": row["area"],
            "question": row["question"], "slots": row["slots"],
            "topic": read.get("topic"), "topic_ok": read.get("topic") in TOPICS[row["area"]],
            "read_time": read.get("time"), "read_time_ok": read_ok,
            "said": {k: v for k, v in checks.items() if v is not None},
            "receipt": row.get("conditions"), "by": row.get("by"), "err": row.get("err"),
            "path": row.get("path"), "answer": row["answer"]}


def main(folder: str) -> None:
    root = Path(folder)
    data = json.loads((root / "after.json").read_text())
    live = Live(Path(".published"))
    rows = [one(r, live) for r in data["rows"]]
    groups: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        groups.setdefault(r["group"], []).append(r)
    pairs = {}
    for gid, versions in groups.items():
        kind = versions[0]["kind"]
        texts = {" ".join(plain(v["answer"]).split()).casefold() for v in versions}
        if kind == "change_one":
            pairs[gid] = "differ" if len(texts) == len(versions) else "same_answer"
        elif kind == "nothing_fits_likely":
            pairs[gid] = "says_no" if all(SAYS_NO.search(v["answer"]) for v in versions) else "no_no"
        else:
            pairs[gid] = "-"
    flags = Counter()
    for r in rows:
        flags["topic_wrong"] += not r["topic_ok"]
        flags["read_time_wrong"] += r["read_time_ok"] is False
        flags["condition_not_said"] += any(v is False for v in r["said"].values())
        flags["no_receipt"] += not r["receipt"]
        flags["errors"] += bool(r["err"]) or r["by"] == "error"
    by_area = {area: dict(Counter(
        "flagged" if (not r["topic_ok"] or r["read_time_ok"] is False
                      or any(v is False for v in r["said"].values())) else "clean"
        for r in rows if r["area"] == area)) for area in TOPICS}
    report = {"release": data["release"], "rows": len(rows), "flags": dict(flags),
              "pairs": dict(Counter(pairs.values())), "per_pair": pairs, "by_area": by_area,
              "by": dict(Counter(str(r["by"]) for r in rows)), "per_row": rows}
    (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k not in ("per_row", "per_pair")},
                     indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
