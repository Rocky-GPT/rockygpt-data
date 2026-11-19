"""Checks the condition-pair runs by script, with no grader and no answer key (temporary, never
merged). For each answer, the games or events it names are found in the live data and each is
held to the conditions the blind writer labelled (home or away, days, a range, a clock limit, a
part of the day), using the build branch's own window code (asked_time.asked_window) on the
time the question was asked. Then the two answers of a pair are compared. Also, free: the team
pair properties on every real team in the live graph, and, for the "after" run, how often the
read filled the labelled conditions (from the trace) and how often a condition the read picked
was neither used nor named.

Run with the build branch's Brain installed: python check.py BEFORE.json AFTER.json OUT_DIR
"""

import json
import re
import sys
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from rockygpt_brain import teams as teams_module
from rockygpt_brain.asked_time import AskedTime, Window, asked_window, of
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts

CAMPUS = ZoneInfo("America/New_York")
NONE_SAID = re.compile(
    r"\bno (?:more )?(?:\w+ ){0,3}(?:events?|games?|meets?|matches)\b|\bnothing\b|"
    r"\b(?:doesn't|does not|don't|do not) (?:list|show|see|have)\b|\bnone\b|"
    r"\bisn't (?:listed|any)\b|\bno (?:\w+ ){0,2}listed\b", re.I)
CANT_CHECK = re.compile(r"can't check|cannot check|can't tell|not narrowed|wasn't sure", re.I)


def record(slots: Mapping[str, Any]) -> AskedTime | None:
    """The labelled conditions as the read's record (None when the label is off the lists)."""
    blank_day = {"weekday": "none", "month": 0, "day": 0}
    return of({
        "when": slots.get("when", "none"), "weekday": slots.get("weekday", "none"),
        "month": slots.get("month", 0), "day": slots.get("day", 0),
        "break_name": slots.get("break_name", "none"), "side": slots.get("side", "during"),
        "part_of_day": slots.get("part_of_day", "none"), "date_kind": "none", "term": "none",
        "home_away": slots.get("home_away", "any"), "about": slots.get("about"),
        "days_ahead": slots.get("days_ahead", 0),
        "through": {**blank_day, **(slots.get("through") or {})},
        "also": [{"when": "none", **blank_day, **a} for a in slots.get("also") or []],
        "clock": {"relation": "none", "hour": 0, "minute": 0, "half": "none", "to_hour": 0,
                  "to_minute": 0, "to_half": "none", **(slots.get("clock") or {})},
        "other": list(slots.get("other") or [])})


def timed(slots: Mapping[str, Any]) -> bool:
    return any(k in slots for k in ("when", "through", "also", "clock", "part_of_day",
                                    "break_name", "days_ahead"))


class Live:
    """The live graph's teams and events, read once."""

    def __init__(self, graph: Path) -> None:
        self.facts = GraphOnlyFacts(graph)
        self.engine = ChatEngine(None, self.facts, output="written")  # type: ignore[arg-type]
        version, identity_hash = self.facts.active_release()
        self.teams = self.facts.teams(version, identity_hash=identity_hash)
        self._events: dict[str, list[dict[str, Any]]] = {}

    def events(self, now: datetime) -> list[dict[str, Any]]:
        """Every event from the start of the day asked on: "today before 2", asked in the
        evening, is held to the morning's events too."""
        key = now.date().isoformat()
        if key not in self._events:
            self._events[key] = self.engine._upcoming_events(
                datetime.combine(now.date(), time(0, 0), tzinfo=now.tzinfo))
        return self._events[key]

    def breaks(self, now: datetime) -> list[tuple[str, date, date]]:
        return self.engine._breaks(now.date())


def _game_said(game: Mapping[str, Any], text: str) -> bool:
    day = teams_module._dated(game)
    if day is None or not str(game.get("opponent") or "") or str(game["opponent"]) not in text:
        return False
    return any(form in text for form in (str(game.get("date_label") or "@@"),
                                         f"{day:%b} {day.day}", f"{day:%B} {day.day}"))


