"""One-off check (tool review 2026-11-18, item 4): would a keyword search (SQLite FTS5, built into
Python) beside the Brain's meaning search reach more of the pages the graders keyed?

For each keyed question whose key names a page the section index holds, it asks: is one of the
key's pages among the 20 sections (at most 2 a page) read by meaning alone, by keywords alone, and
by the two merged (reciprocal rank fusion)? Meaning uses the whole question only (the Brain also
embeds the question's parts), so its count is a floor. Costs one embedding per question (~$0.001).

python scripts/review/keyword_reach.py GRAPH_DIR QUESTIONS.json
"""
import json, re, sqlite3, sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "brain" / "scripts"))
from build_meaning_index import collect  # noqa: E402
from openai import OpenAI  # noqa: E402
from rockygpt_brain.retrieval.graph_store import POINTER, GraphOnlyFacts  # noqa: E402
from rockygpt_brain.retrieval.meaning import MeaningIndex  # noqa: E402
from rockygpt_brain.retrieval.section_search import sections, _current  # noqa: E402

CAP, PER_PAGE = 20, 2
STOP = set("""a an the and or of to in on for at by with from is are was were be been am i im i'm
me my we our you your u ur it its this that these those do does did can could would should will
what whats what's who whos who's when where how why which there their they them he she his her
if so but not no yes just like get got any some about into out up down over than then too very
pls plz please hey hi yo lol idk tho n wanna gonna need know tell anyone ramapo rcnj""".split())


def page(url: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", url.strip()).split("#")[0].split("?")[0].rstrip("/").lower()


def words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOP and len(w) > 1]


def pick(ranked, url_of, today, index):
    chosen, per = [], {}
    for key in ranked:
        if key[1].startswith("e") or not _current(index, key[0], today):
            continue
        p = url_of.get(key)
        if per.get(p, 0) >= PER_PAGE:
            continue
        per[p] = per.get(p, 0) + 1
        chosen.append(key)
        if len(chosen) == CAP:
            break
    return chosen


def main() -> None:
    graph_dir, questions_file = Path(sys.argv[1]), Path(sys.argv[2])
    release = graph_dir / json.loads((graph_dir / POINTER).read_text())["file"]
    index = MeaningIndex.load(release)
    _, _, units, _ = collect(GraphOnlyFacts(graph_dir))
    url_of = {(u["record_id"], u["index"]): page(u["page"]) for u in units}
    pages = set(url_of.values())
    db = sqlite3.connect(":memory:")
    db.execute("CREATE VIRTUAL TABLE s USING fts5(rid UNINDEXED, idx UNINDEXED, heading, text,"
               " tokenize='porter unicode61')")
    db.executemany("INSERT INTO s VALUES (?,?,?,?)", [
        (u["record_id"], u["index"], u["heading"], u["text"]) for u in units if not u["entry"]])
    rows = json.loads(questions_file.read_text())
    client, today = OpenAI(), date.today()
    tally = {"asked": 0, "meaning": 0, "keywords": 0, "merged": 0, "only_keywords": 0, "only_meaning": 0}
    by_area: dict[str, dict[str, int]] = {}
    for row in rows:
        keyed = {page(u) for u in str(row.get("source", "")).split(";") if "http" in u}
        keyed &= pages
        if not keyed:
            continue
        vector = client.embeddings.create(model=index.model, input=row["question"],
                                          dimensions=index.dimensions).data[0].embedding
        meaning_rank = list(sections(index, [vector], today)[1])
        terms = words(row["question"])
        kw_rank: list[tuple[str, str]] = []
        if terms:
            match = " OR ".join(f'"{t}"' for t in terms)
            kw_rank = [(r, i) for r, i in db.execute(
                "SELECT rid, idx FROM s WHERE s MATCH ? ORDER BY bm25(s, 0, 0, 3.0, 1.0) LIMIT 400",
                (match,))]
        raw_meaning = list(index.scores(vector))
        fused: dict[tuple[str, str], float] = {}
        for rank_list in (raw_meaning[:400], kw_rank):
            for n, key in enumerate(rank_list):
                fused[key] = fused.get(key, 0.0) + 1.0 / (60 + n)
        merged = pick(sorted(fused, key=fused.__getitem__, reverse=True), url_of, today, index)
        kw = pick(kw_rank, url_of, today, index)
        got = {name: bool(keyed & {url_of.get(k) for k in keys})
               for name, keys in (("meaning", meaning_rank), ("keywords", kw), ("merged", merged))}
        area = by_area.setdefault(row.get("area", "?"), {"asked": 0, "meaning": 0, "keywords": 0, "merged": 0})
        tally["asked"] += 1
        area["asked"] += 1
        for name, hit in got.items():
            tally[name] += hit
            area[name] += hit
        tally["only_keywords"] += got["keywords"] and not got["meaning"]
        tally["only_meaning"] += got["meaning"] and not got["keywords"]
        print(f"{row['id']:<14} meaning {'Y' if got['meaning'] else '-'} keywords "
              f"{'Y' if got['keywords'] else '-'} merged {'Y' if got['merged'] else '-'}")
    print(json.dumps({"all": tally, "by_area": by_area}, indent=1))


if __name__ == "__main__":
    main()
