"""Temporary free check (never merged): does today's search find the page the graders cite?

For each question it ranks every how-to unit of the dev release (a page's task entries and its
headed sections, exactly the units the meaning index holds) three ways and says where the first
unit of the right page lands:

  meaning  the release's meaning index (what the Brain uses today to pick offices and sections)
  words    the asked words, each weighted by how rare it is, three times in a heading
  both     the two lists joined by reciprocal rank (k = 60), a preview of word-plus-meaning search

The right page ("gold") is either named by URL (from the graders' notes) or found by phrases the
graders said the answer left out, searched in every record of the release. The one paid call
embeds the questions (well under a tenth of a cent). No model call is made.
"""

import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

from rockygpt_brain import one_call
from rockygpt_brain.retrieval.entity_facts import _procedure_units, _procedure_words
from rockygpt_brain.retrieval.meaning import MeaningScores
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts, _loads
from rockygpt_brain.retrieval.page_marks import page_marks, page_owners

HERE = Path(__file__).parent
RRF_K = 60
CUTS = (10, 20, 30)


def norm(url: Any) -> str | None:
    if not isinstance(url, str) or not url.strip():
        return None
    u = url.strip().lower().split("#")[0].split("?")[0]
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    return u if u.endswith("/") else u + "/"


def row_url(row: dict[str, Any]) -> str | None:
    for key in ("url", "canonical_url", "source_url", "page_url", "page", "link"):
        if isinstance(row.get(key), str) and row[key].startswith("http"):
            return norm(row[key])
    return None


def embed(texts: list[str], model: str, dimensions: int) -> tuple[list[list[float]], int]:
    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps({"model": model, "input": texts, "dimensions": dimensions}).encode(),
        headers={"content-type": "application/json",
                 "authorization": "Bearer " + os.environ["BRAIN_OPENAI_API_KEY"]})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"embeddings failed with HTTP {error.code}") from None
    rows = sorted(reply["data"], key=lambda d: d["index"])
    return [row["embedding"] for row in rows], int(reply["usage"]["total_tokens"])


def first_rank(ranked: list[tuple[str, str]], unit_url: dict[tuple[str, str], str],
               gold: set[str], sections_only: bool = False) -> tuple[int | None, int | None]:
    """The rank of the first unit of a gold page, and of that page among distinct pages."""
    pages: list[str] = []
    seen: set[str] = set()
    n = 0
    for key in ranked:
        if sections_only and key[1].startswith("e"):
            continue
        n += 1
        url = unit_url.get(key)
        if url and url not in seen:
            seen.add(url)
            pages.append(url)
        if url in gold:
            return n, len(pages)
    return None, None


