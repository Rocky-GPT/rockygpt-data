"""Temporary free measurement for the overnight audit of 2026-11-17 (never merged).

How much memory and processor time does the Brain need to answer, in a box the size of the live
one (512 MB, half a processor)? The workflow runs this script inside such a box. It answers
practice messages (not the frozen blind 60) with the Brain's real answer code and a graph file,
but no model: every model call is answered by a stand-in here, so the run costs nothing. It prints
the memory the process holds as it goes. If the box runs out of memory the system stops the
process, and the lines printed so far show how far it got.
"""

import asyncio
import datetime
import inspect
import json
import os
import statistics
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import rockygpt_brain
from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import Gateway
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.settings import Prices, ProviderSettings
from rockygpt_brain.spending import Reservation
from rockygpt_brain.turn import intake

WRITER = os.environ.get("WRITER", "ai")
LAPS = [int(n) for n in os.environ.get("AT_ONCE", "1,2,4").split(",")]
LIMIT = int(os.environ.get("LIMIT", "0") or 0)


def say(*parts: Any) -> None:
    print(*parts, flush=True)


def held_mb() -> int:
    """Resident memory of this process, MB."""
    return round(int(open("/proc/self/statm").read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6)


def peak_mb() -> int:
    for line in open("/proc/self/status"):
        if line.startswith("VmHWM"):
            return round(int(line.split()[1]) / 1e3)
    return -1


def box() -> str:
    """The box's own count (cgroup), when the system shows one."""
    out = []
    for name in ("memory.current", "memory.peak", "memory.max"):
        for root in ("/sys/fs/cgroup" + open("/proc/self/cgroup").read().strip().split("::")[-1],):
            try:
                value = open(f"{root}/{name}").read().strip()
                out.append(f"{name} {round(int(value) / 1e6)} MB" if value.isdigit()
                           else f"{name} {value}")
            except (OSError, ValueError):
                pass
    return "; ".join(out)


class FreeLedger:
    async def ready(self) -> bool:
        return True

    async def reserve(self, request_id: str, amount_nusd: int, *args: Any,
                      **kwargs: Any) -> Reservation:
        return Reservation(uuid.uuid4().hex, amount_nusd)

    async def settle(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def uncertain(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def release(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def pause(self) -> None:
        return None


def made(schema: dict[str, Any], latest: str) -> Any:
    """A value the tool's own schema allows: the stand-in for what a model would send."""
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), "string")
    if "enum" in schema:
        return schema["enum"][0]
    if kind == "object":
        return {name: made(part, latest) for name, part in (schema.get("properties") or {}).items()
                if name in (schema.get("required") or [])}
    if kind == "array":
        return [made(schema.get("items") or {}, latest)]
    if kind == "integer" or kind == "number":
        return 1
    if kind == "boolean":
        return False
    return latest


class StandIn:
    """No model: each call gets an answer its tool's schema allows. The read keeps the student's
    message as the question, so the turn goes on to search and write like a real one."""

    def __init__(self, model: str, dimensions: int) -> None:
        self.model, self.dimensions, self.calls = model, dimensions, 0

    async def send(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        self.calls += 1
        tools = request.get("tools") or []
        if len(tools) != 1:
            raise RuntimeError("the stand-in answers one-tool calls only")
        name = tools[0]["name"]
        latest = "This is a stand-in reply [1]."
        if name == "read_message":
            latest = json.loads(request["input"][1]["content"])["latest_message"]
        said = made(tools[0].get("parameters") or {}, latest)
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


async def main() -> None:
    here = Path(__file__).parent
    say(f"writer {WRITER}; brain code {os.environ.get('BRAIN_REF', '?')}; processors seen "
        f"{os.cpu_count()}; box: {box()}")
    say(f"after imports {held_mb()} MB")
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    say(f"release {facts.active_release()[0]}; search units {len(index.units)}; vectors "
        f"{len(index.owner) if hasattr(index, 'owner') else '?'}; graph + index open "
        f"{held_mb()} MB")
    rows = json.loads((here / "questions.json").read_text()) + json.loads(
        (here / "read_messages.json").read_text())
    if LIMIT:
        rows = rows[:LIMIT]
    release = json.loads((Path(rockygpt_brain.__file__).parent
                          / "provider-release.json").read_text())
    far = datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC)
    prices = Prices(release["model"], release["input_nusd_per_token"],
                    release["output_nusd_per_token"], release["cached_input_nusd_per_token"], far)
    wanted = {"environment": "development", "api_key": "dry", "project": None, "ledger_url": "",
              "prices": prices, "writer_max_output_tokens": 6000,
              "embed_prices": Prices("text-embedding-3-large", 130, 1, 0, far)}
    fields = inspect.signature(ProviderSettings).parameters
    settings = ProviderSettings(**{k: v for k, v in wanted.items() if k in fields})
    transport = StandIn(prices.model, index.dimensions)
    gateway = Gateway(settings, ledger=FreeLedger(), transport=transport)
    options = {"output": "written", "howto_one_call": True, "page_writer": WRITER}
    accepted = inspect.signature(ChatEngine.__init__).parameters
    engine = ChatEngine(gateway, facts, **{k: v for k, v in options.items() if k in accepted})
    started = time.monotonic()
    engine.warm()
    say(f"after warm {held_mb()} MB (peak {peak_mb()} MB); warm took "
        f"{round(time.monotonic() - started, 1)} s; box: {box()}")

    async def ask(row: dict[str, Any]) -> tuple[float, str]:
        request = ChatRequest.model_validate({"messages": [{"role": "user",
                                                            "content": row["question"]}]})
        begun = time.monotonic()
        try:
            result = await engine.answer(intake(request), request)
            how = str((result.trace or {}).get("decidedBy"))
        except Exception as failure:  # noqa: BLE001  Only the kind of failure is kept.
            how = "error:" + type(failure).__name__
        return time.monotonic() - begun, how

    for at_once in LAPS:
        gate = asyncio.Semaphore(at_once)
        seconds: list[float] = []
        ways: dict[str, int] = {}
        done = 0

        async def one(row: dict[str, Any]) -> None:
            nonlocal done
            async with gate:
                took, how = await ask(row)
            seconds.append(took)
            ways[how] = ways.get(how, 0) + 1
            done += 1
            if done % 40 == 0:
                say(f"  {at_once} at once: after {done} messages {held_mb()} MB (peak "
                    f"{peak_mb()} MB)")

        begun = time.monotonic()
        await asyncio.gather(*(one(row) for row in rows))
        page = sorted(seconds)
        say(f"LAP {at_once} at once: {len(rows)} messages in {round(time.monotonic() - begun)} s; "
            f"code seconds an answer middle {round(statistics.median(page), 2)}, 90th "
            f"{round(page[int(len(page) * 0.9) - 1], 2)}, slowest {round(page[-1], 2)}; ways "
            f"{ways}; holds {held_mb()} MB, peak so far {peak_mb()} MB; box: {box()}; stand-in "
            f"calls {transport.calls}")
    say("FINISHED without running out of memory")


if __name__ == "__main__":
    asyncio.run(main())
