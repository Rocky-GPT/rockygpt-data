"""Temporary paid check for audit item 7, 2026-11-17 (never merged): the Brain branch with the
streamed route, served over HTTP on the runner, asked 10 practice questions with the student
site's own header (Accept: text/event-stream). Prints when the first draft and the result came,
and checks the result body is a normal answer. Real OpenAITransport (the code under test), an
in-memory ledger capped at CAP_USD, the live graph read only."""

import asyncio
import datetime
import json
import os
import statistics
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import uvicorn

import rockygpt_brain
from rockygpt_brain.api.app import create_app
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import Gateway, OpenAITransport
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.settings import Prices, ProviderSettings
from rockygpt_brain.spending import Reservation, SpendingError

CAP_NUSD = int(float(os.environ.get("CAP_USD", "0.05")) * 1_000_000_000)


class MemoryLedger:
    def __init__(self) -> None:
        self.spent, self.calls, self.held = 0, 0, {}

    async def ready(self) -> bool:
        return True

    async def reserve(self, request_id: str, amount: int, metadata: dict[str, Any],
                      now: datetime.datetime) -> Reservation:
        if self.spent + sum(self.held.values()) + amount > CAP_NUSD:
            raise SpendingError("study_cap_reached")
        op = uuid.uuid4().hex
        self.held[op] = amount
        return Reservation(op, amount)

    async def settle(self, r: Reservation, cost: int, usage: dict[str, int], rid: str,
                     model: str, now: datetime.datetime) -> None:
        self.held.pop(r.operation_id, None)
        self.spent += cost
        self.calls += 1

    async def uncertain(self, r: Reservation, code: str) -> None:
        pass

    async def release(self, r: Reservation, code: str, now: datetime.datetime) -> None:
        self.held.pop(r.operation_id, None)

    async def pause(self) -> None:
        pass


async def main() -> None:
    facts = GraphOnlyFacts(Path(".published"))
    release = json.loads((Path(rockygpt_brain.__file__).parent
                          / "provider-release.json").read_text())
    far = datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC)
    prices = Prices(release["model"], release["input_nusd_per_token"],
                    release["output_nusd_per_token"], release["cached_input_nusd_per_token"],
                    datetime.datetime.fromisoformat(release["valid_until"]))
    settings = ProviderSettings(
        environment="development", api_key=os.environ["BRAIN_OPENAI_API_KEY"],
        project=None,  # type: ignore[arg-type]
        ledger_url="", prices=prices, writer_max_output_tokens=6000,
        embed_prices=Prices("text-embedding-3-large", 130, 1, 0, far), decide_effort="low")
    ledger = MemoryLedger()
    gateway = Gateway(settings, ledger=ledger, transport=OpenAITransport(settings))
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True,
                        page_writer="direct", max_turn_nusd=settings.max_turn_nusd)
    print("warm seconds", round(sum(engine.warm().values()), 1))
    app = create_app(engine, service_token="", environment="development")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8765, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.1)
    rows = json.loads((Path(__file__).parent / "questions.json").read_text())[:10]
    firsts, totals, drafts_n = [], [], []
    async with httpx.AsyncClient(timeout=90) as client:
        for row in rows:
            question = row.get("question") or row.get("q") or row.get("text")
            started = time.monotonic()
            first = None
            n = 0
            result: dict[str, Any] | None = None
            event = ""
            async with client.stream("POST", "http://127.0.0.1:8765/v1/chat",
                                     json={"messages": [{"role": "user", "content": question}]},
                                     headers={"accept": "text/event-stream"}) as response:
                kind = response.headers.get("content-type")
                async for line in response.aiter_lines():
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data = json.loads(line[5:])
                        if event == "progress" and data.get("draft"):
                            n += 1
                            first = first or time.monotonic() - started
                        elif event == "result":
                            result = data
            total = time.monotonic() - started
            body = (result or {}).get("body") or {}
            print(json.dumps({"q": question[:70], "type": kind, "first_draft": round(first, 2)
                              if first else None, "drafts": n, "total": round(total, 2),
                              "status": (result or {}).get("status"),
                              "answer": (body.get("answer") or "")[:160]}, ensure_ascii=False))
            totals.append(total)
            if first:
                firsts.append(first)
            drafts_n.append(n)
    server.should_exit = True
    await serving
    await gateway.close()
    first_middle = f"{statistics.median(firsts):.2f}" if firsts else "none"
    print(f"SUMMARY questions {len(rows)}; with a draft {len(firsts)}; first draft middle "
          f"{first_middle} s; result middle "
          f"{statistics.median(totals):.2f} s; drafts per answer middle {statistics.median(drafts_n)}; "
          f"spent ${ledger.spent / 1e9:.4f} in {ledger.calls} calls")


asyncio.run(main())