def main() -> None:
    facts = GraphOnlyFacts(Path(".published"))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    graph = facts._graph()
    print(f"release {graph.dataset_version}; meaning index {len(index.units)} units, "
          f"model {index.model} {index.dimensions}d")
    pointer = json.loads((Path(".published") / "active.json").read_text())
    print("build", json.dumps(pointer.get("build")))

    # Every record of the release, once, with the entities that link it.
    connection = graph._lb.Connection(graph._database)
    records: dict[str, dict[str, Any]] = {}
    for entity_id, kind, collection, record_id, doc in connection.execute(
            "MATCH (e:Entity)-[h:HAS_RECORD]->(r:Record) "
            "RETURN e.id, e.kind, h.collection, r.id, r.doc"):
        held = records.get(record_id)
        if held is None:
            row = _loads(doc)
            held = records[record_id] = {"collection": collection, "row": row,
                                         "url": row_url(row) if isinstance(row, dict) else None,
                                         "kinds": set()}
        held["kinds"].add(kind)
    connection.close()
    print(f"records {len(records)}: " + ", ".join(
        f"{c} {n}" for c, n in Counter(r["collection"] for r in records.values()).most_common()))

    # The how-to units of every linked office page (the meaning index's own units).
    unit_url: dict[tuple[str, str], str] = {}
    unit_words: dict[tuple[str, str], tuple[set[str], set[str]]] = {}
    page_text: dict[str, str] = {}
    for held in records.values():
        if held["collection"] != "office_sections":
            continue
        row = held["row"]
        rid = str(row["id"])
        try:
            units = _procedure_units(row)
            if units and units[0][0].startswith("e"):
                units = [*units, *_procedure_units(row, sections_only=True)]
        except Exception:  # noqa: BLE001  A page with no sections offers nothing.
            continue
        for key, _, top, body in units:
            unit_url[(rid, key)] = held["url"] or ""
            unit_words[(rid, key)] = (top, body)
    for (rid, key), (url, _heading) in index.labels.items():
        unit_url.setdefault((rid, key), norm(url) or "")
    searchable = {u for u in unit_url.values() if u}
    counts = Counter(k[1].startswith("e") for k in unit_words)
    print(f"word units {len(unit_words)} ({counts[True]} task entries, {counts[False]} sections) "
          f"on {len(searchable)} pages")
    doc_count = Counter()
    for top, body in unit_words.values():
        doc_count.update(top | body)
    total = len(unit_words)

    def text_of(held: dict[str, Any]) -> str:
        row = held["row"]
        if held["collection"] == "office_sections" and isinstance(row.get("sections"), list):
            return " \n".join(f"{s.get('heading') or ''}: {s.get('text') or ''}"
                              for s in row["sections"] if isinstance(s, dict))
        return json.dumps(row, ensure_ascii=False, default=str)

    texts = {rid: text_of(held) for rid, held in records.items()}

    # Each index page's marks, exactly as the index build sets them (page_marks, Brain step 1).
    links: dict[str, list[str]] = {}
    for unit in index.units:
        held_links = links.setdefault(unit.record_id, [])
        held_links += [e for e in unit.entities if e not in held_links]
    marked_rows = {rid: records[rid]["row"] for rid in links if rid in records}
    owners = page_owners({rid: links[rid] for rid in marked_rows},
                         {rid: row.get("site_folder") for rid, row in marked_rows.items()})
    marks = {rid: page_marks(row, owners.get(rid)) for rid, row in marked_rows.items()}
    import datetime as _dt
    today = _dt.date(2026, 11, 16)
    old_pages = {rid for rid, m in marks.items() if not m.current(today)}
    old_units = sum(1 for u in index.units if u.record_id in old_pages)
    print(f"\nPAGE MARKS: {len(marks)} index pages, {len(old_pages)} not current "
          f"({old_units} of {len(index.units)} units); dated {sum(1 for m in marks.values() if m.updated)}")
    print("owner differs from the first linking node on "
          f"{sum(1 for rid in marks if owners.get(rid) != links[rid][0])} pages; "
          f"pages with 2+ linking nodes {sum(1 for rid in marks if len(links[rid]) > 1)}")
    print("top owners:", Counter(owners.values()).most_common(12))
    for rid in sorted(old_pages, key=lambda r: str(records[r]["url"])):
        m = marks[rid]
        print(f"  NOT CURRENT {records[rid]['url']} until={m.until} previous={m.previous} "
              f"updated={m.updated} owner={m.owner}")
    for rid in sorted(marks, key=lambda r: str(records[r]["url"])):
        if len(links[rid]) > 1:
            print(f"  OWNER {records[rid]['url']} -> {owners.get(rid)} (links {links[rid]})")

    plain_scores = index.scores

    def current_scores(query):  # type: ignore[no-untyped-def]
        """The index's scores with not-current pages left out, as step 2's search will."""
        raw = plain_scores(query)
        kept = MeaningScores((k, v) for k, v in raw.items() if k[0] not in old_pages)
        kept.at = {k: v for k, v in raw.at.items() if k[0] not in old_pages}
        return kept
    rows = [*json.loads((HERE / "blind_rows.json").read_text()),
            *json.loads((HERE / "check_rows.json").read_text())]
    parts = [one_call.parts_of(r["question"]) for r in rows]
    flat = [t for p in parts for t in p]
    flat_vectors, tokens = embed(flat, index.model, index.dimensions)
    vectors, part_vectors, at = [], [], 0
    for p in parts:
        part_vectors.append(flat_vectors[at:at + len(p)])
        vectors.append(flat_vectors[at])
        at += len(p)
    print(f"embedded {len(rows)} questions in {len(flat)} parts, {tokens} tokens "
          f"(${tokens * 0.13 / 1_000_000:.5f} at text-embedding-3-large prices)")

    results = []
    for row, vector, pvecs in zip(rows, vectors, part_vectors, strict=True):
        scores = index.scores(vector)
        # What today's Brain reads by meaning: the two-stage read (each part's best, at most 2 a
        # page, 24 units, policies whole), and the 60-unit pool the one-writer's pick chooses from.
        read_now = one_call.with_picked(index, pvecs, MeaningScores({}), [], None)[1]
        pool_now = one_call.chosen_units(index, pvecs, one_call.POOL, per_part=one_call.POOL_PER_PART,
                                         per_page=one_call.POOL_PER_PAGE)[1]
        meaning_ranked = list(scores.keys())
        index.scores = current_scores  # type: ignore[method-assign]
        read_cur = one_call.with_picked(index, pvecs, MeaningScores({}), [], None)[1]
        pool_cur = one_call.chosen_units(index, pvecs, one_call.POOL, per_part=one_call.POOL_PER_PART,
                                         per_page=one_call.POOL_PER_PAGE)[1]
        index.scores = plain_scores  # type: ignore[method-assign]
        current_ranked = [k for k in meaning_ranked if k[0] not in old_pages]
        wanted = _procedure_words(row["question"])
        weight = {w: math.log(1 + total / doc_count[w]) for w in wanted if doc_count[w]}
        word_scored = []
        for key, (top, body) in unit_words.items():
            s = sum(3 * weight[w] for w in wanted & top if w in weight) + sum(
                weight[w] for w in wanted & body if w in weight)
            if s > 0:
                word_scored.append((-s, key))
        word_ranked = [key for _, key in sorted(word_scored)]
        fused: dict[tuple[str, str], float] = {}
        for ranked in (meaning_ranked, word_ranked):
            for n, key in enumerate(ranked, start=1):
                fused[key] = fused.get(key, 0.0) + 1 / (RRF_K + n)
        fused_ranked = sorted(fused, key=lambda k: -fused[k])
        out_facts = []
        for fact in row["facts"]:
            if "urls" in fact:
                gold = {norm(u) for u in fact["urls"]}
                where = Counter(r["collection"] for r in records.values() if r["url"] in gold)
            else:
                pats = [re.compile(p) for p in fact["needles"]]
                hits = [r for rid, r in records.items()
                        if (not fact.get("url_has") or fact["url_has"] in (r["url"] or ""))
                        and all(p.search(texts[rid]) for p in pats)]
                where = Counter(r["collection"] for r in hits)
                gold = {r["url"] for r in hits if r["url"]}
            in_search = sorted(gold & searchable)
            ranks = {}
            for name, ranked in (("meaning", meaning_ranked), ("words", word_ranked),
                                 ("both", fused_ranked)):
                ranks[name] = first_rank(ranked, unit_url, gold)
            ranks["meaning_sections"] = first_rank(meaning_ranked, unit_url, gold, True)
            ranks["both_sections"] = first_rank(fused_ranked, unit_url, gold, True)
            ranks["read_now"] = first_rank(read_now, unit_url, gold)
            ranks["pool_now"] = first_rank(pool_now, unit_url, gold)
            ranks["read_cur"] = first_rank(read_cur, unit_url, gold)
            ranks["pool_cur"] = first_rank(pool_cur, unit_url, gold)
            ranks["meaning_cur"] = first_rank(current_ranked, unit_url, gold)
            ranks["meaning_sections_cur"] = first_rank(current_ranked, unit_url, gold, True)
            out_facts.append({"gold": sorted(gold)[:6], "gold_count": len(gold),
                              "collections": dict(where), "in_search": len(in_search),
                              "ranks": ranks})
        top_pages = []
        for key in fused_ranked:
            u = unit_url.get(key)
            if u and u not in top_pages:
                top_pages.append(u)
            if len(top_pages) == 5:
                break
        results.append({**{k: row[k] for k in ("id", "set", "group")}, "facts": out_facts,
                         "top_pages_both": top_pages})

    for r in results:
        print(f"\n{r['id']} [{r['set']}/{r['group']}]")
        for f in r["facts"]:
            rk = " ".join(f"{n}={v[0]}/{v[1]}" for n, v in f["ranks"].items())
            print(f"   gold {f['gold_count']} pages ({f['in_search']} searchable) "
                  f"{json.dumps(f['collections'])} {f['gold'][:3]}")
            print(f"   rank unit/page: {rk}")
        print(f"   top pages (both): {r['top_pages_both']}")

    print("\nSUMMARY (a question counts when every fact's page is within the cut; unit rank)")
    for (s, g) in sorted({(r["set"], r["group"]) for r in results}):
        group = [r for r in results if r["set"] == s and r["group"] == g and r["facts"]]
        if not group:
            continue
        line = [f"{s}/{g}: {len(group)} questions"]
        line.append(f"gold not in graph {sum(1 for r in group if any(f['gold_count'] == 0 for f in r['facts']))}")
        line.append(f"gold not in page search {sum(1 for r in group if any(f['gold_count'] and not f['in_search'] for f in r['facts']))}")
        for name in ("read_now", "pool_now", "read_cur", "pool_cur"):
            line.append(f"{name} has it {sum(1 for r in group if all(f['ranks'][name][0] is not None for f in r['facts']))}")
        for name in ("meaning", "meaning_cur", "words", "both", "meaning_sections",
                     "meaning_sections_cur", "both_sections"):
            hits = []
            for cut in CUTS:
                hits.append(sum(1 for r in group if all(
                    f["ranks"][name][0] is not None and f["ranks"][name][0] <= cut
                    for f in r["facts"])))
            line.append(f"{name} top10/20/30 = {'/'.join(map(str, hits))}")
        print("  " + "; ".join(line))


if __name__ == "__main__":
    sys.exit(main())
