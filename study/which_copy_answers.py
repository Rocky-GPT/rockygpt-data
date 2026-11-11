"""Temporary study (never merged): when a question's best card has near-copies that score within
the lead, which of them does code answer from?

The Brain's built rule is read here on the downloaded dev graph: the best card answers, unless a
near-copy within the lead is named ahead of it for its page (card_join.page_ahead) and code can
answer from that one. Every case where the page said is not the best card's own is printed with
both answers, for the practice questions (one embedding call, a hundredth of a cent) and for a
sample of the questions the build wrote (already vectors: free).

Marks on each case: T the top-scoring card, S the card whose page is said.
"""

import collections
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from rockygpt_brain import card_answer
from rockygpt_brain.retrieval import answer_cards
from rockygpt_brain.retrieval.entity_facts import MEANING_PAST_TERM
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts

TODAY = datetime.date(2026, 11, 11)
TOP, MARGIN = card_answer.MATCH_TOP, card_answer.MATCH_MARGIN
SAMPLE = 3000
SHOWN = 45
EMBED_USD_PER_TOKEN = 0.13 / 1_000_000  # text-embedding-3-large


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
        # Never the message or a header: only the status.
        raise SystemExit(f"embeddings failed with HTTP {error.code}") from None
    rows = sorted(reply["data"], key=lambda d: d["index"])
    return [row["embedding"] for row in rows], int(reply["usage"]["total_tokens"])


facts = GraphOnlyFacts(Path(".published"))
index = facts.meaning_index()
published = facts.answer_cards()
assert index is not None and published is not None, "no index or no cards beside the release"
cards = published["cards"]
version, _, tasks, names = answer_cards.join_input(facts, TODAY)
by_key = {(t.record_id, t.key): t for t in tasks}
known = {(unit.record_id, unit.index) for unit in index.units}
card_of, passed, _, near = card_answer.tasks_of(cards, known)
nodes: dict[str, str] = {}
for unit in index.units:
    if unit.entity_ids:
        nodes.setdefault(unit.record_id, unit.entity_ids[0])
unit_at = {(u.record_id, u.index): n for n, u in enumerate(index.units)}
owner = np.asarray(index.owner, dtype=np.int64)
offsets = np.asarray(index.offsets, dtype=np.int64)
count = len(owner)
unit_card = np.full(len(index.units), -1, dtype=np.int64)
for key, at in card_of.items():
    unit_card[unit_at[key]] = at
vector_card = unit_card[owner]
in_card = vector_card >= 0
penalty = np.asarray([MEANING_PAST_TERM if at in passed else 0.0 for at in range(len(cards))],
                     dtype=np.float32)


def card_scores(values: np.ndarray, keep: np.ndarray) -> np.ndarray:
    best = np.full(len(cards), -2.0, dtype=np.float32)
    np.maximum.at(best, vector_card[keep], values[keep])
    return best - penalty


def decide(best: np.ndarray) -> tuple[int, float, float, list[int]]:
    """card_answer.best_card over an array of card scores."""
    order = np.argsort(-best)[:120].tolist()
    first, top = order[0], float(best[order[0]])
    copies = near.get(first, frozenset())
    over = [at for at in order[1:] if at in copies and top - float(best[at]) < MARGIN]
    rest = max((float(best[at]) for at in order[1:] if at not in copies), default=-1.0)
    return first, top, top - rest, over


_views: dict[int, tuple[dict | None, str | None]] = {}  # type: ignore[type-arg]


def read(at: int) -> tuple[dict | None, str | None]:  # type: ignore[type-arg]
    if at not in _views:
        try:
            view = answer_cards.view(facts, cards[at], nodes, TODAY,
                                     dataset_version=index.dataset_version,
                                     identity_hash=index.identity_hash)["card"]
            _views[at] = (view, card_answer.refusal(view))
        except Exception as error:  # noqa: BLE001  The study reads every card.
            _views[at] = (None, type(error).__name__)
    return _views[at]


def winner(at: int):  # type: ignore[no-untyped-def]
    member = cards[at]["members"][0]
    return by_key[(member["record_id"], member["key"])]


def pick(first: int, over: list[int]) -> int | None:
    """The card whose page is said (engine._card_answer); None when code does not answer."""
    if read(first)[1] is not None:
        return None
    ahead = set(cards[first].get("ahead") or ())
    for at in over:
        if cards[at]["id"] in ahead and read(at)[1] is None:
            return at
    return first


def describe(at: int, score: float, marks: str) -> str:
    card, task = cards[at], winner(at)
    view, why = read(at)
    owners = "; ".join(names[o][0] for o in card["owners"] if o in names) or "nobody"
    path = re.sub(r"^https?://[^/]+", "", task.url).rstrip("/")
    own_page = bool(set(card["owners"]) & set(task.nodes))
    head = (f"   {marks:<3} {score:.3f} [{card['status']}, {len(card['members'])}p, {task.steps}s, "
            f"updated {task.updated or '?'}, {'owner page' if own_page else 'other page'}, "
            f"notes {card.get('notes') or []}, {owners[:40]}]"
            f"{' REFUSED:' + why if why else ''}\n         {task.name!r} {path}")
    if view is None or why is not None:
        return head
    said = card_answer.say(view)[0]
    body = "\n".join(f"         | {line[:230]}" for line in said.splitlines()[:14] if line.strip())
    return f"{head}\n{body}"


