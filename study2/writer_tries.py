"""Temporary paid measurement for the overnight audit of 2026-11-17 (never merged).

Second run. The first run showed the page writer spends most of its seconds thinking before its
first answer word, and that asked to think at "low" effort a whole answer took 6.4 s instead of
15.0 s. Whether the answers stay as good is not known. This run asks the same 30 older how-to
practice questions (rockygpt-evals page-writer-check-2026-11-16; the frozen blind 60 is not used)
TRIES times with one arm, and prints every answer whole, so the two sets of answers can be graded
side by side later with no new spend.

Arms (ARMS picks one a job):
  sections      the sections writer as built (the model's default thinking effort, medium)
  sections-low  the same, the writer call asked to think at "low" effort
  ai-low        production's writer today (two-stage "ai"), its writer call at "low" effort

Nothing in the bot changes and nothing is written anywhere. The ledger is kept in memory and
refuses every call once the spend could pass CAP_NUSD. DRY=1 makes no model call at all.
"""

import asyncio
import contextvars
import datetime
import json
import os
import statistics
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import Gateway
from rockygpt_brain.retrieval import section_search
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.settings import Prices, ProviderSettings
from rockygpt_brain.spending import Reservation, SpendingError
from rockygpt_brain.turn import intake

CAP_NUSD = int(float(os.environ.get("CAP_USD", "0.30")) * 1_000_000_000)  # This job's most.
AT_ONCE = int(os.environ.get("AT_ONCE", "3") or 3)
DRY = os.environ.get("DRY") == "1"
ARMS = [a for a in os.environ.get("ARMS", "sections-low").split(",") if a]
TRIES = int(os.environ.get("TRIES", "1") or 1)
LIMIT = int(os.environ.get("LIMIT", "0") or 0)

CALLS: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar(
    "calls", default=None)
EFFORT: contextvars.ContextVar[str | None] = contextvars.ContextVar("effort", default=None)
CAP: contextvars.ContextVar[int | None] = contextvars.ContextVar("cap", default=None)

_sections = section_search.sections


def _sections_capped(*args: Any, **kwargs: Any) -> Any:
    cap = CAP.get()
    if cap is not None and "cap" not in kwargs:
        kwargs["cap"] = cap
    return _sections(*args, **kwargs)


