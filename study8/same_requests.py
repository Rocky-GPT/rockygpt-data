"""Temporary free check for audit plan item 13 (2026-11-17, never merged): the Brain before and
after the removals sends the model byte-identical requests and gives identical answers on the 224
practice messages, with production's settings (direct page writer, code's lookup sentences). No
model is called: the dry transport answers the read and the writer and fails every other call.
The campus clock is fixed so the two runs can be compared. Writes {id: {sent, body}} to OUT."""

import asyncio
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
os.environ["DRY"] = "1"
import blind  # noqa: E402
import rockygpt_brain  # noqa: E402
from rockygpt_brain.contract import ChatRequest  # noqa: E402
from rockygpt_brain.engine import ChatEngine  # noqa: E402
from rockygpt_brain.provider import Gateway  # noqa: E402
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts  # noqa: E402
from rockygpt_brain.settings import Prices, ProviderSettings  # noqa: E402
from rockygpt_brain.turn import intake  # noqa: E402

SENT: list[str] = []
NOW = datetime.datetime(2026, 11, 17, 20, 0, tzinfo=datetime.UTC)


class Hashing(blind.DryTransport):
    async def send(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        SENT.append(blind._tool(request) + ":" + hashlib.sha256(
            json.dumps(request, sort_keys=True).encode()).hexdigest()[:16])
        return await super().send(request, remaining_seconds)


async def main() -> None:
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    index = facts.meaning_index()
    here = Path(__file__).parent
    rows = [*json.loads((here / "practice-30.json").read_text()),
            *json.loads((here / "practice-194.json").read_text())]
    release = json.loads((Path(rockygpt_brain.__file__).parent
                          / "provider-release.json").read_text())
    far = datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC)
    prices = Prices(release["model"], release["input_nusd_per_token"],
                    release["output_nusd_per_token"], release["cached_input_nusd_per_token"], far)
    settings = ProviderSettings(
        environment="development", api_key="dry", project=None,  # type: ignore[arg-type]
        ledger_url="", prices=prices, writer_max_output_tokens=6000,
        embed_prices=Prices("text-embedding-3-large", 130, 1, 0, far), decide_effort="low")
    gateway = Gateway(settings, ledger=blind.MemoryLedger(),
                      transport=Hashing(prices.model, index.dimensions))
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True, read_first=True,
                        max_turn_nusd=settings.max_turn_nusd)
    engine.warm()
    record: dict[str, Any] = {}
    for row in rows:
        SENT.clear()
        request = ChatRequest.model_validate(
            {"messages": [{"role": "user", "content": row["question"]}]})
        try:
            result = await engine.answer(intake(request, now=NOW), request)
            body = json.dumps({k: result.body.get(k) for k in ("answer", "status", "citations")},
                              sort_keys=True)
            by = (result.trace or {}).get("decidedBy")
        except Exception as failure:  # noqa: BLE001
            body, by = type(failure).__name__, "error"
        record[row["id"]] = {"sent": list(SENT), "by": by,
                             "body": hashlib.sha256(body.encode()).hexdigest()[:16]}
    await gateway.close()
    Path(os.environ["OUT"]).write_text(json.dumps(record, indent=0))
    print("answered", len(record), "by", {b: sum(1 for r in record.values() if r["by"] == b)
                                           for b in {r["by"] for r in record.values()}})


if __name__ == "__main__":
    asyncio.run(main())
