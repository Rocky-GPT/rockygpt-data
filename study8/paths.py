"""Temporary paid check for audit plan item 8 (2026-11-17, never merged): on the practice messages
(not the frozen blind set), which path each message takes by the old word rules and by the read's
new topic. Only the read is called (three votes a message, as production reads), nothing is
answered. Rows go to OUT for reading by hand."""

import asyncio
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import blind  # noqa: E402  The ledger with its cap, the transport, the settings.
import rockygpt_brain  # noqa: E402
from rockygpt_brain.context import build_context  # noqa: E402
from rockygpt_brain.contract import ChatRequest  # noqa: E402
from rockygpt_brain.engine import ChatEngine, picked_path  # noqa: E402
from rockygpt_brain.provider import Gateway  # noqa: E402
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts  # noqa: E402
from rockygpt_brain.router import code_route  # noqa: E402
from rockygpt_brain.settings import Prices, ProviderSettings  # noqa: E402
from rockygpt_brain.turn import intake  # noqa: E402


def route(engine: ChatEngine, topic: str | None, message: str, lists: Any, buildings: Any,
          programs: Any, people: Any) -> str:
    """The path _campus_answer takes for a first message, before any model answers."""
    path = picked_path(topic, message)
    if programs[0] or programs[2] or path.calendar or people or path.people:
        return ("events_clubs" if path.calendar else "people" if (people or path.people)
                else "programs")
    if path.pages and not code_route(message, lists[1], lists[3], buildings):
        return "pages"
    if code_route(message, lists[1], lists[3], buildings):
        return "code_lookup"
    return "lookup_loop"


async def main() -> None:
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    here = Path(__file__).parent
    rows = [*json.loads((here / "practice-30.json").read_text()),
            *json.loads((here / "practice-194.json").read_text())]
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
    ledger = blind.MemoryLedger()
    transport = blind.TimedTransport(settings)
    gateway = Gateway(settings, ledger=ledger, transport=transport)
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True, read_first=True,
                        page_writer="direct", max_turn_nusd=settings.max_turn_nusd)
    engine.warm()
    lists = await engine._lists()
    buildings = engine._buildings()
    gate = asyncio.Semaphore(4)
    out: list[dict[str, Any]] = []

    async def one(row: dict[str, Any]) -> None:
        async with gate:
            request = ChatRequest.model_validate(
                {"messages": [{"role": "user", "content": row["question"]}]})
            turn, context = intake(request), build_context(request)
            trace: dict[str, Any] = {}
            got: dict[str, Any] = {"id": row["id"], "set": row.get("set") or row.get("group"),
                                   "message": row["question"]}
            if await engine._code_understands(context):
                got["by"] = "code_understood"
                out.append(got)
                return
            reading = await engine._read(turn, context, trace)
            if reading is None:
                got["by"] = "read_failed"
                out.append(got)
                return
            reading = await engine._read_checked(context, reading, trace)
            asked = await engine._asked(context, reading, False)
            question = asked or row["question"]
            got.update(reading=reading.as_trace(), asked=question,
                       votes=[r.get("topic") for r in trace["read"].get("reads", [])])
            if not reading.question:
                got["by"] = "code_reply"
                out.append(got)
                return
            programs = engine._programs_named(question)
            people = engine._people_named(question)
            got["old"] = route(engine, None, question, lists, buildings, programs, people)
            got["new"] = route(engine, reading.topic, question, lists, buildings, programs,
                               people)
            out.append(got)

    await asyncio.gather(*(one(r) for r in rows))
    await gateway.close()
    out.sort(key=lambda r: r["id"])
    Path(os.environ.get("OUT", "paths.json")).write_text(json.dumps(out, ensure_ascii=False,
                                                                     indent=1))
    moved = [r for r in out if r.get("old") != r.get("new")]
    print(f"messages {len(out)}; moved {len(moved)}")
    for r in moved:
        print(f"{r['id']}: {r['old']} -> {r['new']} ({r['reading']['topic']}; votes "
              f"{r['votes']}) {r['asked']}")
    print(f"TOTAL spent ${ledger.spent / 1e9:.4f} in {ledger.calls} calls")


if __name__ == "__main__":
    asyncio.run(main())
