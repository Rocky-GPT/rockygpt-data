"""Temporary paid runs of the condition pairs (plan "Keep student conditions in answers", Dan
chose "Build Steps 0 to 2 on dev" 2026-11-19 00:24Z), never merged. Asks the frozen pair sets
(rockygpt-evals condition-pairs, hashes checked first) once with the Brain checked out (main for
the "before" run, the build branch for the "after" run), built as api/app.py builds production's:
output "written", how-to by one call, decide effort low, writer max 6000 tokens, the live graph
file read only. Keeps each answer, when it was asked, and the trace's read and conditions, so
check.py can hold every listed item to the labelled conditions. The ledger is kept in memory and
refuses every call once the spend could pass CAP_USD. DRY=1 makes no model call.
"""

import asyncio
import contextvars
import datetime
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import Gateway
import rockygpt_brain
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.settings import Prices, ProviderSettings
from rockygpt_brain.spending import Reservation, SpendingError
from rockygpt_brain.turn import intake

CAP_NUSD = int(float(os.environ.get("CAP_USD", "0.30")) * 1_000_000_000)  # This job's most.
AT_ONCE = int(os.environ.get("AT_ONCE", "3") or 3)
DRY = os.environ.get("DRY") == "1"
ARMS = [a for a in os.environ.get("ARMS", "live").split(",") if a]
TRIES = int(os.environ.get("TRIES", "1") or 1)
LIMIT = int(os.environ.get("LIMIT", "0") or 0)

CALLS: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar(
    "calls", default=None)
T0: contextvars.ContextVar[float | None] = contextvars.ContextVar("T0", default=None)
# The reply's text field in the writer's streamed arguments, and where a sentence ends in it
# (the arguments are JSON, so a line end shows as a backslash and an n).
REPLY_TEXT = re.compile(r'"text"\s*:\s*"')
REPLY_SENTENCE_END = re.compile(r'[.!?](?:\s|\\n|"|$)|\\n')
EFFORT: contextvars.ContextVar[str | None] = contextvars.ContextVar("effort", default=None)
CAP: contextvars.ContextVar[int | None] = contextvars.ContextVar("cap", default=None)




class MemoryLedger:
    """The Brain's ledger interface, kept in memory, with a hard cap."""

    def __init__(self) -> None:
        self.spent, self.calls, self.unsure, self.paused = 0, 0, 0, False
        self.held: dict[str, int] = {}

    async def ready(self) -> bool:
        return not self.paused

    async def reserve(self, request_id: str, amount_nusd: int, metadata: dict[str, Any],
                      now: datetime.datetime) -> Reservation:
        if self.paused or self.spent + sum(self.held.values()) + amount_nusd > CAP_NUSD:
            raise SpendingError("study_cap_reached")
        operation = uuid.uuid4().hex
        self.held[operation] = amount_nusd
        return Reservation(operation, amount_nusd)

    async def settle(self, reservation: Reservation, cost_nusd: int, usage: dict[str, int],
                     response_id: str, returned_model: str, now: datetime.datetime) -> None:
        self.held.pop(reservation.operation_id, None)
        self.spent += cost_nusd
        self.calls += 1

    async def uncertain(self, reservation: Reservation, code: str) -> None:
        self.unsure += 1  # The hold stays: counted at its worst case.

    async def release(self, reservation: Reservation, code: str, now: datetime.datetime) -> None:
        self.held.pop(reservation.operation_id, None)

    async def pause(self) -> None:
        self.paused = True


def _tool(request: dict[str, Any]) -> str:
    tools = request.get("tools") or []
    return str(tools[0].get("name")) if len(tools) == 1 else f"{len(tools)}-tools"


