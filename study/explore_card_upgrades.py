"""Temporary study (never merged): what the card match sees, on the downloaded dev graph, for
- 90 fresh practice messages (2026-11-16): the whole message, each of its pieces, and the plain
  line their writer gave for what the student wants;
- 30 older how-to questions with the clean questions the first read really wrote for them in two
  saved runs (rockygpt-evals page-writer-check-2026-11-16).

No model call is made: the gateway embeds the texts in one request (under a tenth of a cent) and
refuses everything else. Per text it records the five best cards with their scores, the lead the
real rule computes, and where its best card stands in the whole message's ranking. For the fresh
messages it also records what the card gate's conditions held when the real chat path reached it.

SLICE=0 prints the numbers as one line; SLICE=1..3 print, as plain text, what code would say from
the cards a text matched best.
"""

import asyncio
import base64
import datetime
import gzip
import inspect
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from rockygpt_brain import card_answer, one_call
from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import GatewayError
from rockygpt_brain.retrieval import answer_cards
from rockygpt_brain.retrieval.entity_facts import MEANING_PAST_TERM
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.turn import intake

NOW = datetime.datetime(2026, 11, 16, 15, tzinfo=datetime.UTC)
EMBED_USD_PER_TOKEN = 0.13 / 1_000_000  # text-embedding-3-large
SLICE = int(os.environ.get("SLICE", "0"))
SAID_SLICES = 3
GATE_NAMES = ("searchable", "asked_at", "earlier", "kind", "calendar_asked", "people_asked",
              "named_people", "programs", "code_parts", "computed", "academic", "people", "clubs")
GATE: dict[str, Any] = {}


def embed(texts: list[str], model: str, dimensions: int) -> tuple[list[list[float]], int]:
    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps({"model": model, "input": texts, "dimensions": dimensions}).encode(),
        headers={"content-type": "application/json",
                 "authorization": "Bearer " + os.environ["BRAIN_OPENAI_API_KEY"]})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        # Never the message or a header: only the status.
        raise SystemExit(f"embeddings failed with HTTP {error.code}") from None
    rows = sorted(reply["data"], key=lambda d: d["index"])
    return [row["embedding"] for row in rows], int(reply["usage"]["total_tokens"])


class EmbedOnly:
    """Embeds (each text once), and refuses every model call."""

    def __init__(self, model: str) -> None:
        self.model, self.tokens, self.refused = model, 0, 0
        self.known: dict[str, list[float]] = {}

    def learn(self, texts: list[str], dimensions: int) -> None:
        new = [t for t in dict.fromkeys(texts) if t not in self.known]
        for start in range(0, len(new), 400):
            vectors, tokens = embed(new[start:start + 400], self.model, dimensions)
            self.tokens += tokens
            self.known.update(zip(new[start:start + 400], vectors, strict=True))

    async def embed_many(self, texts: Any, *, dimensions: int, budget: Any) -> list[list[float]]:
        await asyncio.to_thread(self.learn, list(texts), dimensions)
        return [self.known[t] for t in texts]

    async def complete(self, *, input: Any, tools: Any, budget: Any) -> Any:
        self.refused += 1
        raise GatewayError("study_refuses_model_calls")

    async def ready(self) -> bool:
        return True


def gate_line() -> int:
    source, start = inspect.getsourcelines(ChatEngine._one_call)
    for offset, line in enumerate(source):
        if "self._cards_now() and searchable" in line:
            return start + offset
    raise SystemExit("the card gate's line was not found")


def watch_gate() -> None:
    """Copies what the card gate's conditions hold when the chat path reaches it."""
    code, line = ChatEngine._one_call.__code__, gate_line()

    def short(name: str, value: Any) -> Any:
        if name == "asked_at":
            return value
        if name in ("earlier", "kind"):
            return value is not None
        if name == "programs":
            return bool(value and any(value))
        return bool(value)

    def local(frame: Any, event: str, arg: Any) -> Any:
        if event == "line" and frame.f_lineno == line:
            GATE.update({name: short(name, frame.f_locals.get(name)) for name in GATE_NAMES})
        return local

    def tracer(frame: Any, event: str, arg: Any) -> Any:
        return local if frame.f_code is code else None

    sys.settrace(tracer)


async def ask(engine: ChatEngine, message: str) -> dict[str, Any]:
    request = ChatRequest.model_validate({"messages": [{"role": "user", "content": message}]})
    GATE.clear()
    try:
        result = await engine.answer(intake(request, now=NOW), request)
        trace = result.trace or {}
    except Exception as error:  # noqa: BLE001  The study reads every message.
        trace = {"decidedBy": type(error).__name__}
    note = trace.get("answerCard") or {}
    return {"by": trace.get("decidedBy"), "said": bool(note.get("said")), "why": note.get("why"),
            "gate": dict(GATE) or None}


