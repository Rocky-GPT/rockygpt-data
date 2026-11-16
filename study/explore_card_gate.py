"""Temporary study (never merged): the card gate and the two-stage sentence list on 90 practice
messages a separate writer wrote (2026-11-16), on the downloaded dev graph.

No model call is made: the gateway embeds the messages' parts in one request (under a tenth of a
cent) and refuses everything else, so the first read is off and a message no code answers ends in
an error here. What is read, per message:
- as built, cards off and cards on: who answered, and what the two-stage path would number for
  its sentence pick, counted the old way (an entry's steps and its section both) and the new way;
- with the message taken as one part: whether the gate's other conditions let it reach the cards;
- for each part (the whole message, then each sentence or clause): the card it matches best, its
  score and lead, and what code would say from it.
"""

import asyncio
import base64
import datetime
import gzip
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from rockygpt_brain import one_call, page_facts
from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import GatewayError
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.turn import intake

NOW = datetime.datetime(2026, 11, 16, 15, tzinfo=datetime.UTC)
EMBED_USD_PER_TOKEN = 0.13 / 1_000_000  # text-embedding-3-large
PARTS_OF = one_call.parts_of
NUMBERED = page_facts.numbered
LAST: dict[str, Any] = {}


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
    """Embeds (each text once), and refuses every model call."""

    def __init__(self, model: str) -> None:
        self.model, self.tokens, self.refused = model, 0, 0
        self.known: dict[str, list[float]] = {}

    def learn(self, texts: list[str], dimensions: int) -> None:
        new = [t for t in dict.fromkeys(texts) if t not in self.known]
        if new:
            vectors, tokens = embed(new, self.model, dimensions)
            self.tokens += tokens
            self.known.update(zip(new, vectors, strict=True))

    async def embed_many(self, texts: Any, *, dimensions: int, budget: Any) -> list[list[float]]:
        await asyncio.to_thread(self.learn, list(texts), dimensions)
        return [self.known[t] for t in texts]

    async def complete(self, *, input: Any, tools: Any, budget: Any) -> Any:
        self.refused += 1
        raise GatewayError("study_refuses_model_calls")

    async def ready(self) -> bool:
        return True


def old_numbered(offices: Any) -> list[dict[str, Any]]:
    """The sentence list as it was numbered before: an entry's steps and its section both."""
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for office in offices:
        for section in office.get("sections") or []:
            text = " ".join(str(section.get(k) or "") for k in ("text", "section_words")
                            if section.get(k))
            for said in page_facts.sentences(text):
                key = re.sub(r"\W+", " ", said.casefold()).strip()
                if key in seen:
                    continue
                seen.add(key)
                found.append({"says": said})
                if len(found) >= page_facts.MAX_SENTENCES:
                    return found
    return found


def recording(offices: Any) -> list[dict[str, Any]]:
    new, old = NUMBERED(offices), old_numbered(offices)
    sections = [s for o in offices for s in o.get("sections") or []]
    LAST.update(
        old=len(old), new=len(new), sections=len(sections),
        entries=sum(1 for s in sections if "(page: “" in str(s.get("text") or "")),
        with_words=sum(1 for s in sections if s.get("section_words")),
        old_quotes=sum(1 for line in old if "(page:" in line["says"]),
        new_quotes=sum(1 for line in new if "(page:" in line["says"]),
        old_numbers=sum(1 for line in old if re.match(r"\d{1,2}\.\s", line["says"])),
        new_numbers=sum(1 for line in new if re.match(r"\d{1,2}\.\s", line["says"])))
    return new


async def ask(engine: ChatEngine, message: str) -> tuple[dict[str, Any], dict[str, Any]]:
    request = ChatRequest.model_validate({"messages": [{"role": "user", "content": message}]})
    LAST.clear()
    try:
        result = await engine.answer(intake(request, now=NOW), request)
        body, trace = result.body, result.trace or {}
    except Exception as error:  # noqa: BLE001  The study reads every message.
        body, trace = {"answer": type(error).__name__}, {}
    return body, {"decidedBy": trace.get("decidedBy"), "answerCard": trace.get("answerCard"),
                  "winners": len(trace.get("answerCardWinners") or []),
                  "numbered": dict(LAST) or None}


