"""Temporary study (never merged): why do two answer cards tie for a question, and what would
counting near-copies of one task as one card change?

The clear-match rule (Brain card_answer.py) lets code answer from a card that scores 0.80 or more
and leads every other card by 0.08. On the practice set 28 of 70 how-to questions reach 0.80 and
lose on the lead, most to a card for the same task on another page.

Two ways to fix that are measured here on the downloaded dev graph, both by rules:

  M (at match time): the lead is taken against the best card that is no KIN of the top card. Two
    cards are kin when they share no page, no two of their tasks differ by name, and their tasks
    are alike enough (mean and least of the pairs, the join's own measure).
  J (at join time): the join's two numbers are lowered, so more tasks become one card.

Part 1 embeds the practice questions (one call, a hundredth of a cent) and prints each one's top
cards with the pair numbers. Part 2 asks back the questions the build wrote for each task (already
vectors in the index: free) to see whose card answers under each rule.
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
from rockygpt_brain.retrieval import answer_cards, card_join
from rockygpt_brain.retrieval.entity_facts import MEANING_PAST_TERM
from rockygpt_brain.retrieval.graph_store import POINTER, GraphOnlyFacts
from rockygpt_brain.retrieval.meaning import MEANING_SUFFIX, VECTORS_SUFFIX

TODAY = datetime.date(2026, 11, 11)
TOP, MARGIN = card_answer.MATCH_TOP, card_answer.MATCH_MARGIN
SAMPLE = 3000
EMBED_USD_PER_TOKEN = 0.13 / 1_000_000  # text-embedding-3-large
# Kin rules: (mean at least, least pair at least, the two cards must share an owner).
KIN = {
    "base": None,
    "k82": (0.82, 0.74, False),
    "k80": (0.80, 0.72, False),
    "k78": (0.78, 0.70, False),
    "k75": (0.75, 0.65, False),
    "k70": (0.70, 0.60, False),
    "k78+owner": (0.78, 0.70, True),
    "k75+owner": (0.75, 0.65, True),
    "k70+owner": (0.70, 0.60, True),
}
JOINS = ((0.83, 0.76), (0.80, 0.74), (0.78, 0.70))
READ = "k78"  # The kin rule whose new fires are printed for reading.


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


directory = Path(".published")
facts = GraphOnlyFacts(directory)
index = facts.meaning_index()
published = facts.answer_cards()
assert index is not None and published is not None, "no index or no cards beside the release"
version, _, tasks, names = answer_cards.join_input(facts, TODAY)
pointer = json.loads((directory / POINTER).read_text())
release_file = directory / pointer["file"]
meta = json.loads(release_file.with_suffix(MEANING_SUFFIX).read_text())
flat = np.fromfile(release_file.with_suffix(VECTORS_SUFFIX), dtype=np.float32)
task_vecs = card_join.task_vectors(meta, flat, tasks)
task_at = {(t.record_id, t.key): n for n, t in enumerate(tasks)}
unit_at = {(u.record_id, u.index): n for n, u in enumerate(index.units)}
owner = np.asarray(index.owner, dtype=np.int64)
offsets = np.asarray(index.offsets, dtype=np.int64)
count = len(owner)


class Deck:
    """One set of cards over the release's tasks, and what the match rule needs of it."""

    def __init__(self, cards: list[dict]) -> None:  # type: ignore[type-arg]
        self.cards = cards
        self.members = [[task_at[(m["record_id"], m["key"])] for m in card["members"]]
                        for card in cards]
        unit_card = np.full(len(index.units), -1, dtype=np.int64)
        self.task_card = {}
        for at, card in enumerate(cards):
            for member in card["members"]:
                key = (member["record_id"], member["key"])
                unit_card[unit_at[key]] = at
                self.task_card[task_at[key]] = at
        self.vector_card = unit_card[owner]
        self.in_card = self.vector_card >= 0
        self.penalty = np.asarray(
            [MEANING_PAST_TERM if card["status"] == "date_passed" else 0.0 for card in cards],
            dtype=np.float32)
        self.pages = [frozenset(tasks[i].record_id for i in group) for group in self.members]
        self._pair: dict[tuple[int, int], tuple[float, float, bool, bool, bool]] = {}

    def scores(self, values: np.ndarray, keep: np.ndarray | None = None) -> np.ndarray:
        keep = self.in_card if keep is None else keep
        best = np.full(len(self.cards), -2.0, dtype=np.float32)
        np.maximum.at(best, self.vector_card[keep], values[keep])
        return best - self.penalty

    def winner(self, at: int):  # type: ignore[no-untyped-def]
        return tasks[self.members[at][0]]

    def answerable(self, at: int) -> bool:
        return (self.cards[at]["status"] in ("ready", "date_passed")
                and self.winner(at).steps <= card_answer.MAX_STEPS)

    def pair(self, a: int, b: int) -> tuple[float, float, bool, bool, bool]:
        """(mean, least, share a page, differ by name, share an owner) of two cards' tasks."""
        key = (a, b) if a < b else (b, a)
        if key not in self._pair:
            alike = task_vecs[self.members[a]] @ task_vecs[self.members[b]].T
            differ = any(card_join.names_differ(tasks[i], tasks[j])
                         for i in self.members[a] for j in self.members[b])
            same = bool(set(self.cards[a]["owners"]) & set(self.cards[b]["owners"]))
            self._pair[key] = (float(alike.mean()), float(alike.min()),
                               bool(self.pages[a] & self.pages[b]), differ, same)
        return self._pair[key]

    def kin(self, a: int, b: int, rule: tuple[float, float, bool] | None) -> bool:
        if rule is None or a == b:
            return False
        mean, least, share, differ, same = self.pair(a, b)
        return (not share and not differ and mean >= rule[0] and least >= rule[1]
                and (same or not rule[2]))

    def decide(self, best: np.ndarray, rule: tuple[float, float, bool] | None,
               ) -> tuple[int, float, float, list[int]]:
        """(top card, its score, its lead over the best card that is no kin, the kin passed)."""
        order = np.argsort(-best)[:80].tolist()
        first, top = order[0], float(best[order[0]])
        passed: list[int] = []
        for at in order[1:]:
            gap = top - float(best[at])
            if gap >= MARGIN or not self.kin(first, at, rule):
                return first, top, gap, passed
            passed.append(at)
        return first, top, 1.0, passed

    def said(self, best: np.ndarray, rule: tuple[float, float, bool] | None) -> int | None:
        """The card code would answer from: the top card on a clear lead, when code can answer
        from it; else its best kin that code can answer from and that reaches TOP itself."""
        first, top, lead, passed = self.decide(best, rule)
        if top < TOP or lead < MARGIN:
            return None
        return next((at for at in [first, *passed]
                     if self.answerable(at) and float(best[at]) >= TOP), None)

    def name(self, at: int) -> str:
        card, task = self.cards[at], self.winner(at)
        path = re.sub(r"^https?://[^/]+", "", task.url).rstrip("/")
        owners = "; ".join(names[o][0] for o in card["owners"] if o in names) or "nobody"
        return (f"[{card['status']}, {len(card['members'])}p, {task.steps}s, {owners[:32]}] "
                f"{task.name!r} {path}")


