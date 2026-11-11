"""Temporary study for answer cards, step 3 (never merged): prints what the cards built beside
the downloaded dev graph hold. Reads only."""

import collections
import datetime
import json
import random
import re
from pathlib import Path

from rockygpt_brain.retrieval import answer_cards, card_join
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts, read_pointer

TODAY = datetime.date(2026, 11, 11)


def main() -> None:
    directory = Path(".published")
    pointer = read_pointer(directory)
    facts = GraphOnlyFacts(directory)
    found = facts.answer_cards()
    assert found is not None, "no cards beside the release"
    _, _, tasks, names = answer_cards.join_input(facts, TODAY)
    by_key = {(t.record_id, t.key): t for t in tasks}
    cards = found["cards"]
    print(f"file: {(directory / pointer['file']).with_suffix(card_join.CARDS_SUFFIX).stat().st_size:,}"
          f" bytes; built_on {found['built_on']}; rules {found['rules']}")
    print(f"{len(cards)} cards; every task in one card: "
          f"{sorted((m['record_id'], m['key']) for c in cards for m in c['members']) == sorted(by_key)}")
    print("status:", dict(collections.Counter(c["status"] for c in cards)))
    print("flags:", dict(collections.Counter(f for c in cards for f in c["flags"])))
    print("notes:", dict(collections.Counter(n for c in cards for n in c["notes"])))
    print("roles:", dict(collections.Counter(m["role"] + ("/" + m["why"] if m.get("why") else "")
                                            for c in cards for m in c["members"])))
    sizes = collections.Counter(len(c["members"]) for c in cards)
    print("cards by number of tasks:", dict(sorted(sizes.items())))
    print("owners per card:", dict(sorted(collections.Counter(
        len(c["owners"]) for c in cards).items())))
    joined = [c for c in cards if len(c["members"]) > 1]
    print(f"joined cards: {len(joined)}; status among them: "
          f"{dict(collections.Counter(c['status'] for c in joined))}; flags: "
          f"{dict(collections.Counter(f for c in joined for f in c['flags']))}")

    def show(card) -> None:
        owners = "; ".join(names[o][0] for o in card["owners"]) or "nobody"
        print(f"- [{card['status']}] flags={card['flags']} notes={card['notes']} "
              f"owner: {owners}  ({card['id']})")
        for m in card["members"]:
            t = by_key[(m["record_id"], m["key"])]
            path = re.sub(r"^https?://[^/]+", "", t.url).rstrip("/")
            why = m["role"] + (f" ({m.get('why')}: {m.get('label') or 'page changed ' + str(t.updated)})"
                               if m.get("why") else "")
            who = "; ".join(names[n][0] for n in t.nodes)[:50]
            extra = f"  handled_by={t.handled_by!r}" if t.handled_by else ""
            print(f"    {why:34s} {t.name!r}  {path}  [{who}]  changed={t.updated}  "
                  f"{t.steps} steps{extra}"[:330])

    def about(pattern: str, limit: int = 12) -> None:
        wanted = [c for c in cards if any(re.search(pattern, by_key[(m["record_id"], m["key"])].name,
                                                    re.I) for m in c["members"])]
        print(f"\n== cards with a task matching /{pattern}/: {len(wanted)}")
        for c in sorted(wanted, key=lambda c: -len(c["members"]))[:limit]:
            show(c)

    about(r"^(apply|get|register|obtain|pick up).*parking permit")
    about(r"(meal|dining) plan", 14)
    about(r"retak|repeat.*course", 8)
    about(r"transcript", 6)
    about(r"declare.*(major|minor)", 6)
    print("\n== the 12 biggest cards")
    for c in sorted(cards, key=lambda c: -len(c["members"]))[:12]:
        show(c)
    rng = random.Random(11)
    print("\n== 30 random joined cards")
    for c in rng.sample(joined, 30):
        show(c)
    print("\n== 15 random cards of one task")
    for c in rng.sample([c for c in cards if len(c["members"]) == 1], 15):
        show(c)
    print("\n== 15 random cards that need a look, joined")
    for c in rng.sample([c for c in joined if c["status"] == "needs_look"], 15):
        show(c)


if __name__ == "__main__":
    main()
