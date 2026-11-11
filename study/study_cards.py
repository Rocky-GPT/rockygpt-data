"""Temporary study for answer cards, step 3 (never merged): how do the dev graph's how-to tasks
group across pages? Reads the downloaded graph in .published; pays for nothing, writes nothing."""

import collections
import datetime
import json
import random
import re
import sys
from pathlib import Path

import numpy

from rockygpt_brain.retrieval import answer_cards
from rockygpt_brain.retrieval import entity_facts as facts_rules
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts, read_pointer
from rockygpt_brain.retrieval.meaning import MEANING_SUFFIX, VECTORS_SUFFIX


TODAY = datetime.date(2026, 11, 11)
TERM_WORDS = set("fall spring summer winter january february march april may june july august "
                 "september october november december academic year semester ramapo college rcnj "
                 "new jersey".split())
DROP = set("the office of department dept center for ramapo college colleges and services "
           "service".split())


def office_key(name: str) -> str:
    name = re.sub(r"\([^)]*\)", " ", name.casefold().replace("&", " and ").replace("’", "'"))
    return " ".join(w for w in re.findall(r"[a-z0-9]+", name.replace("'s", "")) if w not in DROP)


def proper(name: str) -> set[str]:
    words = re.findall(r"[A-Za-z][A-Za-z.'’-]*", name)[1:]
    return {facts_rules._stem(w.casefold().strip(".'’-")) for w in words
            if w[0].isupper() and w.casefold().strip(".'’-") not in TERM_WORDS and len(w) > 1}


def context(task) -> set[str]:
    text = " ".join(str(task.get(k) or "") for k in ("task", "applies_to", "section"))
    text += " " + str(task["page"]["path"] or "").replace("-", " ").replace("/", " ")
    return {facts_rules._stem(w) for w in re.findall(r"[a-z0-9]+", text.casefold())}


def vetoed(a, b) -> bool:
    return bool(proper(a["task"]) - context(b)) and bool(proper(b["task"]) - context(a))


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
                    found = answer_cards._tasks(row)
                    units = {key: unit for key, unit, _, _ in facts_rules._procedure_units(row)}
                    updated = facts_rules.page_updated(row)
                    for item in found:
                        unit = units[item["key"]]
                        url = str(row.get("url") or "")
                        item["over"] = facts_rules.past_term(
                            f"{unit.get('term', '')} {unit['heading']} {unit['text'][:600]} {url}",
                            TODAY) or facts_rules.past_page(url, TODAY) or facts_rules.past_heading(
                            f"{unit['heading']} {unit.get('section', '')}", TODAY
                        ) or facts_rules.past_dates(f"{unit['heading']} {unit['text'][:600]}", TODAY)
                        item["old"] = facts_rules.old_page(updated, TODAY)
                    page = pages[record_id] = {**answer_cards._page(row), "nodes": [],
                                               "tasks": found}
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


