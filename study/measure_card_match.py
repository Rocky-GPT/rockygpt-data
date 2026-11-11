"""Temporary study for answer cards, step 4 (never merged): when does one card clearly match a
question? Reads the downloaded dev graph's meaning index and cards.

Part 1 pays for nothing: every task's written questions are already vectors in the index, so one
is taken out and asked as if a student typed it ("easy": only that vector is taken out; "gone":
every vector of its whole card is taken out, so the right card does not exist). Where the build's
question cache was restored, the fires on another card are printed with the question's words, to
be judged by reading.

Part 2 embeds the practice questions (one call, a fraction of a cent) and prints each one's best
cards.

A card's score is its best vector's, less the how-to read's own penalty for a term that is over
(MEANING_PAST_TERM) on a card whose date has passed, so today's card ranks above last year's. An
old page is not marked down: the second run did, and it cost the counseling card its lead over
its own neighbours for no gain (a card on an old page has no newer page to lose to).
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
SAMPLE = 3000
TOPS = (0.70, 0.75, 0.80, 0.85)
MARGINS = (0.0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.15)
RULES = ((0.80, 0.04), (0.80, 0.06), (0.80, 0.08), (0.80, 0.10), (0.75, 0.08), (0.85, 0.08))
SHOWN = (0.80, 0.08)  # The rule whose fires are printed for reading.
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


def grid(title: str, rows: list[tuple[bool, float, float]], gone: bool = False) -> None:
    """rows: (the top card is the question's own, top score, top minus second)."""
    print(f"\n-- {title}: {len(rows)} questions; "
          + ("share that fires (the right card does not exist)" if gone
             else "share that fires / of those, share whose card is the question's own"))
    print("top>=   " + "".join(f"margin>={m:<9.2f}" for m in MARGINS))
    for top in TOPS:
        cells = []
        for margin in MARGINS:
            fired = [right for right, score, gap in rows if score >= top and gap >= margin]
            share = 100 * len(fired) / len(rows)
            cells.append(f"{share:5.1f}%        " if gone or not fired
                         else f"{share:5.1f}% /{100 * sum(fired) / len(fired):5.1f}% ")
        print(f"{top:<8.2f}" + "".join(cells))


def written_questions(facts: GraphOnlyFacts, index) -> dict[int, list[str]]:  # type: ignore[no-untyped-def]
    """Each unit's written questions, in the order of its question vectors, from the build's
    question cache; empty when the cache was not restored."""
    path = Path(".meaning-cache/questions.json")
    if not path.exists():
        print("no question cache restored: fires are printed without the question's words")
        return {}
    sys.path.insert(0, "brain/scripts")
    import build_meaning_index as build
    cache = json.loads(path.read_text())
    _, _, units, _ = build.collect(facts)
    assert [(u["record_id"], u["index"]) for u in units] == [
        (u.record_id, u.index) for u in index.units], "the cache's units are not the index's"
    found = {n: cache.get(build._digest(unit["heading"], unit["text"]), [])
             for n, unit in enumerate(units) if unit["entry"]}
    print(f"question cache: {len(cache)} entries; {sum(1 for q in found.values() if q)} of "
          f"{len(found)} tasks have their questions' words")
    return found


def main() -> None:
    directory = Path(".published")
    facts = GraphOnlyFacts(directory)
    index = facts.meaning_index()
    found = facts.answer_cards()
    assert index is not None and found is not None, "no index or no cards beside the release"
    version, _, tasks, names = answer_cards.join_input(facts, TODAY)
    by_key = {(t.record_id, t.key): t for t in tasks}
    cards = found["cards"]
    print(f"release {version}; {len(cards)} cards; {len(tasks)} tasks; index {index.model} "
          f"{index.dimensions} dims, {len(index.units)} units, {len(index.owner)} vectors")

    unit_at = {(u.record_id, u.index): n for n, u in enumerate(index.units)}
    unit_card = np.full(len(index.units), -1, dtype=np.int64)
    for at, card in enumerate(cards):
        for member in card["members"]:
            unit_card[unit_at[(member["record_id"], member["key"])]] = at
    owner = np.asarray(index.owner, dtype=np.int64)
    offsets = np.asarray(index.offsets, dtype=np.int64)
    count = len(owner)
    vector_card = unit_card[owner]
    in_card = vector_card >= 0
    penalty = np.asarray(
        [MEANING_PAST_TERM if card["status"] == "date_passed" else 0.0 for card in cards],
        dtype=np.float32)
    print(f"cards marked down as passed: {int((penalty > 0).sum())}")

    def winner(at: int):  # type: ignore[no-untyped-def]
        member = cards[at]["members"][0]
        return by_key[(member["record_id"], member["key"])]

    def name(at: int) -> str:
        card, task = cards[at], winner(at)
        path = re.sub(r"^https?://[^/]+", "", task.url).rstrip("/")
        owners = "; ".join(names[o][0] for o in card["owners"] if o in names) or "nobody"
        return (f"[{card['status']}, {len(card['members'])}p, {task.steps}s, {owners[:40]}] "
                f"{task.name!r} {path}")

    def answerable(at: int) -> bool:
        return (cards[at]["status"] in ("ready", "date_passed")
                and winner(at).steps <= card_answer.MAX_STEPS)

    def card_scores(values: np.ndarray, keep: np.ndarray) -> np.ndarray:
        best = np.full(len(cards), -2.0, dtype=np.float32)
        np.maximum.at(best, vector_card[keep], values[keep])
        return best - penalty

    def top_two(best: np.ndarray) -> tuple[int, float, float]:
        first = int(best.argmax())
        score = float(best[first])
        best[first] = -3.0
        return first, score, float(best.max())

    def unit_vector(k: int) -> np.ndarray:
        vector = index._matrix[k].astype(np.float32)
        return vector / (float(np.linalg.norm(vector)) or 1.0)

    # Part 1: written questions asked back, one in every few so about SAMPLE are asked.
    words = written_questions(facts, index)
    nth: dict[int, int] = {}
    seen: collections.Counter[int] = collections.Counter()
    for k in np.flatnonzero(offsets == -1).tolist():
        nth[k] = seen[int(owner[k])]
        seen[int(owner[k])] += 1

    def asked_words(k: int) -> str:
        listed = words.get(int(owner[k])) or []
        return listed[nth[k]] if nth[k] < len(listed) else "?"

    asked = np.flatnonzero(in_card & (offsets == -1))
    asked = asked[:: max(1, len(asked) // SAMPLE)]
    easy, gone = [], []
    other_fires: list[str] = []
    gone_fires: list[str] = []
    for k in asked.tolist():
        values = index._all_scores(unit_vector(k))[:count]
        own = int(vector_card[k])
        keep = in_card.copy()
        keep[k] = False
        first, score, second = top_two(card_scores(values, keep))
        easy.append((first == own, score, score - second))
        if first != own and score >= SHOWN[0] and score - second >= SHOWN[1] and answerable(first):
            other_fires.append(f"Q: {asked_words(k)}\n     own: {name(own)}\n     top: "
                               f"{score:.3f} +{score - second:.3f} {name(first)}")
        keep = in_card & (vector_card != own)
        first, score, second = top_two(card_scores(values, keep))
        gone.append((False, score, score - second))
        if score >= SHOWN[0] and score - second >= SHOWN[1] and answerable(first):
            gone_fires.append(f"Q: {asked_words(k)}\n     own (taken out): {name(own)}\n     "
                              f"top: {score:.3f} +{score - second:.3f} {name(first)}")
    grid("EASY (only the asked question taken out)", easy)
    grid("GONE (the whole right card taken out)", gone, gone=True)
    for title, fires in (("EASY fires on another card", other_fires),
                         ("GONE fires", gone_fires)):
        step = max(1, len(fires) // 45)
        print(f"\n-- {title} at top>={SHOWN[0]} margin>={SHOWN[1]}, cards code can answer from: "
              f"{len(fires)} of {len(asked)}; every {step}th shown")
        for line in fires[::step]:
            print(line)

    # Part 2: the practice questions.
    practice = json.loads((Path(__file__).parent / "practice_questions.json").read_text())
    questions = practice["questions"]
    vectors, tokens = embed([item["q"] for item in questions], index.model, index.dimensions)
    print(f"\nembedded {len(questions)} practice questions: {tokens} tokens, "
          f"${tokens * EMBED_USD_PER_TOKEN:.6f}")
    rows = []
    for item, vector in zip(questions, vectors, strict=True):
        query = np.asarray(vector, dtype=np.float32)
        query /= float(np.linalg.norm(query)) or 1.0
        values = index._all_scores(query)[:count]
        best = card_scores(values, in_card)
        order = np.argsort(-best)[:4].tolist()
        top, second = float(best[order[0]]), float(best[order[1]])
        task = winner(order[0])
        want = item["want"]
        right = (None if want is None
                 else bool(re.search(want, f"{task.name} {task.url}", re.IGNORECASE)))
        rows.append((item["q"], want is not None, right, top, top - second,
                     answerable(order[0]), name(order[0])))
        print(f"\nQ: {item['q']}   (want: {want})")
        print(f"   top {top:.3f}  margin {top - second:.3f}  best section "
              f"{float(values[~in_card].max()):.3f}  topic right: {right}  "
              f"code could answer: {answerable(order[0])}")
        for at in order:
            print(f"   {float(best[at]):.3f} {name(at)}")

    for top, margin in RULES:
        fired = [row for row in rows if row[3] >= top and row[4] >= margin and row[5]]
        should = [row for row in fired if row[1]]
        print(f"\n-- practice set, rule top>={top} margin>={margin}: fires on {len(should)} of "
              f"{sum(1 for row in rows if row[1])} how-to questions (topic right for "
              f"{sum(1 for row in should if row[2])}) and on {len(fired) - len(should)} of "
              f"{sum(1 for row in rows if not row[1])} look-alikes")
        if (top, margin) == SHOWN:
            for row in fired:
                print(f"   {'how-to    ' if row[1] else 'look-alike'} {row[3]:.3f} +{row[4]:.3f} "
                      f"{row[0]!r} -> {row[6]}")


if __name__ == "__main__":
    main()