async def main() -> None:
    facts = GraphOnlyFacts(Path(".published"))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    gateway = EmbedOnly(index.model)
    rows = json.loads((Path(__file__).parent / "practice_messages.json").read_text())
    gateway.learn([part for row in rows for part in PARTS_OF(row["message"])], index.dimensions)
    page_facts.numbered = recording  # type: ignore[assignment]

    def engine(cards: bool) -> ChatEngine:
        return ChatEngine(gateway, facts, output="written", howto_one_call=True,  # type: ignore[arg-type]
                          read_first=False, card_answers=cards, page_writer="ai")
    off, on = engine(False), engine(True)
    found = on._card_tasks(index)
    assert found is not None, "no cards beside the release"
    print(f"release {index.dataset_version}: {len(found.cards)} cards; {len(rows)} messages; "
          f"embedded with {gateway.tokens} tokens, ${gateway.tokens * EMBED_USD_PER_TOKEN:.6f}")
    out = []
    for row in rows:
        message = row["message"]
        parts = PARTS_OF(message)
        one_call.parts_of = PARTS_OF
        _, cards_off = await ask(off, message)
        said_built, cards_on = await ask(on, message)
        one_call.parts_of = lambda question: [question]  # type: ignore[assignment]
        said_one, one_part = await ask(on, message)
        one_call.parts_of = PARTS_OF
        request = ChatRequest.model_validate({"messages": [{"role": "user", "content": message}]})
        turn = intake(request, now=NOW)
        by_part = []
        for part in parts:
            trace: dict[str, Any] = {}
            try:
                done = on._card_answer(turn, trace, index, gateway.known[part])
            except Exception as error:  # noqa: BLE001
                done, trace = None, {"answerCard": {"why": type(error).__name__}}
            note = dict(trace.get("answerCard") or {})
            at = next((n for n, card in enumerate(found.cards) if card.get("id") == note.get("card")),
                      None)
            label = (one_call.unit_labels(index, [(str(found.cards[at]["members"][0]["record_id"]),
                                                   str(found.cards[at]["members"][0]["key"]))])[0]
                     if at is not None else None)
            by_part.append({"part": part, "note": note, "label": label,
                            "status": found.cards[at].get("status") if at is not None else None,
                            "answer": done.body.get("answer") if done is not None else None})
        record = {"id": row["id"], "wants": row["wants"], "message": message, "parts": len(parts),
                  "cards_off": cards_off, "cards_on": cards_on, "one_part": one_part,
                  "said_built": said_built.get("answer") if (cards_on["answerCard"] or {}).get("said")
                  else None, "by_part": by_part}
        out.append(record)
        gate_open = one_part["answerCard"] is not None
        print(f"\n{row['id']} parts={len(parts)} wants={row['wants']!r}")
        print(f"   Q: {message}")
        print(f"   cards off: {json.dumps(cards_off)}")
        print(f"   cards on:  {json.dumps(cards_on)}")
        print(f"   as one part, gate open: {gate_open}  {json.dumps(one_part['answerCard'])}")
        for n, item in enumerate(by_part):
            note = item["note"]
            print(f"   part {n} {item['part']!r}\n      -> {item['label']} [{item['status']}] "
                  f"score {note.get('score')} lead {note.get('lead')} said {note.get('said')} "
                  f"why {note.get('why')} near {len(note.get('near') or [])} "
                  f"ahead {bool(note.get('ahead'))}")
            if item["answer"]:
                for line in str(item["answer"]).splitlines():
                    print(f"      | {line}")
    print(f"\n== {gateway.refused} model calls refused, none made; embedded with {gateway.tokens} "
          f"tokens, ${gateway.tokens * EMBED_USD_PER_TOKEN:.6f}")
    blob = base64.b64encode(gzip.compress(json.dumps(out).encode())).decode()
    print("== RESULTS_B64_GZIP " + blob)


if __name__ == "__main__":
    asyncio.run(main())