def groups_at(similar, page_of, floor, link="min", top=40, veto=None, least=None):
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
        if least is not None and block.min() < least:
            continue
        if veto is not None and any(veto(x, y) for x in members[a] for y in members[b]):
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
    def show(k, steps=False):
        text = f"    {line(tasks[k], nodes)}"
        text += f"  over={tasks[k]['over']!r}" if tasks[k]["over"] else ""
        text += "  OLD" if tasks[k]["old"] else ""
        print(text[:420])
        if steps:
            for step in tasks[k]["steps"]:
                print(f"        - {step['text']}  || page: {step['quote']}"[:520])

    print("\n== terms: how many tasks name one, and the 70 most common")
    terms = collections.Counter(t.get("term") for t in tasks if t.get("term"))
    print(f"  {sum(terms.values())} tasks, {len(terms)} different terms")
    print("  " + " | ".join(f"{term} ({n})" for term, n in terms.most_common(70)))
    over = [t for t in tasks if t["over"]]
    print(f"\n== over by the Brain's rules: {len(over)} tasks; old page (3 years): "
          f"{sum(1 for t in tasks if t['old'])}; no date on the page: "
          f"{sum(1 for t in tasks if not t['page']['updated'])}; both over and old: "
          f"{sum(1 for t in tasks if t['old'] and t['over'])}")
    print("  the reasons: " + " | ".join(f"{r} ({n})" for r, n in collections.Counter(
        t["over"] for t in over).most_common(40)))
    named_over = [t for t in tasks if t.get("term") and not t["over"]]
    print("  terms on tasks NOT over: " + " | ".join(f"{r} ({n})" for r, n in collections.Counter(
        t["term"] for t in named_over).most_common(50)))
    years = collections.Counter((t["page"]["updated"] or "none")[:4] for t in tasks)
    print("  tasks by the year their page last changed: " + " ".join(
        f"{y}:{n}" for y, n in sorted(years.items())))

    print("\n== handled_by")
    keys = {}
    everyone = {**offices, **nodes}
    for entity_id, node in everyone.items():
        for name in [node["name"], *node.get("aliases", [])]:
            keys.setdefault(office_key(name), set()).add(entity_id)
    named = collections.Counter(t["handled_by"] for t in tasks if t.get("handled_by"))
    hit = {name: keys.get(office_key(name)) for name in named}
    print(f"  {sum(named.values())} tasks name one; {len(named)} different; resolved to a node: "
          f"{sum(n for name, n in named.items() if hit[name])} tasks, "
          f"{sum(1 for name in named if hit[name])} names")
    same = sum(1 for t in tasks if t.get("handled_by") and hit[t["handled_by"]]
               and hit[t["handled_by"]] & set(t["page"]["nodes"]))
    print(f"  resolved and it is the page's own node: {same}")
    print("  resolved, top 40: " + " | ".join(
        f"{name} -> {', '.join(sorted(everyone[i]['name'] for i in hit[name]))} ({n})"
        for name, n in named.most_common(400) if hit[name])[:3500])
    print("  NOT resolved, top 60: " + " | ".join(
        f"{name} ({n})" for name, n in named.most_common(2000) if not hit[name])[:3500])
    print(f"  offices in the graph: {len(offices)}; nodes linking pages: {len(nodes)}")

    plans = {
        "min 0.80": dict(floor=0.80, link="min"),
        "min 0.85": dict(floor=0.85, link="min"),
        "min 0.85 + names": dict(floor=0.85, link="min",
                                 veto=lambda x, y: vetoed(tasks[x], tasks[y])),
        "mean 0.85, least 0.78 + names": dict(floor=0.85, link="mean", least=0.78,
                                              veto=lambda x, y: vetoed(tasks[x], tasks[y])),
        "min 0.82 + names": dict(floor=0.82, link="min",
                                 veto=lambda x, y: vetoed(tasks[x], tasks[y])),
    }
    built = {}
    for name, plan in plans.items():
        members = groups_at(similar, page_of, **plan)
        built[name] = members
        sizes = sorted((len(m) for m in members.values()), reverse=True)
        joined = [n for n in sizes if n > 1]
        print(f"\n== {name}: {len(sizes)} cards, {len(joined)} join 2+ tasks "
              f"({sum(joined)} tasks), biggest {sizes[:8]}")

    apply = [i for i, t in enumerate(tasks)
             if re.search(r"^(apply|get|register|obtain|request).*parking (permit|pass)", t["task"],
                          re.I)]
    print(f"\n== {len(apply)} 'get a parking permit' tasks: how alike each pair is")
    for n, i in enumerate(apply):
        print(f"  {n:2d} {line(tasks[i], nodes)[:150]}")
    for n, i in enumerate(apply):
        print("  " + f"{n:2d} " + " ".join(f"{similar[i][j]:.2f}" if i != j else " -- "
                                           for j in apply))

    for name in ("min 0.85 + names", "mean 0.85, least 0.78 + names", "min 0.82 + names"):
        members = built[name]
        group_of = {k: g for g, ms in members.items() for k in ms}
        for pattern in (r"parking (permit|decal|pass)", r"(meal|dining) plan"):
            wanted = [i for i, t in enumerate(tasks) if re.search(pattern, t["task"], re.I)]
            seen = sorted({group_of[i] for i in wanted}, key=lambda g: -len(members[g]))
            print(f"\n== [{name}] /{pattern}/: {len(wanted)} tasks in {len(seen)} groups")
            for g in seen[:9]:
                print(f"- group of {len(members[g])}")
                for k in sorted(members[g], key=lambda k: tasks[k]["page"]["path"] or ""):
                    show(k)

    print("\n== steps of the tasks that matter for the two checks")
    for i, t in enumerate(tasks):
        path = t["page"]["path"] or ""
        if (re.search(r"^(apply|register|pick up).*parking permit", t["task"], re.I)
                and path.startswith("/publicsafety")) or re.search(
                    r"^change.*(meal|dining) plan", t["task"], re.I):
            show(i, steps=True)
    print("\n== meal or dining plan tasks whose steps name September 1")
    for i, t in enumerate(tasks):
        words = " ".join(f"{s['text']} {s['quote']}" for s in t["steps"])
        if re.search(r"(meal|dining) plan", t["task"] + words, re.I) and re.search(
                r"Sept(ember|\.)? 1(st)?\b", words):
            show(i, steps=True)

    members = built["min 0.85 + names"]
    loose = built["min 0.85"]
    loose_of = {k: g for g, ms in loose.items() for k in ms}
    group_of = {k: g for g, ms in members.items() for k in ms}
    print("\n== 25 pairs the names rule kept apart at 0.85")
    apart = []
    for g, ms in loose.items():
        for x in ms:
            for y in ms:
                if x < y and group_of[x] != group_of[y] and vetoed(tasks[x], tasks[y]):
                    apart.append((x, y))
    print(f"  {len(apart)} pairs")
    for x, y in rng.sample(apart, min(25, len(apart))):
        print(f"- {similar[x][y]:.3f}")
        show(x)
        show(y)
    print("\n== 40 random groups of 2+ (min 0.85 + names)")
    multi = sorted(g for g, ms in members.items() if len(ms) > 1)
    for g in rng.sample(multi, 40):
        block = similar[numpy.ix_(members[g], members[g])]
        print(f"- group of {len(members[g])}, least alike pair {block[block > -1].min():.3f}")
        for k in sorted(members[g], key=lambda k: tasks[k]["page"]["path"] or ""):
            show(k)


if __name__ == "__main__":
    main()
