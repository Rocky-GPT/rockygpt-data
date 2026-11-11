"""Temporary study for answer cards, step 4 (never merged): when does one card clearly match a
question? Reads the downloaded dev graph's meaning index and cards.

Part 1 pays for nothing: every task's written questions are already vectors in the index, so one
is taken out and asked as if a student typed it. Three ways: only that one vector taken out
("easy"), all of its task's written questions taken out ("hard": the card must be found by the
task's own page words or by its other pages), and every vector of its whole card taken out
("gone": the right card does not exist, so any card that fires is a wrong answer).

Part 2 embeds the practice questions (one call, a fraction of a cent) and prints each one's best
cards.
"""

import collections
import datetime
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from rockygpt_brain import card_answer
from rockygpt_brain.retrieval import answer_cards
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts

TODAY = datetime.date(2026, 11, 11)
SAMPLE = 3000
TOPS = (0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80)
MARGINS = (0.0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.15)
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
          + ("share that fires (every fire is wrong)" if gone
             else "share that fires / of those, share whose card is the right one"))
    print("top>=   " + "".join(f"margin>={m:<9.2f}" for m in MARGINS))
    for top in TOPS:
        cells = []
        for margin in MARGINS:
            fired = [right for right, score, gap in rows if score >= top and gap >= margin]
            share = 100 * len(fired) / len(rows)
            cells.append(f"{share:5.1f}%        " if gone or not fired
                         else f"{share:5.1f}% /{100 * sum(fired) / len(fired):5.1f}% ")
        print(f"{top:<8.2f}" + "".join(cells))


