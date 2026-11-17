"""Check a built release graph for the facts a student must always get, and for stale sources.

The daily data workflow runs it on the graph it just built, before the graph is shared, so the
run log says what students would see tomorrow. It replaces the hand-typed list of "critical facts"
the quality step used to check in the job database (2026-11-17 audit, item 14): a fact is only
there for students if it reached the graph.

    python .github/scripts/graph_check.py PUBLISHED_DIR [--today YYYY-MM-DD]

Checks, each printed as one line:

  fresh   For every source in the graph, the newest capture of its records against the freshness
          window the source itself publishes (freshness_sla_hours). A source past its window is
          still in the graph (a day's data is never held back for one source), so it is flagged
          here. On 11-17 office hours were 25 days old and clubs 4 months old with no warning.
  must    Public Safety has a phone number, and the Library (Main Building) has hours that
          cover today (Eastern time). These are the answers no release may lose.
  menu    Today's dining menu is in the graph. Only a warning: the menu site has gaps between
          terms and on holidays.

It exits 1 when a must check fails or a source is past its window, 0 otherwise. The workflow step
is report-only for now (continue-on-error), so a failure shows as a red step without stopping the
release.
"""

import argparse
import collections
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from rockygpt_brain.retrieval.graph_store import _database, _loads, ladybug_module

EASTERN = ZoneInfo("America/New_York")
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
LIBRARY = "library (main building)"


def _day(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and len(value) >= 10:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _moment(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return None


def stale_sources(records: list[tuple[str, dict[str, Any]]], now: datetime) -> list[str]:
    """One line per source: its newest capture's age against its own freshness window. Lines for
    sources past their window start with "STALE"."""
    newest: dict[str, datetime] = {}
    window: dict[str, float] = {}
    for collection, doc in records:
        source = str(doc.get("source_key") or collection)
        collected = _moment(doc.get("collected_at"))
        if collected and (source not in newest or collected > newest[source]):
            newest[source] = collected
        sla = doc.get("freshness_sla_hours")
        if isinstance(sla, (int, float)) and sla > 0:
            window[source] = max(window.get(source, 0), float(sla))
    lines = []
    for source in sorted(newest):
        age = (now - newest[source]).total_seconds() / 3600
        limit = window.get(source)
        stale = limit is not None and age > limit
        lines.append(f"{'STALE' if stale else 'ok   '} fresh {source}: newest capture "
                     f"{newest[source]:%Y-%m-%d %H:%M}Z, {age:.0f} h old"
                     + (f", window {limit:.0f} h" if limit is not None else ", no window"))
    return lines


def has_phone(doc: dict[str, Any]) -> bool:
    if str(doc.get("phone") or "").strip():
        return True
    phones = doc.get("phones")
    return isinstance(phones, list) and any(
        str(p.get("number") if isinstance(p, dict) else p or "").strip() for p in phones)


def covers(doc: dict[str, Any], today: date) -> bool:
    start, end = _day(doc.get("valid_from")), _day(doc.get("valid_until"))
    return (start is None or start <= today) and (end is None or today <= end)


def hours_today(doc: dict[str, Any], today: date) -> str | None:
    """A campus hours row's hours for today, if the row is today's weekday and its window covers
    today. A row holds one weekday ("day") or a whole week ("schedule" with "days")."""
    weekday = WEEKDAYS[today.weekday()]
    if not covers(doc, today):
        return None
    if str(doc.get("day") or "").lower() == weekday:
        schedule = doc.get("schedule")
        return str(schedule.get("hours") if isinstance(schedule, dict) else schedule or "") or None
    for entry in doc.get("days") or []:
        if isinstance(entry, dict) and str(entry.get("day") or "").lower() == weekday:
            return str(entry.get("hours") or "") or None
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--today", type=date.fromisoformat, default=None)
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    today = args.today or now.astimezone(EASTERN).date()

    pointer = json.loads((args.directory / "active.json").read_text())
    lb = ladybug_module()
    database = _database(lb, args.directory / pointer["file"], read_only=True)
    connection = lb.Connection(database)
    try:
        rows = list(connection.execute(
            "MATCH (e:Entity)-[:HAS_RECORD]->(r:Record) RETURN e.name, r.collection, r.doc"))
        loose = list(connection.execute("MATCH (r:Record) RETURN r.collection, r.doc"))
    finally:
        connection.close()
    held: list[tuple[str, str, dict[str, Any]]] = [
        (str(name or ""), str(collection), _loads(doc)) for name, collection, doc in rows]
    records = [(str(collection), _loads(doc)) for collection, doc in loose]

    print(f"graph check {pointer.get('dataset_version')} for {today} (Eastern), "
          f"{len(records)} records")
    counts = collections.Counter(collection for collection, _ in records)
    print("  records: " + ", ".join(f"{c} {n}" for c, n in counts.most_common()))

    failed = False
    for line in stale_sources(records, now):
        failed |= line.startswith("STALE")
        print(line)

    phones = [name for name, collection, doc in held
              if "public safety" in name.lower() and collection == "contacts" and has_phone(doc)]
    failed |= not phones
    print(f"{'ok   ' if phones else 'FAIL '} must Public Safety phone: "
          + (", ".join(sorted(set(phones))) if phones else "no Public Safety contact with a phone"))

    library = sorted({hours for name, collection, doc in held
                      if collection == "campus_hours"
                      and (name.lower() == LIBRARY or str(doc.get("name") or "").lower() == LIBRARY)
                      for hours in [hours_today(doc, today)] if hours})
    failed |= not library
    print(f"{'ok   ' if library else 'FAIL '} must Library (Main Building) hours for {today}: "
          + ("; ".join(library) if library else "none cover today"))

    # A menu item's day is its validity window (menu_items valid_from/valid_until).
    menus = [doc for collection, doc in records if collection == "menu"
             and _day(doc.get("valid_from")) is not None and covers(doc, today)]
    print(f"{'ok   ' if menus else 'warn '} menu for {today}: {len(menus)} rows"
          + ("" if menus else " (the menu site may have nothing posted today)"))

    if failed:
        print("::warning::The graph check found a must-have answer missing or a stale source; "
              "see the lines marked FAIL or STALE.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