def items(row: Mapping[str, Any], live: Live) -> tuple[list[str], list[str], list[str]] | None:
    """The items the answer names that fit the labels, those that do not, and every item in the
    data that fits (keys "team|date|opponent" or event titles); None when unusable."""
    picked = record(row["slots"])
    if picked is None:
        return None
    now = datetime.fromisoformat(row["asked_at"])
    window = asked_window(picked, now, live.breaks(now)) if timed(row["slots"]) else None
    text = row["answer"]
    fit, unfit, expected = [], [], []
    if row["area"] == "teams":
        named = teams_module.teams_named(row["question"], live.teams) or live.teams
        for team in named:
            for game in team.get("games") or []:
                day = teams_module._dated(game)
                if day is None or day < now.date() or game.get("result"):
                    continue
                ok = (picked.home_away == "any" or game.get("site") == picked.home_away) and (
                    window is None or teams_module._fits(game, window))
                key = f"{team.get('name')}|{game.get('date')}|{game.get('opponent')}"
                if ok:
                    expected.append(key)
                if _game_said(game, text):
                    (fit if ok else unfit).append(key)
        return fit, unfit, expected
    by_title: dict[str, list[dict[str, Any]]] = {}
    horizon = now + timedelta(days=90)
    for value in live.events(now):
        title = " ".join(str(value.get("title") or "").split())
        starts = datetime.fromisoformat(str(value["starts_at"]))
        if title and starts <= horizon:
            by_title.setdefault(title, []).append(value)
    use = window or asked_window(None, now)
    for title, values in by_title.items():
        def holds(value: dict[str, Any]) -> bool:
            from rockygpt_brain import events as events_module
            return bool(events_module.in_window([value], use.start, use.end, use))
        ok = any(holds(v) for v in values)
        if ok:
            expected.append(title)
        if len(title) >= 6 and title in text:
            (fit if ok else unfit).append(title)
    return fit, unfit, expected


def keeps(row: Mapping[str, Any], found: tuple[list[str], list[str], list[str]]) -> str:
    """"kept": every item named fits and some do, or none fit and it says none (the next one
    outside, once, allowed); else why not."""
    fit, unfit, expected = found
    none = bool(NONE_SAID.search(row["answer"]))
    if not unfit and fit:
        return "kept"
    if not expected and none and len(unfit) <= 1:
        return "kept"
    if expected and not fit and none:
        return "said_none_wrongly"
    if unfit and fit:
        return "listed_some_that_do_not_fit"
    if unfit:
        return "listed_only_ones_that_do_not_fit"
    return "named_nothing"


def window_print(picked: AskedTime | None, now: datetime, breaks: Any) -> frozenset[Any]:
    """Which 30-minute starts over the next 60 days a record accepts, and its home or away: two
    records that say the same conditions in other picks ("tonight", "today evening") match."""
    if picked is None:
        return frozenset({"none"})
    window = asked_window(picked, now, breaks)
    first = datetime.combine(now.date(), time(0, 0), tzinfo=now.tzinfo)
    starts = frozenset(k for k in range(60 * 48)
                       if window.start <= (at := first + timedelta(minutes=30 * k)) <= window.end
                       and window.holds(at, at + timedelta(minutes=1)))
    return starts | {f"site:{picked.home_away}", f"other:{bool(picked.other)}"}


def read_record(read: Mapping[str, Any] | None) -> AskedTime | None:
    if not read or not isinstance(read.get("time"), Mapping):
        return AskedTime() if read else None
    said = dict(read["time"])
    picked = record({k: v for k, v in said.items() if k not in ("date_kind", "term", "unsure")})
    if picked is not None and said.get("unsure"):
        picked = AskedTime(**{**{f: getattr(picked, f) for f in picked.__dataclass_fields__},
                              "unsure": tuple(said["unsure"])})
    return picked