class TimedTransport:
    """The Brain's own request, sent as a stream so the first answer word can be timed. What
    comes back to the Brain is the same finished response it gets today."""

    def __init__(self, settings: ProviderSettings) -> None:
        from openai import AsyncOpenAI
        self._client = AsyncOpenAI(api_key=settings.api_key, max_retries=0,
                                   base_url="https://api.openai.com/v1")

    async def send(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        name = _tool(request)
        effort = EFFORT.get()
        if name == "write_answer" and effort is not None:
            request = {**request, "reasoning": {"effort": effort}}
        started = time.monotonic()
        first: float | None = None
        text_at: float | None = None      # When the reply's own text began (after the parts).
        sentence_at: float | None = None  # When the reply's first whole sentence had arrived.
        so_far = ""
        final: Any = None
        stream = await self._client.responses.create(**request, stream=True,
                                                     timeout=remaining_seconds)
        async for event in stream:
            kind = getattr(event, "type", "")
            if first is None and kind in ("response.function_call_arguments.delta",
                                          "response.output_text.delta"):
                first = time.monotonic() - started
            if (name == "write_answer" and sentence_at is None
                    and kind == "response.function_call_arguments.delta"):
                so_far += str(getattr(event, "delta", "") or "")
                opened = REPLY_TEXT.search(so_far)
                if opened and text_at is None:
                    text_at = time.monotonic() - started
                if opened and REPLY_SENTENCE_END.search(so_far, opened.end() + 40):
                    sentence_at = time.monotonic() - started
            if kind in ("response.completed", "response.incomplete", "response.failed"):
                final = event.response
        total = time.monotonic() - started
        if final is None:
            raise RuntimeError("stream ended without a response")
        data: dict[str, Any] = final.model_dump(exclude_none=True)
        usage = data.get("usage") or {}
        calls = CALLS.get()
        given = None
        if name != "read_message":
            given = str((request.get("input") or [{}])[-1].get("content") or "")[:40000]
        if calls is not None:
            calls.append({
                "given": given,
                "tool": name, "effort": (request.get("reasoning") or {}).get("effort"),
                "first": round(first, 2) if first is not None else None,
                "at": round(started - (T0.get() or started), 2),
                "text_at": round(text_at, 2) if text_at is not None else None,
                "sentence_at": round(sentence_at, 2) if sentence_at is not None else None,
                "sec": round(total, 2), "in": usage.get("input_tokens"),
                "cached": (usage.get("input_tokens_details") or {}).get("cached_tokens"),
                "out": usage.get("output_tokens"),
                "think": (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
                "status": data.get("status")})
        return data

    async def embed(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        started = time.monotonic()
        response = await self._client.embeddings.create(**request, timeout=remaining_seconds)
        calls = CALLS.get()
        if calls is not None:
            calls.append({"tool": "embedding", "sec": round(time.monotonic() - started, 2)})
        return response.model_dump(exclude_none=True)  # type: ignore[no-any-return]

    async def close(self) -> None:
        await self._client.close()


class DryTransport:
    """DRY=1: no model call. Answers the read and the writer in the provider's shape, and fails
    every other call the way a provider outage would, so the script runs once for free."""

    def __init__(self, model: str, dimensions: int) -> None:
        self.model, self.dimensions = model, dimensions

    async def send(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        name = _tool(request)
        if name == "read_message":
            latest = json.loads(request["input"][1]["content"])["latest_message"]
            said: dict[str, Any] = {"social": "none", "danger": "none", "needs": [],
                                    "limit": "none", "question": latest}
        elif name == "write_answer":
            said = {"parts": [{"asked": "it", "not_on_pages": False, "sections": [1]}],
                    "text": "This is a dry run reply [1]."}
        else:
            raise RuntimeError("dry run answers only the read and the writer")
        calls = CALLS.get()
        if calls is not None:
            calls.append({"tool": name, "effort": (request.get("reasoning") or {}).get("effort"),
                          "first": 0.0, "sec": 0.0, "in": len(json.dumps(request)) // 4,
                          "cached": 0, "out": 40, "think": 0, "status": "completed"})
        return {"id": "dry", "model": self.model, "status": "completed",
                "usage": {"input_tokens": len(json.dumps(request)) // 4, "output_tokens": 40,
                          "input_tokens_details": {"cached_tokens": 0}},
                "output": [{"type": "function_call", "call_id": "dry", "name": name,
                            "arguments": json.dumps(said)}]}

    async def embed(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        texts = request["input"] if isinstance(request["input"], list) else [request["input"]]
        vectors = []
        for text in texts:
            seed = sum(map(ord, text))
            vectors.append([((seed * (k + 3)) % 97 - 48) / 97 for k in range(self.dimensions)])
        return {"model": request["model"], "usage": {"prompt_tokens": 10 * len(texts)},
                "data": [{"index": k, "embedding": v} for k, v in enumerate(vectors)]}

    async def close(self) -> None:
        return None


CAMPUS = __import__("zoneinfo").ZoneInfo("America/New_York")


def flatten(path: Path) -> list[dict[str, Any]]:
    """Every version of every group, with its group's kind and area."""
    data = json.loads(path.read_text())
    return [{"id": v["id"], "group": g["id"], "kind": g["kind"], "area": g["area"],
             "changed": g.get("changed"), "question": v["question"], "slots": v.get("slots") or {}}
            for g in data["groups"] for v in g["versions"]]


async def ask(engine: ChatEngine, row: dict[str, Any], arm: str) -> dict[str, Any]:
    calls: list[dict[str, Any]] = []
    CALLS.set(calls)
    T0.set(time.monotonic())
    EFFORT.set("low")
    request = ChatRequest.model_validate({"messages": [{"role": "user",
                                                        "content": row["question"]}]})
    started = time.monotonic()
    asked_at = datetime.datetime.now(CAMPUS)
    try:
        result = await engine.answer(intake(request, now=asked_at), request)
        body, trace = result.body, result.trace or {}
        error = None
    except Exception as failure:  # noqa: BLE001  Every question is asked; the name is kept.
        body, trace, error = {}, {}, type(failure).__name__
    return {**row, "arm": arm, "asked_at": asked_at.isoformat(timespec="seconds"),
            "answer": str(body.get("answer") or ""), "status": body.get("status"),
            "sec": round(time.monotonic() - started, 2), "by": trace.get("decidedBy"),
            "read": trace.get("read"), "conditions": trace.get("conditions"),
            "path": trace.get("path"), "err": error,
            "tools": [c.get("tool") for c in calls]}


async def main() -> None:
    import hashlib
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    rows: list[dict[str, Any]] = []
    for name in [n for n in os.environ["SETS"].split(",") if n]:
        path = Path(name)
        sums = path.with_suffix(".sha256")
        if sums.exists():
            wanted = sums.read_text().split()[0]
            assert hashlib.sha256(path.read_bytes()).hexdigest() == wanted, f"{path} changed"
        rows += flatten(path)
    if LIMIT:
        rows = rows[:LIMIT]
    release = json.loads((Path(rockygpt_brain.__file__).parent
                          / "provider-release.json").read_text())
    far = datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC)
    prices = Prices(release["model"], release["input_nusd_per_token"],
                    release["output_nusd_per_token"], release["cached_input_nusd_per_token"],
                    datetime.datetime.fromisoformat(release["valid_until"]))
    settings = ProviderSettings(
        environment="development", api_key=os.environ.get("BRAIN_OPENAI_API_KEY", "dry"),
        project=None,  # type: ignore[arg-type]
        ledger_url="", prices=prices, writer_max_output_tokens=6000,
        embed_prices=Prices("text-embedding-3-large", 130, 1, 0, far), decide_effort="low")
    ledger = MemoryLedger()
    transport: Any = (DryTransport(prices.model, index.dimensions) if DRY
                      else TimedTransport(settings))
    gateway = Gateway(settings, ledger=ledger, transport=transport)
    arm = ARMS[0]
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True,
                        max_turn_nusd=settings.max_turn_nusd)
    print(f"release {facts.active_release()[0]}; questions {len(rows)}; arm {arm}; dry {DRY}")
    print("warm seconds", round(sum(engine.warm().values()), 1))
    done: list[dict[str, Any]] = []
    gate = asyncio.Semaphore(AT_ONCE)

    async def one(row: dict[str, Any]) -> None:
        async with gate:
            # A task of its own, so one question's picks never leak into another's.
            done.append(await asyncio.create_task(ask(engine, row, arm)))

    started = time.monotonic()
    await asyncio.gather(*(one(row) for row in rows))
    await gateway.close()
    done.sort(key=lambda r: r["id"])
    Path(os.environ.get("OUT", "rows.json")).write_text(json.dumps(
        {"release": facts.active_release()[0], "arm": arm, "rows": done}, ensure_ascii=False))
    print(f"done in {round(time.monotonic() - started)} s; errors "
          f"{sum(1 for r in done if r['err'])}; by "
          f"{dict(__import__('collections').Counter(r['by'] for r in done))}")
    print(f"TOTAL spent ${ledger.spent / 1e9:.4f} in {ledger.calls} settled calls; "
          f"held ${sum(ledger.held.values()) / 1e9:.4f}; unsure {ledger.unsure}")
    sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
