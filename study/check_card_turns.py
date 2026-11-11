"""Temporary check for answer cards, step 4 (never merged): the Brain's real chat path with the
card setting on, over the practice questions, on the downloaded dev graph.

The gateway only embeds each question (a hundredth of a cent for all of them) and refuses every
model call, so a question that is not answered from a card ends in an error here. What is read:
which questions code answered from a card and what it said, why the others were not, and which
winning pages a page answer would have read in place of a left-out one.
"""

import asyncio
import datetime
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import GatewayError
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.turn import intake

NOW = datetime.datetime(2026, 11, 11, 15, tzinfo=datetime.UTC)
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


class EmbedOnly:
    """Embeds, and refuses every model call."""

    def __init__(self, model: str) -> None:
        self.model, self.tokens, self.refused = model, 0, 0

    async def embed_many(self, texts: Any, *, dimensions: int, budget: Any) -> list[list[float]]:
        vectors, tokens = await asyncio.to_thread(embed, list(texts), self.model, dimensions)
        self.tokens += tokens
        return vectors

    async def complete(self, *, input: Any, tools: Any, budget: Any) -> Any:
        self.refused += 1
        raise GatewayError("study_refuses_model_calls")

    async def ready(self) -> bool:
        return True


async def main() -> None:
    facts = GraphOnlyFacts(Path(".published"))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    gateway = EmbedOnly(index.model)
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True,  # type: ignore[arg-type]
                        read_first=False, card_answers=True)
    practice = json.loads((Path(__file__).parent / "practice_questions.json").read_text())
    rows = []
    for item in practice["questions"]:
        request = ChatRequest.model_validate({"messages": [{"role": "user", "content": item["q"]}]})
        before, started = gateway.refused, time.monotonic()
        try:
            result = await engine.answer(intake(request, now=NOW), request)
            status, body, trace = result.status_code, result.body, result.trace or {}
        except Exception as error:  # noqa: BLE001  The study reads every question.
            status, body, trace = -1, {"answer": type(error).__name__}, {}
        note = trace.get("answerCard")
        said = bool(note and note.get("said"))
        rows.append((item, said, note))
        print(f"\nQ: {item['q']}   (how-to: {item['want'] is not None})")
        print(f"   status {status}  decidedBy {trace.get('decidedBy')}  "
              f"model calls refused {gateway.refused - before}  "
              f"{time.monotonic() - started:.1f}s  answerCard {json.dumps(note)}")
        if trace.get("answerCardWinners"):
            print(f"   winning pages brought in: {trace['answerCardWinners']}")
        if said:
            print("   ---- said by code ----")
            for line in str(body.get("answer", "")).splitlines():
                print(f"   | {line}")
    how_to = [row for row in rows if row[0]["want"] is not None]
    others = [row for row in rows if row[0]["want"] is None]
    print(f"\n== embedded with {gateway.tokens} tokens, ${gateway.tokens * EMBED_USD_PER_TOKEN:.6f}; "
          f"{gateway.refused} model calls refused, none made")
    print(f"== code answered from a card: {sum(1 for r in how_to if r[1])} of {len(how_to)} how-to "
          f"questions and {sum(1 for r in others if r[1])} of {len(others)} look-alikes")
    reasons: dict[str, int] = {}
    for _, said, note in rows:
        why = "said" if said else "not a plain how-to question" if note is None else note["why"]
        reasons[why] = reasons.get(why, 0) + 1
    print(f"== by outcome: {json.dumps(reasons, sort_keys=True)}")


if __name__ == "__main__":
    asyncio.run(main())
