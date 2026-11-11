"""Temporary study for answer cards, step 3 (never merged): how do the dev graph's how-to tasks
group across pages? Reads the downloaded graph in .published; pays for nothing, writes nothing."""

import json
import random
import re
import sys
from pathlib import Path

import numpy

from rockygpt_brain.retrieval import answer_cards
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts, read_pointer
from rockygpt_brain.retrieval.meaning import MEANING_SUFFIX, VECTORS_SUFFIX


def load(directory: Path):
    pointer = read_pointer(directory)
    facts = GraphOnlyFacts(directory)
    pages, nodes = {}, {}
    with facts.snapshot() as snapshot:
        for entity in snapshot.entities:
            if not answer_cards._links_pages(entity):
                continue
            for row in answer_cards._pages(snapshot, entity):
                record_id = str(row["id"])
                page = pages.get(record_id)
                if page is None:
                    page = pages[record_id] = {**answer_cards._page(row), "nodes": [],
                                               "tasks": answer_cards._tasks(row)}
                if entity["id"] not in page["nodes"]:
                    page["nodes"].append(entity["id"])
                nodes[entity["id"]] = {"name": entity["name"], "kind": entity["kind"],
                                       "aliases": list(entity.get("aliases") or [])}
        offices = {e["id"]: {"name": e["name"], "aliases": list(e.get("aliases") or [])}
                   for e in snapshot.entities if e.get("kind") == "office"}
    release_file = directory / pointer["file"]
    meta = json.loads(release_file.with_suffix(MEANING_SUFFIX).read_text())
    flat = numpy.fromfile(release_file.with_suffix(VECTORS_SUFFIX), dtype=numpy.float32)
    dims = meta["dimensions"]
    owner, offsets = numpy.array(meta["owner"]), numpy.array(meta["offsets"])
    vectors = flat[:len(owner) * dims].reshape(len(owner), dims)
    unit_at = {(str(u[0]), str(u[1])): n for n, u in enumerate(meta["units"])}
    by_unit = {}
    for at, (unit, offset) in enumerate(zip(owner.tolist(), offsets.tolist(), strict=True)):
        by_unit.setdefault(unit, []).append((offset, at))
    tasks, opening, asked = [], [], []
    for record_id in sorted(pages):
        page = pages[record_id]
        for task in page["tasks"]:
            n = unit_at.get((record_id, task["key"]))
            if n is None:
                continue
            first = next(at for offset, at in by_unit[n] if offset == 0)
            questions = [at for offset, at in by_unit[n] if offset == -1]
            mean = vectors[questions].mean(axis=0) if questions else vectors[first]
            tasks.append({**task, "page": page})
            opening.append(vectors[first])
            asked.append(mean / (numpy.linalg.norm(mean) or 1.0))
    return tasks, numpy.array(opening), numpy.array(asked), nodes, offices


def groups_at(similar, page_of, floor, link="min", top=40):
    """Greedy joining, most alike pair first. Two tasks of one page never share a group; a join
    needs every pair (link="min") or the average pair (link="mean") at or above `floor`."""
    count = len(page_of)
    pairs = []
    for i in range(count):
        row = similar[i]
        near = numpy.argpartition(-row, top)[:top]
        pairs += [(float(row[j]), i, int(j)) for j in near if j > i and row[j] >= floor]
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))
    group_of = list(range(count))
    members = {i: [i] for i in range(count)}
    pages_in = {i: {page_of[i]} for i in range(count)}
    for _, i, j in pairs:
        a, b = group_of[i], group_of[j]
        if a == b or pages_in[a] & pages_in[b]:
            continue
        block = similar[numpy.ix_(members[a], members[b])]
        if (block.min() if link == "min" else block.mean()) < floor:
            continue
        if len(members[a]) < len(members[b]):
            a, b = b, a
        for k in members[b]:
            group_of[k] = a
        members[a] += members.pop(b)
        pages_in[a] |= pages_in.pop(b)
    return members


def line(task, nodes):
    page = task["page"]
    who = "; ".join(nodes[n]["name"] for n in page["nodes"])[:60]
    bits = [f"{task['task']!r}", f"{page['path']}", f"[{who}]"]
    for field in ("applies_to", "handled_by", "term"):
        if task.get(field):
            bits.append(f"{field}={task[field]!r}")
    bits.append(f"changed={page['updated'] or '-'}")
    bits.append(f"{len(task['steps'])} steps")
    return "  ".join(bits)


def main() -> None:
    tasks, opening, asked, nodes, offices = load(Path(".published"))
    count = len(tasks)
    page_of = [t["page"]["record_id"] for t in tasks]
    print(f"{count} tasks on {len(set(page_of))} pages")
    numbers = {page: n for n, page in enumerate(dict.fromkeys(page_of))}
    page_number = numpy.array([numbers[page] for page in page_of])
    same_page = page_number[:, None] == page_number[None, :]
    for name, matrix in (("asked", asked), ("opening", opening)):
        similar = matrix @ matrix.T
        similar[same_page] = -1.0
        nearest = similar.max(axis=1)
        print(f"\n== {name}: the nearest task on another page, by percentile")
        print("  " + "  ".join(f"p{p}={numpy.percentile(nearest, p):.3f}"
                               for p in (5, 10, 25, 50, 75, 90, 95, 99)))
        if name == "opening":
            continue
        kept = similar
    similar = kept
    rng = random.Random(7)
    print("\n== 12 random tasks and their 6 nearest on other pages (asked vectors)")
    for i in rng.sample(range(count), 12):
        print(f"\n* {line(tasks[i], nodes)}")
        for j in numpy.argsort(-similar[i])[:6]:
            print(f"    {similar[i][j]:.3f}  {line(tasks[j], nodes)}")
    for link in ("min", "mean"):
        for floor in (0.70, 0.75, 0.80, 0.85, 0.90):
            members = groups_at(similar, page_of, floor, link)
            sizes = sorted((len(m) for m in members.values()), reverse=True)
            joined = [s for s in sizes if s > 1]
            print(f"\n== link={link} floor={floor}: {len(sizes)} cards, {len(joined)} join 2+ "
                  f"tasks ({sum(joined)} tasks), biggest {sizes[:8]}")
    members = groups_at(similar, page_of, 0.80, "min")
    group_of = {k: g for g, ms in members.items() for k in ms}
    for pattern in (r"parking (permit|decal)|register.*vehicle", r"meal plan",
                    r"retak|repeat.*course", r"transcript", r"withdraw"):
        wanted = [i for i, t in enumerate(tasks) if re.search(pattern, t["task"], re.I)]
        seen = sorted({group_of[i] for i in wanted}, key=lambda g: -len(members[g]))
        print(f"\n== /{pattern}/: {len(wanted)} tasks in {len(seen)} groups (min link, 0.80)")
        for g in seen[:14]:
            print(f"- group of {len(members[g])}")
            for k in sorted(members[g], key=lambda k: tasks[k]["page"]["path"] or ""):
                print(f"    {line(tasks[k], nodes)}")
    print("\n== 25 random groups of 2+ (min link, 0.80)")
    multi = sorted(g for g, ms in members.items() if len(ms) > 1)
    for g in rng.sample(multi, 25):
        block = similar[numpy.ix_(members[g], members[g])]
        low = block[block > -1].min()
        print(f"- group of {len(members[g])}, least alike pair {low:.3f}")
        for k in sorted(members[g], key=lambda k: tasks[k]["page"]["path"] or ""):
            print(f"    {line(tasks[k], nodes)}")


if __name__ == "__main__":
    main()