section_search.sections = _sections_capped  # type: ignore[assignment]


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
        final: Any = None
        stream = await self._client.responses.create(**request, stream=True,
                                                     timeout=remaining_seconds)
        async for event in stream:
            kind = getattr(event, "type", "")
            if first is None and kind in ("response.function_call_arguments.delta",
                                          "response.output_text.delta"):
                first = time.monotonic() - started
            if kind in ("response.completed", "response.incomplete", "response.failed"):
                final = event.response
        total = time.monotonic() - started
        if final is None:
            raise RuntimeError("stream ended without a response")
        data: dict[str, Any] = final.model_dump(exclude_none=True)
        usage = data.get("usage") or {}
        calls = CALLS.get()
        if calls is not None:
            calls.append({
                "tool": name, "effort": (request.get("reasoning") or {}).get("effort"),
                "first": round(first, 2) if first is not None else None,
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


def _host(url: str) -> str:
    return url.split("://", 1)[-1].rstrip("/").casefold()


def cites(row: dict[str, Any], citations: list[dict[str, Any]], answer: str) -> bool | None:
    """Whether the reply cites a page the graders said the answer needs (the row's facts)."""
    wanted = [_host(u) for fact in row.get("facts") or [] for u in fact.get("urls") or []]
    if not wanted:
        return None
    given = [_host(str(c.get("url") or "")) for c in citations]
    return any(w in g or g in w for w in wanted for g in given if g)


async def ask(engine: ChatEngine, row: dict[str, Any], arm: str, run: int) -> dict[str, Any]:
    calls: list[dict[str, Any]] = []
    CALLS.set(calls)
    EFFORT.set({"sections-low": "low", "sections-none": "none", "ai-low": "low"}.get(arm))
    CAP.set(10 if arm == "sections-10" else None)
    request = ChatRequest.model_validate({"messages": [{"role": "user",
                                                        "content": row["question"]}]})
    started = time.monotonic()
    try:
        result = await engine.answer(intake(request), request)
        body, trace = result.body, result.trace or {}
        error = None
    except Exception as failure:  # noqa: BLE001  Every question is asked; the name is kept.
        body, trace, error = {}, {}, type(failure).__name__
    answer = str(body.get("answer") or "")
    return {
        "id": row["id"], "arm": arm, "group": row.get("group"), "run": run,
        "question": row["question"],
        "answered_at": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "body": {key: body.get(key) for key in ("answer", "status", "citations",
                                                "datasetVersion")},
        "sec": round(time.monotonic() - started, 2), "status": body.get("status"),
        "by": trace.get("decidedBy"), "writer": trace.get("pageWriter"),
        "second": bool(trace.get("oneCallSecondLook")),
        "dropped": len(trace.get("unsupported_dropped") or []),
        "fell_back": bool((trace.get("pageFacts") or {}).get("fell_back")),
        "sections": (trace.get("oneCall") or {}).get("sections"),
        "chars": len(answer), "no_info": "don't have verified" in answer,
        "cites": cites(row, body.get("citations") or [], answer),
        "n_cited": len(body.get("citations") or []), "err": error, "calls": calls,
        "answer": answer,
    }


def middle(values: list[float]) -> float | None:
    return round(statistics.median(values), 2) if values else None


def summary(rows: list[dict[str, Any]]) -> list[str]:
    lines = []
    for arm in ARMS:
        mine = [r for r in rows if r["arm"] == arm]
        page = [r for r in mine if r["by"] == "one_call"]
        writers = [c for r in page for c in r["calls"] if c["tool"] == "write_answer"]
        firsts = [float(c["first"]) for c in writers if c.get("first") is not None]
        lines.append(
            f"ARM {arm}: asked {len(mine)}, page answers {len(page)}, errors "
            f"{sum(1 for r in mine if r['err'])}; whole answer seconds middle "
            f"{middle([r['sec'] for r in page])}, 90th "
            f"{round(sorted(r['sec'] for r in page)[int(len(page) * 0.9) - 1], 2) if page else None}"
            f"; writer calls {len(writers)}: seconds to first answer word middle {middle(firsts)}"
            f", writer seconds middle {middle([float(c['sec']) for c in writers])}; tokens middle"
            f" read {middle([float(c['in'] or 0) for c in writers])}"
            f" cached {middle([float(c['cached'] or 0) for c in writers])}"
            f" written {middle([float(c['out'] or 0) for c in writers])}"
            f" of them thinking {middle([float(c['think'] or 0) for c in writers])}"
            f"; reply chars middle {middle([float(r['chars']) for r in page])}"
            f"; cites a graders' page {sum(1 for r in page if r['cites'])} of "
            f"{sum(1 for r in page if r['cites'] is not None)}"
            f"; says no verified info {sum(1 for r in page if r['no_info'])}"
            f"; second looks {sum(1 for r in page if r['second'])}"
            f"; seconds outside model calls middle "
            f"{middle([r['sec'] - sum(max(float(c['sec']) for c in r['calls'] if c['tool'] == t) if t in ('read_message', 'pick_units') else sum(float(c['sec']) for c in r['calls'] if c['tool'] == t) for t in {c['tool'] for c in r['calls']}) for r in page])}"
            f"; whole answer mean {round(sum(r['sec'] for r in page) / max(len(page), 1), 2)}"
            f"; fell back {sum(1 for r in page if r['fell_back'])}")
        for tool in sorted({c["tool"] for r in mine for c in r["calls"]}):
            each = [c for r in mine for c in r["calls"] if c["tool"] == tool]
            lines.append(
                f"    {tool}: {len(each)} calls, seconds middle "
                f"{middle([float(c['sec']) for c in each])}, first word "
                f"{middle([float(c['first']) for c in each if c.get('first') is not None])}"
                f", read {middle([float(c.get('in') or 0) for c in each])}"
                f", written {middle([float(c.get('out') or 0) for c in each])}"
                f", thinking {middle([float(c.get('think') or 0) for c in each])}")
    return lines


async def main() -> None:
    here = Path(__file__).parent
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    rows = json.loads((here / "questions.json").read_text())
    if LIMIT:
        rows = rows[:LIMIT]
    release = json.loads((Path(section_search.__file__).parent.parent
                          / "provider-release.json").read_text())
    far = datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC)
    prices = Prices(release["model"], release["input_nusd_per_token"],
                    release["output_nusd_per_token"], release["cached_input_nusd_per_token"],
                    datetime.datetime.fromisoformat(release["valid_until"]))
    settings = ProviderSettings(
        environment="development", api_key=os.environ.get("BRAIN_OPENAI_API_KEY", "dry"),
        project=None,  # type: ignore[arg-type]
        ledger_url="", prices=prices, writer_max_output_tokens=6000,
        embed_prices=Prices("text-embedding-3-large", 130, 1, 0, far))
    ledger = MemoryLedger()
    transport: Any = (DryTransport(prices.model, index.dimensions) if DRY
                      else TimedTransport(settings))
    gateway = Gateway(settings, ledger=ledger, transport=transport)
    engines = {
        "ai": ChatEngine(gateway, facts, output="written", howto_one_call=True,
                         page_writer="ai", max_turn_nusd=settings.max_turn_nusd),
        "sections": ChatEngine(gateway, facts, output="written", howto_one_call=True,
                               page_writer="sections", max_turn_nusd=settings.max_turn_nusd),
    }
    print(f"release {facts.active_release()[0]}; units {len(index.units)}; pages marked "
          f"{len(index.pages)}; questions {len(rows)}; arms {ARMS}; dry {DRY}")
    warm = engines["sections"].warm()
    print("warm seconds", round(sum(warm.values()), 1))
    engines["ai"].warm()
    done: list[dict[str, Any]] = []
    gate = asyncio.Semaphore(AT_ONCE)

    async def one(row: dict[str, Any], arm: str, run: int) -> None:
        async with gate:
            engine = engines["ai" if arm.startswith("ai") else "sections"]
            # A task of its own, so the arm's settings never leak into another question.
            done.append(await asyncio.create_task(ask(engine, row, arm, run)))

    for arm in ARMS:
        for run in range(1, TRIES + 1):
            started = time.monotonic()
            await asyncio.gather(*(one(row, arm, run) for row in rows))
            print(f"arm {arm} try {run} done in {round(time.monotonic() - started)} s; spent so "
                  f"far ${ledger.spent / 1e9:.4f} in {ledger.calls} calls; unsure {ledger.unsure}")
    await gateway.close()
    print("=== ROWS (every answer whole)")
    for r in (done if os.environ.get("ROWS", "1") != "0" else []):
        print("SAVE " + json.dumps({k: v for k, v in r.items() if k != "answer"},
                                   ensure_ascii=False, separators=(",", ":")))
    print("=== SUMMARY")
    for line in summary(done):
        print(line)
    print(f"TOTAL spent ${ledger.spent / 1e9:.4f} in {ledger.calls} settled calls; "
          f"held ${sum(ledger.held.values()) / 1e9:.4f}; unsure {ledger.unsure}")
    sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
