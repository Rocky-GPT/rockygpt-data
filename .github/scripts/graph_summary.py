"""Count a built release graph's nodes and links, and optionally show named nodes' links.

The daily data workflow runs it after the graph is built, for both targets, so a dev build's
counts can be compared with production's (and with a laptop build) straight from the run log.

    python .github/scripts/graph_summary.py PUBLISHED_DIR [--show "Name one; Name two"]

A link is one relationship from a node's doc to another node (by id, or by a record that another
node links), the way the link-count reports count them. --show prints every link, in and out, of
each node whose name matches exactly (case does not matter). Each varsity team's line says how
many games and coaches its record holds, so a change in what the athletics pages give shows here.

The how-to line counts what the meaning index beside the graph can find: the tasks listed from
the office pages, the pages they are on, and the tasks that have students' questions. A release
that should carry the task lists shows it here (2026-11-11: the live graph had 0 tasks, the dev
graph 8,102).
"""

import argparse
import collections
import json
import sys
from pathlib import Path
from typing import Any

from rockygpt_brain.retrieval.graph_store import _database, _loads, ladybug_module
from rockygpt_brain.retrieval.meaning import MEANING_SUFFIX


def howto_line(meta: dict[str, Any]) -> str:
    """The how-to tasks a meaning index holds: how many, on how many pages, and how many have
    students' questions to be found by. The Brain numbers a page's tasks "e0", "e1", ... and its
    headed sections "0", "1", ...; a question's vector has offset -1 and belongs to its task. A
    task on a page no office links is not in the index, so it is not counted."""
    units = meta.get("units") or []
    tasks = {n for n, unit in enumerate(units) if str(unit[1]).startswith("e")}
    pages = {str(units[n][0]) for n in tasks}
    asked = {owner for owner, offset in zip(meta.get("owner") or [], meta.get("offsets") or [])
             if offset == -1 and owner in tasks}
    return (f"  how-to tasks: {len(tasks)} on {len(pages)} pages, {len(asked)} with students' "
            f"questions; {len(units) - len(tasks)} page sections")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--show", default="", help="node names separated by ';'")
    args = parser.parse_args(argv)

    pointer = json.loads((args.directory / "active.json").read_text())
    lb = ladybug_module()
    database = _database(lb, args.directory / pointer["file"], read_only=True)
    connection = lb.Connection(database)
    try:
        rows = list(connection.execute("MATCH (e:Entity) RETURN e.id, e.kind, e.name, e.doc"))
        teams = list(connection.execute(
            "MATCH (e:Entity)-[:HAS_RECORD]->(r:Record) WHERE r.collection = 'teams'"
            " RETURN e.name, r.doc ORDER BY e.name"))
    finally:
        connection.close()
    nodes = {row[0]: (row[1], row[2], _loads(row[3])) for row in rows}

    by_record: dict[tuple[str, str, str], str] = {}
    for node, (_, _, doc) in nodes.items():
        for link in doc.get("links") or []:
            for key in link.get("source_record_keys") or []:
                by_record.setdefault((link["collection"], link["source_key"], key), node)

    edges: list[tuple[str, str, str]] = []
    unresolved = 0
    neighbours: dict[str, set[str]] = collections.defaultdict(set)
    for node, (_, _, doc) in nodes.items():
        for relation in doc.get("relationships") or []:
            target = relation.get("target_entity_id")
            if not target and "target_record" in relation:
                record = relation["target_record"]
                target = by_record.get(
                    (record["collection"], record["source_key"], record["source_record_key"]))
            if not target or target not in nodes:
                unresolved += 1
                continue
            if target == node:
                continue
            edges.append((node, relation["type"], target))
            neighbours[node].add(target)
            neighbours[target].add(node)

    degrees = collections.Counter(len(neighbours[node]) for node in nodes)
    print(f"graph {pointer.get('dataset_version')}: {len(nodes)} nodes, {len(edges)} links, "
          f"{degrees[0]} with no link, {degrees[1]} with one link, {unresolved} unresolved")
    for kind, count in collections.Counter(kind for kind, _, _ in nodes.values()).most_common():
        print(f"  nodes {kind}: {count}")
    for kind, count in collections.Counter(kind for _, kind, _ in edges).most_common():
        print(f"  links {kind}: {count}")
    meaning = (args.directory / pointer["file"]).with_suffix(MEANING_SUFFIX)
    print(howto_line(json.loads(meaning.read_text())) if meaning.exists()
          else "  how-to tasks: no meaning index beside this graph")

    for name, doc in teams:
        record = _loads(doc)
        games = record.get("games") or []
        played = sum(1 for game in games if game.get("result"))
        coming = next((game for game in games if not game.get("result")), None)
        print(f"  team {name}: {record.get('season') or 'no season'}, {len(games)} games"
              f" ({played} with a result), {len(record.get('coaches') or [])} coaches,"
              f" record {record.get('record') or {}}"
              + (f", first unplayed {coming.get('date_label')} {coming.get('time') or 'no time'}"
                 f" {coming.get('note') or ''}".rstrip() if coming else ""))

    wanted = {name.strip().lower() for name in args.show.split(";") if name.strip()}
    for name in sorted(wanted):
        matches = [node for node, (_, label, _) in nodes.items() if (label or "").lower() == name]
        if not matches:
            print(f"show {name!r}: no node by that name")
        for node in matches:
            kind, label, _ = nodes[node]
            print(f"show {label} ({kind}):")
            for source, relation, target in edges:
                if node in (source, target):
                    print(f"  {nodes[source][1]} -[{relation}]-> {nodes[target][1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