def score(name: str, rows: Sequence[dict[str, Any]], live: Live) -> dict[str, Any]:
    verdicts: dict[str, str] = {}
    named: dict[str, frozenset[str]] = {}
    expected: dict[str, frozenset[str]] = {}
    unusable = []
    for row in rows:
        found = items(row, live)
        if found is None:
            unusable.append(row["id"])
            continue
        verdicts[row["id"]] = keeps(row, found)
        named[row["id"]] = frozenset(found[0] + found[1])
        expected[row["id"]] = frozenset(found[2])
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(row["group"], []).append(row)
    pairs: dict[str, str] = {}
    for gid, versions in groups.items():
        ids = [v["id"] for v in versions if v["id"] in verdicts]
        if len(ids) < 2:
            pairs[gid] = "unusable"
            continue
        kind = versions[0]["kind"]
        each_kept = all(verdicts[i] == "kept" for i in ids)
        if kind == "same_meaning":
            same = len({named[i] for i in ids}) == 1
            pairs[gid] = "pass" if same and each_kept else ("same_items" if same else "differ")
        elif kind == "change_one":
            data_differs = len({expected[i] for i in ids}) > 1
            answers_differ = len({named[i] for i in ids}) == len(ids)
            pairs[gid] = ("pass" if each_kept and (answers_differ or not data_differs)
                          else "kept_but_same_answers" if each_kept else "not_kept")
        else:
            pairs[gid] = "pass" if each_kept else "not_kept"
    other_rows = [r for r in rows if r["slots"].get("other")]
    other_named = sum(1 for r in other_rows
                      if CANT_CHECK.search(r["answer"])
                      or any(p.casefold() in r["answer"].casefold() for p in r["slots"]["other"]))
    return {"name": name, "rows": len(rows), "unusable": unusable,
            "kept": sum(1 for v in verdicts.values() if v == "kept"),
            "checked": len(verdicts), "verdicts": dict(Counter(verdicts.values())),
            "by_area": {area: f"{sum(1 for r in rows if r['area'] == area and verdicts.get(r['id']) == 'kept')}"
                              f" of {sum(1 for r in rows if r['area'] == area and r['id'] in verdicts)}"
                        for area in ("teams", "events")},
            "pairs_pass": sum(1 for p in pairs.values() if p == "pass"), "pairs": len(pairs),
            "pair_verdicts": dict(Counter(pairs.values())),
            "other_named": f"{other_named} of {len(other_rows)}",
            "by": dict(Counter(str(r.get("by")) for r in rows)),
            "errors": sum(1 for r in rows if r.get("err")),
            "per_row": {r["id"]: verdicts.get(r["id"], "unusable") for r in rows},
            "per_pair": pairs}


def reads(rows: Sequence[dict[str, Any]], live: Live) -> dict[str, Any]:
    """How often the read filled the labelled conditions (same accepted times, same home or
    away, other named or not), and how often a picked condition was neither used nor named."""
    right, wrong, silent, no_receipt = 0, [], [], []
    for row in rows:
        now = datetime.fromisoformat(row["asked_at"])
        breaks = live.breaks(now)
        label = record(row["slots"])
        got = read_record(row.get("read"))
        if got is not None and got.unsure:
            wrong.append({"id": row["id"], "why": f"unsure {list(got.unsure)}"})
        elif window_print(label, now, breaks) == window_print(got, now, breaks):
            right += 1
        else:
            wrong.append({"id": row["id"], "question": row["question"], "label": row["slots"],
                          "read": (row.get("read") or {}).get("time")})
        receipt = row.get("conditions")
        picked_any = got is not None and (got.when != "none" or got.clock.relation != "none"
                                          or got.home_away != "any" or got.other
                                          or got.part_of_day != "none")
        if picked_any and not receipt:
            no_receipt.append(row["id"])
        if receipt and (receipt.get("not_used") or receipt.get("unsure")) and (
                receipt.get("said") or "") not in row["answer"]:
            silent.append({"id": row["id"], "by": receipt.get("by"),
                           "not_used": receipt.get("not_used"), "unsure": receipt.get("unsure")})
    return {"right": right, "of": len(rows), "wrong": wrong, "silent_drops": silent,
            "picked_but_no_receipt": no_receipt}


