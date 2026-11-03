"""Count a built release graph's nodes and links, and optionally show named nodes' links.

The daily data workflow runs it after the graph is built, for both targets, so a dev build's
counts can be compared with production's (and with a laptop build) straight from the run log.

    python .github/scripts/graph_summary.py PUBLISHED_DIR [--show "Name one; Name two"]

A link is one relationship from a node's doc to another node (by id, or by a record that another
node links), the way the link-count reports count them. --show prints every link, in and out, of
each node whose name matches exactly (case does not matter).
"""

import argparse
import collections
import json
import sys
from pathlib import Path

from rockygpt_brain.retrieval.graph_store import _database, _loads, ladybug_module


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