def unit_vector(k: int) -> np.ndarray:
    vector = index._matrix[k].astype(np.float32)
    return vector / (float(np.linalg.norm(vector)) or 1.0)


def written_questions() -> dict[int, list[str]]:
    path = Path(".meaning-cache/questions.json")
    if not path.exists():
        print("no question cache restored: fires are printed without the question's words")
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


def rebuilt(mean: float, least: float) -> Deck:
    card_join.JOIN_MEAN, card_join.JOIN_LEAST = mean, least
    try:
        return Deck(card_join.build(tasks, task_vecs, names))
    finally:
        card_join.JOIN_MEAN, card_join.JOIN_LEAST = 0.85, 0.78


def counts(deck: Deck) -> str:
    status = collections.Counter(card["status"] for card in deck.cards)
    joined = sum(1 for group in deck.members if len(group) > 1)
    return (f"{len(deck.cards)} cards, {joined} joined from 2+ pages, {status['ready']} ready, "
            f"{status['needs_look']} need a look, {status['date_passed']} date passed")


def main() -> None:
    before = Deck(published["cards"])
    base = rebuilt(0.85, 0.78)
    print(f"release {version}; published cards (built {published.get('built_on')}): "
          f"{counts(before)}")
    print(f"rebuilt today with the same rules: {counts(base)}")
    decks = {"J 0.85/0.78 (today's rules)": base}
    for mean, least in JOINS:
        decks[f"J {mean}/{least}"] = rebuilt(mean, least)
        print(f"rebuilt with join {mean}/{least}: {counts(decks[f'J {mean}/{least}'])}")

    # Part 1: the practice questions.
    practice = json.loads((Path(__file__).parent / "practice_questions.json").read_text())
    questions = practice["questions"]
    vectors, tokens = embed([item["q"] for item in questions], index.model, index.dimensions)
    print(f"\nembedded {len(questions)} practice questions: {tokens} tokens, "
          f"${tokens * EMBED_USD_PER_TOKEN:.6f}")
    asked = []
    for item, vector in zip(questions, vectors, strict=True):
        query = np.asarray(vector, dtype=np.float32)
        query /= float(np.linalg.norm(query)) or 1.0
        asked.append((item, index._all_scores(query)[:count]))

    def right(deck: Deck, at: int, want: str) -> bool:
        task = deck.winner(at)
        return bool(re.search(want, f"{task.name} {task.url}", re.IGNORECASE))

    print("\n== PART 1: each practice question's cards within the lead of the top one "
          "(rebuilt cards, today's join rules)")
    for item, values in asked:
        best = base.scores(values)
        order = np.argsort(-best)[:7].tolist()
        top = float(best[order[0]])
        print(f"\nQ: {item['q']}   (want: {item['want']})")
        for n, at in enumerate(order):
            if n and top - float(best[at]) >= MARGIN and n > 1:
                break
            line = f"   {float(best[at]):.3f} {base.name(at)}"
            if n:
                mean, least, share, differ, same = base.pair(order[0], at)
                line += (f"\n         vs top: mean {mean:.2f} least {least:.2f}"
                         f"{' SAME-PAGE' if share else ''}{' NAMES-DIFFER' if differ else ''}"
                         f"{' same-owner' if same else ' other-owner'}")
            print(line)
        verdicts = []
        for label, rule in KIN.items():
            at = base.said(best, rule)
            verdicts.append(f"{label}:" + ("-" if at is None else
                                           ("ok" if item["want"] is None
                                            or right(base, at, item["want"]) else "WRONG?")
                                           + ("" if at == order[0] else "(kin)")))
        print("   " + "  ".join(verdicts))

    def tally(deck: Deck, rule: tuple[float, float, bool] | None) -> str:
        fired = [(item, deck.said(deck.scores(values), rule)) for item, values in asked]
        how = [(item, at) for item, at in fired if item["want"] is not None and at is not None]
        look = [item["q"] for item, at in fired if item["want"] is None and at is not None]
        good = sum(1 for item, at in how if right(deck, at, item["want"]))
        return (f"{len(how)} of {sum(1 for i in questions if i['want'] is not None)} how-to "
                f"(right card by pattern: {good}), {len(look)} of "
                f"{sum(1 for i in questions if i['want'] is None)} look-alikes {look or ''}")

    print("\n== PART 1 totals: code would answer")
    print(f"   published cards, today's rule:   {tally(before, None)}")
    for label, rule in KIN.items():
        print(f"   M {label:<12} {tally(base, rule)}")
    for label, deck in decks.items():
        print(f"   {label:<28} {tally(deck, None)}")

    # Part 2: written questions asked back, one in every few so about SAMPLE are asked.
    words = written_questions()
    nth: dict[int, int] = {}
    seen: collections.Counter[int] = collections.Counter()
    for k in np.flatnonzero(offsets == -1).tolist():
        nth[k] = seen[int(owner[k])]
        seen[int(owner[k])] += 1

    def asked_words(k: int) -> str:
        listed = words.get(int(owner[k])) or []
        return listed[nth[k]] if nth[k] < len(listed) else "?"

    sample = np.flatnonzero(base.in_card & (offsets == -1))
    sample = sample[:: max(1, len(sample) // SAMPLE)].tolist()
    runs = [("M " + label, base, rule) for label, rule in KIN.items()]
    runs += [(label, deck, None) for label, deck in list(decks.items())[1:]]
    tallies = {label: collections.Counter() for label, _, _ in runs}
    shown: list[str] = []
    for k in sample:
        values = index._all_scores(unit_vector(k))[:count]
        scores: dict[int, tuple[np.ndarray, np.ndarray, int]] = {}
        for label, deck, rule in runs:
            if id(deck) not in scores:
                own = int(deck.vector_card[k])
                keep = deck.in_card.copy()
                keep[k] = False
                # Second: the whole own card taken out, so nothing but a kin of it should answer.
                scores[id(deck)] = (deck.scores(values, keep), deck.scores(
                    values, deck.in_card & (deck.vector_card != own)), own)
            best, gone, own = scores[id(deck)]
            at = deck.said(best, rule)
            if at is not None:
                tallies[label]["own" if at == own else
                               "kin" if deck.kin(at, own, rule) else "other"] += 1
            if deck.said(gone, rule) is not None:
                tallies[label]["gone"] += 1
            if (label == "M " + READ and at is not None and at != own
                    and deck.said(best, None) is None):
                mean, least, _, _, same = deck.pair(at, own)
                shown.append(
                    f"Q: {asked_words(k)}\n     own:  {deck.name(own)}\n     said: "
                    f"{float(best[at]):.3f} {deck.name(at)}\n     own vs said: mean {mean:.2f} "
                    f"least {least:.2f} {'same-owner' if same else 'other-owner'}"
                    f"{' KIN' if deck.kin(at, own, rule) else ' not kin'}")
    total = len(sample)
    print(f"\n== PART 2: {total} written questions asked back (the asked one taken out)")
    for label, _, _ in runs:
        seen_n = tallies[label]
        fired = seen_n["own"] + seen_n["kin"] + seen_n["other"]
        print(f"   {label:<28} answers {100 * fired / total:5.1f}%  of them: own card "
              f"{100 * seen_n['own'] / max(fired, 1):5.1f}%, a kin of it "
              f"{100 * seen_n['kin'] / max(fired, 1):5.1f}%, another card "
              f"{100 * seen_n['other'] / max(fired, 1):5.1f}% ({seen_n['other']});  with the own "
              f"card taken out it still answers {100 * seen_n['gone'] / total:5.1f}%")
    step = max(1, len(shown) // 60)
    print(f"\n-- new answers under M {READ} from a card that is not the question's own: "
          f"{len(shown)}; every {step}th shown")
    for line in shown[::step]:
        print(line)

    # What a looser join puts together that today's join keeps apart, to read.
    for label, deck in list(decks.items())[1:]:
        merged = [at for at, group in enumerate(deck.members)
                  if len({base.task_card[i] for i in group}) > 1]
        step = max(1, len(merged) // 25)
        print(f"\n-- {label}: {len(merged)} cards join what today's rules keep apart; every "
              f"{step}th shown")
        for at in merged[::step]:
            parts = sorted({base.task_card[i] for i in deck.members[at]})
            print("   + " + "\n     ".join(base.name(part) for part in parts[:5])
                  + (f"\n     ... and {len(parts) - 5} more" if len(parts) > 5 else ""))


if __name__ == "__main__":
    main()