async def main() -> None:
    here = Path(__file__).parent
    facts = GraphOnlyFacts(Path(".published"))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    gateway = EmbedOnly(index.model)
    fresh = json.loads((here / "practice.json").read_text())
    saved = json.loads((here / "reads.json").read_text())

    def texts_of(row: dict[str, Any]) -> list[tuple[str, str]]:
        question = row["question"]
        found = [("whole", question)]
        found += [("piece", piece) for piece in one_call.pieces_of(question) if piece != question]
        if row.get("group") == "how-to" and row.get("wants"):
            found.append(("wants", row["wants"]))
            found.append(("wants_q", "How do I " + row["wants"].rstrip(".?") + "?"))
        found += [("read", read["text"]) for read in row.get("reads") or []]
        return found

    every = [text for row in [*fresh, *saved] for _, text in texts_of(row)]
    every += [part for row in [*fresh, *saved] for part in one_call.parts_of(row["question"])]
    gateway.learn(every, index.dimensions)
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True,  # type: ignore[arg-type]
                        read_first=False, card_answers=True, page_writer="ai")
    found = engine._card_tasks(index)
    assert found is not None, "no cards beside the release"
    print(f"release {index.dataset_version}: {len(found.cards)} cards; {len(fresh)} fresh and "
          f"{len(saved)} saved messages; {len(gateway.known)} texts embedded with "
          f"{gateway.tokens} tokens, ${gateway.tokens * EMBED_USD_PER_TOKEN:.6f}")
    today = NOW.date()
    table: dict[int, list[Any]] = {}
    said_of: dict[int, str | None] = {}

    def ranked(text: str) -> tuple[list[int], dict[int, float]]:
        best: dict[int, float] = {}
        for key, score in index.scores(gateway.known[text]).items():
            at = found.card_of.get(key)
            if at is None:
                continue
            if at in found.passed:
                score -= MEANING_PAST_TERM
            if score > best.get(at, -2.0):
                best[at] = score
        return sorted(best, key=lambda at: (-best[at], at)), best

    def name(at: int) -> None:
        if at in table:
            return
        card = found.cards[at]
        member = (card.get("members") or [{}])[0]
        label = one_call.unit_labels(index, [(str(member.get("record_id")),
                                               str(member.get("key")))])[0]
        table[at] = [label[:110], str(card.get("status") or ""), None]

    def read(at: int) -> None:
        """Whether code answers from the card, and what it would say."""
        if at in said_of:
            return
        name(at)
        try:
            own = dict(answer_cards.view(facts, found.cards[at], found.nodes, today,
                                         dataset_version=index.dataset_version,
                                         identity_hash=index.identity_hash)["card"])
        except Exception as error:  # noqa: BLE001
            table[at][2], said_of[at] = type(error).__name__, None
            return
        why = card_answer.refusal(own)
        said = engine.card_said(own, today) if why is None else None
        table[at][2] = why or ("" if said is not None else "check")
        table[at].append(str(own["task"].get("task") or "")[:90])
        table[at].append(str(own["task"].get("applies_to") or "")[:60])
        table[at].append(str(own["task"].get("term") or "")[:30])
        said_of[at] = said[0] if said is not None else None

    def record(row: dict[str, Any]) -> list[list[Any]]:
        texts = texts_of(row)
        whole_order, _ = ranked(texts[0][1])
        whole_first = whole_order[0] if whole_order else None
        out = []
        for kind, text in texts:
            order, best = ranked(text)
            match = card_answer.best_card(index.scores(gateway.known[text]), found.card_of,
                                          found.passed, found.near)
            if match is None or not order:
                out.append([kind, [], 0, [], -1, False])
                continue
            first, top, lead, over = match
            copies = found.near.get(first, ())
            for at in order[:5]:
                name(at)
            if top >= 0.66:
                read(first)
            rank = whole_order.index(first) if first in whole_order else 999
            agrees = whole_first is not None and (whole_first == first or whole_first in copies)
            out.append([kind, [[at, round(best[at] * 1000), int(at in copies)]
                               for at in order[:5]],
                        round(lead * 1000), list(over), min(rank, 999), agrees])
        return out

    result: dict[str, Any] = {"fresh": [], "saved": []}
    watch_gate()
    for row in fresh:
        result["fresh"].append({"id": row["id"], "path": await ask(engine, row["question"])})
    sys.settrace(None)
    for row, kept in zip(fresh, result["fresh"], strict=True):
        kept["texts"] = record(row)
        pieces, parts = one_call.pieces_of(row["question"]), one_call.parts_of(row["question"])
        kept["asked_at"] = card_answer.asking_part(pieces, parts)
    for row in saved:
        pieces, parts = one_call.pieces_of(row["question"]), one_call.parts_of(row["question"])
        result["saved"].append({"id": row["id"], "texts": record(row),
                                "asked_at": card_answer.asking_part(pieces, parts)})
    result["cards"] = {str(at): row for at, row in sorted(table.items())}
    print(f"{len(table)} cards named, {len(said_of)} read, "
          f"{sum(1 for s in said_of.values() if s)} with an answer by code; "
          f"{gateway.refused} model calls refused, none made")
    if SLICE == 0:
        blob = base64.b64encode(gzip.compress(json.dumps(result, separators=(",", ":"))
                                              .encode(), 9)).decode()
        print(f"== blob of {len(blob)} characters")
        print("== RESULTS_B64_GZIP " + blob)
        return
    answers = [(at, text) for at, text in sorted(said_of.items()) if text]
    mine = [pair for n, pair in enumerate(answers) if n % SAID_SLICES == SLICE - 1]
    for at, text in mine:
        print(f"@@ {at} | {table[at][0]}")
        for line in text.splitlines():
            if line.strip():
                print("   " + line.strip()[:400])
    print(f"== SAID_SLICE {SLICE}: {len(mine)} of {len(answers)} answers")


if __name__ == "__main__":
    asyncio.run(main())