def show(question: str, best: np.ndarray, extra: str = "", always: bool = False,
         ) -> tuple[bool, bool]:
    """Print one case; (whether code answers with near-copies in the lead, whether the page
    said is a near-copy's)."""
    first, top, lead, over = decide(best)
    if top < TOP or lead < MARGIN or not over:
        return False, False
    said = pick(first, over)
    if said is None:
        return False, False
    if always or said != first:
        print(f"\nQ: {question}{extra}   (lead over the rest {lead:.3f})")
        for at in [first, *over]:
            marks = ("T" if at == first else "") + ("S" if at == said else "")
            print(describe(at, float(best[at]), marks))
    return True, said != first


def unit_vector(k: int) -> np.ndarray:
    vector = index._matrix[k].astype(np.float32)
    return vector / (float(np.linalg.norm(vector)) or 1.0)


def written_questions() -> dict[int, list[str]]:
    path = Path(".meaning-cache/questions.json")
    if not path.exists():
        print("no question cache restored: cases are printed without the question's words")
        return {}
    sys.path.insert(0, "brain/scripts")
    import build_meaning_index as build
    cache = json.loads(path.read_text())
    _, _, units, _ = build.collect(facts)
    if [(u["record_id"], u["index"]) for u in units] != [
            (u.record_id, u.index) for u in index.units]:
        print("the cache's units are not the index's: no question words")
        return {}
    return {n: cache.get(build._digest(unit["heading"], unit["text"]), [])
            for n, unit in enumerate(units) if unit["entry"]}


def main() -> None:
    print(f"release {version}: {len(cards)} cards, {len(near)} with a near-copy")
    practice = json.loads((Path(__file__).parent / "practice_questions.json").read_text())
    questions = practice["questions"]
    vectors, tokens = embed([item["q"] for item in questions], index.model, index.dimensions)
    print(f"embedded {len(questions)} practice questions: {tokens} tokens, "
          f"${tokens * EMBED_USD_PER_TOKEN:.6f}")
    print("\n== PART 1: practice questions whose best card has near-copies within the lead")
    seen = differ = 0
    for item, vector in zip(questions, vectors, strict=True):
        query = np.asarray(vector, dtype=np.float32)
        query /= float(np.linalg.norm(query)) or 1.0
        had, changed = show(item["q"], card_scores(index._all_scores(query)[:count], in_card),
                            f"   (want: {item['want']})", always=True)
        seen += had
        differ += changed
    print(f"\n== PART 1 totals: {seen} cases; a near-copy's page is said in {differ}")

    words = written_questions()
    nth: dict[int, int] = {}
    counted: collections.Counter[int] = collections.Counter()
    for k in np.flatnonzero(offsets == -1).tolist():
        nth[k] = counted[int(owner[k])]
        counted[int(owner[k])] += 1

    def asked_words(k: int) -> str:
        listed = words.get(int(owner[k])) or []
        return listed[nth[k]] if nth[k] < len(listed) else "?"

    sample = np.flatnonzero(in_card & (offsets == -1))
    sample = sample[:: max(1, len(sample) // SAMPLE)].tolist()
    cases: list[tuple[int, np.ndarray, int]] = []
    tally: collections.Counter[str] = collections.Counter()
    for k in sample:
        keep = in_card.copy()
        keep[k] = False
        best = card_scores(index._all_scores(unit_vector(k))[:count], keep)
        first, top, lead, over = decide(best)
        if top < TOP or lead < MARGIN:
            continue
        said = pick(first, over)
        if said is None:
            tally["matched, not answered by code"] += 1
            continue
        own = int(vector_card[k])
        tally["answered"] += 1
        tally["top is own"] += first == own
        tally["said is own"] += said == own
        if over:
            tally["with near-copies in the lead"] += 1
        if said != first:
            tally["a near-copy's page said"] += 1
            tally["then: top is own"] += first == own
            tally["then: said is own"] += said == own
            cases.append((k, best, own))
    print(f"\n== PART 2: {len(sample)} written questions asked back (the asked one taken out)")
    print(f"   {json.dumps(dict(tally), sort_keys=True)}")
    step = max(1, len(cases) // SHOWN)
    print(f"-- cases where a near-copy's page is said: {len(cases)}; every {step}th shown")
    for k, best, own in cases[::step]:
        show(asked_words(k), best, f"   (own card's page: "
             f"{re.sub(r'^https?://[^/]+', '', winner(own).url).rstrip('/')})")


if __name__ == "__main__":
    main()