def real_teams(live: Live, now: datetime) -> dict[str, Any]:
    """The code pair properties on every real team in the live graph (free, no model)."""
    broken: list[str] = []
    checked = 0
    for team in live.teams:
        name = str(team.get("name"))
        ahead = [g for g in team.get("games") or [] if (d := teams_module._dated(g)) is not None
                 and d >= now.date() and not g.get("result") and g.get("opponent")]
        texts = {}
        for side in ("home", "away"):
            found = teams_module.answer(f"next {name} game", [team], now.date(),
                                        picked=AskedTime(home_away=side), now=now)
            if found is None:
                continue
            checked += 1
            text = texts[side] = found[0]
            head = text.split(" [1].")[0]
            for game in ahead:
                if _game_said(game, head) and game.get("site") != side and \
                        "home or away" not in head:
                    broken.append(f"{name} {side}: lists {game.get('opponent')} ({game.get('site')})")
            if not any(g.get("site") == side for g in ahead) and f"no more {side} games" not in text:
                broken.append(f"{name} {side}: none fit but it does not say none")
        sites = {g.get("site") for g in ahead}
        if {"home", "away"} <= sites and texts.get("home") == texts.get("away"):
            broken.append(f"{name}: home and away answers are the same")
        for when in ("tonight", "this_weekend", "next_week"):
            picked = AskedTime(when=when)
            found = teams_module.answer(f"{name} games", [team], now.date(), picked=picked,
                                        now=now)
            if found is None:
                continue
            checked += 1
            window = asked_window(picked, now)
            head = found[0].split(" [1].")[0]
            for game in ahead:
                if _game_said(game, head) and not teams_module._fits(game, window) \
                        and "has no game listed" not in head:
                    broken.append(f"{name} {when}: lists {game.get('date')}")
    return {"teams": len(live.teams), "answers_checked": checked, "broken": broken}


def main() -> None:
    before_path, after_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    live = Live(Path("/".join([".published"])))
    before = json.loads(before_path.read_text())
    after = json.loads(after_path.read_text())
    pair_ids = {r["group"] for r in before["rows"]}
    report = {
        "release_before": before["release"], "release_after": after["release"],
        "before": score("before (live main)", before["rows"], live),
        "after_same_set": score("after (build branch)",
                                [r for r in after["rows"] if r["group"] in pair_ids], live),
        "after_unseen": score("after, unseen 40",
                              [r for r in after["rows"] if r["group"] not in pair_ids], live),
        "read_after": reads(after["rows"], live),
        "real_teams": real_teams(live, datetime.now(CAMPUS)),
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    lines = []
    for key in ("before", "after_same_set", "after_unseen"):
        part = report[key]
        lines.append(f"{part['name']}: kept {part['kept']} of {part['checked']} answers "
                     f"(teams {part['by_area']['teams']}, events {part['by_area']['events']}); "
                     f"pairs pass {part['pairs_pass']} of {part['pairs']}; other conditions "
                     f"named {part['other_named']}; verdicts {part['verdicts']}; pair verdicts "
                     f"{part['pair_verdicts']}; by {part['by']}; errors {part['errors']}")
    read = report["read_after"]
    lines.append(f"read filled the labelled conditions: {read['right']} of {read['of']}; "
                 f"silent drops {len(read['silent_drops'])}; picked but no receipt "
                 f"{len(read['picked_but_no_receipt'])}")
    teams_part = report["real_teams"]
    lines.append(f"real teams: {teams_part['teams']} teams, {teams_part['answers_checked']} "
                 f"answers checked, broken {len(teams_part['broken'])}")
    (out / "summary.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