def main() -> None:
    directory = Path(".published")
    facts = GraphOnlyFacts(directory)
    index = facts.meaning_index()
    found = facts.answer_cards()
    assert index is not None and found is not None, "no index or no cards beside the release"
    version, _, tasks, _names = answer_cards.join_input(facts, TODAY)
    by_key = {(t.record_id, t.key): t for t in tasks}
    cards = found["cards"]
    print(f"release {version}; {len(cards)} cards; {len(tasks)} tasks; index {index.model} "
          f"{index.dimensions} dims, {len(index.units)} units, {len(index.owner)} vectors")

    unit_at = {(u.record_id, u.index): n for n, u in enumerate(index.units)}
    unit_card = np.full(len(index.units), -1, dtype=np.int64)
    missing = 0
    for at, card in enumerate(cards):
        for member in card["members"]:
            n = unit_at.get((member["record_id"], member["key"]))
            if n is None:
                missing += 1
            else:
                unit_card[n] = at
    owner = np.asarray(index.owner, dtype=np.int64)
    offsets = np.asarray(index.offsets, dtype=np.int64)
    count = len(owner)
    vector_card = unit_card[owner]
    print(f"card tasks with no unit in the index: {missing}; vectors of card tasks: "
          f"{int((vector_card >= 0).sum())} ({int(((vector_card >= 0) & (offsets == -1)).sum())} "
          f"written questions); vectors of other units (sections): {int((vector_card < 0).sum())}")
    members = collections.Counter(len(c["members"]) for c in cards)
    print(f"cards of one task: {members[1]}; of two or more: {len(cards) - members[1]}")

    def card_scores(values: np.ndarray, keep: np.ndarray) -> np.ndarray:
        best = np.full(len(cards), -2.0, dtype=np.float32)
        np.maximum.at(best, vector_card[keep], values[keep])
        return best

    def top_two(best: np.ndarray) -> tuple[int, float, float]:
        first = int(best.argmax())
        score = float(best[first])
        best[first] = -2.0
        return first, score, float(best.max())

    def unit_vector(k: int) -> np.ndarray:
        vector = index._matrix[k].astype(np.float32)
        return vector / (float(np.linalg.norm(vector)) or 1.0)

    # Part 1: written questions asked back, one in every few so about SAMPLE are asked.
    in_card = vector_card >= 0
    asked = np.flatnonzero(in_card & (offsets == -1))
    asked = asked[:: max(1, len(asked) // SAMPLE)]
    easy, hard, gone, sections = [], [], [], []
    by_status: dict[str, list[tuple[bool, float, float]]] = collections.defaultdict(list)
    for k in asked.tolist():
        values = index._all_scores(unit_vector(k))[:count]
        own = int(vector_card[k])
        keep = in_card.copy()
        keep[k] = False
        first, score, second = top_two(card_scores(values, keep))
        easy.append((first == own, score, score - second))
        keep = in_card & ~((owner == owner[k]) & (offsets == -1))
        first, score, second = top_two(card_scores(values, keep))
        hard.append((first == own, score, score - second))
        by_status[cards[own]["status"]].append(hard[-1])
        # The best unit that is no task (a headed section), beside the best card.
        sections.append(float(values[~in_card].max()) - score)
        keep = in_card & (vector_card != own)
        first, score, second = top_two(card_scores(values, keep))
        gone.append((False, score, score - second))
    grid("EASY (only the asked question taken out)", easy)
    grid("HARD (the task's written questions taken out)", hard)
    for status, rows in sorted(by_status.items()):
        right = sum(r for r, _, _ in rows)
        print(f"   hard, own card {status}: {len(rows)} asked, top card right for "
              f"{100 * right / len(rows):.1f}%")
    grid("GONE (the whole right card taken out)", gone, gone=True)
    ahead = sum(1 for gap in sections if gap > 0)
    print(f"\nhard: a section that is no task scores above the best card for "
          f"{100 * ahead / len(sections):.1f}% of the questions")

    # Part 2: the practice questions.
    practice = json.loads((Path(__file__).parent / "practice_questions.json").read_text())
    questions = practice["questions"]
    vectors, tokens = embed([item["q"] for item in questions], index.model, index.dimensions)
    print(f"\nembedded {len(questions)} practice questions: {tokens} tokens, "
          f"${tokens * EMBED_USD_PER_TOKEN:.6f}")

    def line(at: int, score: float) -> str:
        card = cards[at]
        winner = by_key[(card["members"][0]["record_id"], card["members"][0]["key"])]
        path = re.sub(r"^https?://[^/]+", "", winner.url).rstrip("/")
        return (f"{score:.3f} [{card['status']}, {len(card['members'])} pages, "
                f"{winner.steps} steps] {winner.name!r} {path}")

    rows = []
    for item, vector in zip(questions, vectors, strict=True):
        query = np.asarray(vector, dtype=np.float32)
        query /= float(np.linalg.norm(query)) or 1.0
        values = index._all_scores(query)[:count]
        best = card_scores(values, in_card)
        order = np.argsort(-best)[:4].tolist()
        top, second = float(best[order[0]]), float(best[order[1]])
        section = float(values[~in_card].max())
        card = cards[order[0]]
        winner = by_key[(card["members"][0]["record_id"], card["members"][0]["key"])]
        want = item["want"]
        right = (None if want is None
                 else bool(re.search(want, f"{winner.name} {winner.url}", re.IGNORECASE)))
        ok = card["status"] in ("ready", "date_passed") and winner.steps <= card_answer.MAX_STEPS
        rows.append((want is not None, right, top, top - second, ok))
        print(f"\nQ: {item['q']}   (want: {want})")
        print(f"   top {top:.3f}  margin {top - second:.3f}  best section {section:.3f}  "
              f"right card: {right}  code could answer: {ok}")
        for at in order[:3]:
            print("   " + line(at, float(best[at])))

    print("\n-- practice set: fires on should-match (right / wrong card) and on look-alikes, "
          "only cards code can answer from")
    print("top>=   margin>=  should-match fires  right  wrong   look-alike fires")
    for top in TOPS:
        for margin in MARGINS:
            hit = [(right, ok) for should, right, score, gap, ok in rows
                   if should and score >= top and gap >= margin and ok]
            false = sum(1 for should, _, score, gap, ok in rows
                        if not should and score >= top and gap >= margin and ok)
            print(f"{top:<8.2f}{margin:<10.2f}{len(hit):<20d}"
                  f"{sum(1 for r, _ in hit if r):<7d}{sum(1 for r, _ in hit if not r):<8d}{false}")


if __name__ == "__main__":
    main()
