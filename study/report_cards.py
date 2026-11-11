"""Temporary study for answer cards, step 3 (never merged): prints what the cards built beside
the downloaded dev graph hold. Reads only."""

import base64
import collections
import datetime
import gzip
import json
import random
import re
from pathlib import Path

from urllib.parse import urlsplit

from rockygpt_brain.retrieval import answer_cards, card_join
from rockygpt_brain.retrieval.card_join import _named, _words
from rockygpt_brain.retrieval.entity_facts import _stem
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

    about(r"^(apply|get|register|obtain|pick up).*parking permit", 3)
    about(r"(meal|dining) plan refund", 4)

    # Pairs joined although each task's name carries a name the other's name lacks: what in the
    # other task's listing (who it is for, its section, its page address) allowed the join?
    def stems(text):
        return {_stem(w.casefold()) for w in _words(text or "")}

    def where(missing, other):
        out = []
        for word in sorted(missing):
            place = ("for" if word in stems(other.applies_to) else
                     "section" if word in stems(other.section) else
                     "url" if word in stems(urlsplit(other.url).path.replace("-", " ").replace("/", " "))
                     else "LACKS")
            out.append(f"{word}@{place}")
        return out

    allowed = []
    for c in joined:
        ts = [by_key[(m["record_id"], m["key"])] for m in c["members"]]
        for x, first in enumerate(ts):
            for second in ts[x + 1:]:
                lack_a = _named(first.name) - stems(second.name)
                lack_b = _named(second.name) - stems(first.name)
                if lack_a and lack_b:
                    allowed.append((c, first, second, where(lack_a, second), where(lack_b, first)))
    kinds = collections.Counter(
        "+".join(sorted({w.split("@")[1] for w in a + b})) for _, _, _, a, b in allowed)
    print(f"\n== pairs joined although both names carry a name the other name lacks: "
          f"{len(allowed)} pairs in {len({id(c) for c, *_ in allowed})} cards; by what allowed it: "
          f"{dict(kinds.most_common())}")
    rng = random.Random(7)
    for c, first, second, a, b in rng.sample(allowed, min(60, len(allowed))):
        print(f"- {first.name!r} | {second.name!r}\n    {a} / {b}   [{c['status']}]"
              f"  {urlsplit(first.url).path} | {urlsplit(second.url).path}"[:400])


def sample() -> None:
    """A small real slice of the Brain's own list, for looking at the dev UI's cards view: about
    45 cards with their pages (each page cut to the tasks in those cards) and every task in full."""
    directory = Path(".published")
    facts = GraphOnlyFacts(directory)
    full = answer_cards.listing(facts)
    tasks = {(p["record_id"], t["key"]): (p, t) for p in full["pages"] for t in p["tasks"]}
    cards = full["cards"]["items"]

    def name(card) -> str:
        first = card["members"][0]
        return tasks[(first["record_id"], first["key"])][1]["task"]

    rng = random.Random(3)
    joined = [c for c in cards if len(c["members"]) > 1]
    wanted = [c for c in cards if re.search(
        r"parking permit|meal plan refund|change your .*meal plan|counseling appointment|"
        r"incomplete grade|official transcript|retake", name(c), re.I)]
    wanted += rng.sample([c for c in joined if c["status"] == "needs_look"], 5)
    wanted += rng.sample([c for c in cards if c["status"] == "date_passed"], 4)
    wanted += rng.sample([c for c in joined if c["status"] == "ready"], 8)
    wanted += rng.sample([c for c in cards if len(c["members"]) == 1 and c["status"] == "ready"], 8)
    chosen = list({c["id"]: c for c in wanted}.values())[:60]
    members = {(m["record_id"], m["key"]) for c in chosen for m in c["members"]}
    pages = []
    for page in full["pages"]:
        kept = [t for t in page["tasks"] if (page["record_id"], t["key"]) in members]
        if kept:
            pages.append({**page, "tasks": kept})
    used = {n for page in pages for n in page["nodes"]} | {o for c in chosen for o in c["owners"]}
    details = []
    for record_id, key in sorted(members):
        page = tasks[(record_id, key)][0]
        details.append(answer_cards.task(facts, page["nodes"][0], record_id, key))
    out = {"dataset_version": full["dataset_version"], "identity_hash": full["identity_hash"],
           "cards": {**full["cards"], "items": chosen}, "totals": full["totals"],
           "real": {"cards": len(cards), "status": dict(collections.Counter(
               c["status"] for c in cards)), "joined": len(joined)},
           "nodes": [n for n in full["nodes"] if n["entity_id"] in used], "pages": pages,
           "tasks": details}
    packed = base64.b64encode(gzip.compress(json.dumps(out, default=str).encode())).decode()
    print(f"sample: {len(chosen)} cards, {len(pages)} pages, {len(details)} tasks, "
          f"{len(packed):,} characters")
    print("SAMPLE-GZ " + packed)


if __name__ == "__main__":
    main()
    sample()
