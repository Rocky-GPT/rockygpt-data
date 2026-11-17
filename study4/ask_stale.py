"""Temporary, on this work branch only: a paid check for the overnight audit of 2026-11-17 (about
2 cents, capped at 10). The library's page now lists Thanksgiving special hours and the club list
changed since July, but campus hours and clubs are re-read only about twice a year. This asks the
Brain nine plain questions about them, against the live graph file (read only), and prints each
answer beside the date the facts were collected. Nothing in the bot changes and nothing is
written anywhere. Removed before anything from this branch merges."""
import asyncio
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "study2"))
import writer_tries as w  # noqa: E402  The same in-memory ledger and transport as the earlier tests.

from rockygpt_brain.engine import ChatEngine  # noqa: E402
from rockygpt_brain.provider import Gateway  # noqa: E402
from rockygpt_brain.retrieval import section_search  # noqa: E402
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts  # noqa: E402
from rockygpt_brain.settings import Prices, ProviderSettings  # noqa: E402

QUESTIONS = [
    "Is the library open on Thanksgiving?",
    "What are the library hours on Friday, November 27?",
    "Is the library open on Wednesday, November 25?",
    "What time does the library open on Sunday, November 29?",
    "What are the library hours this Thursday?",
    "What are the hours of the Multicultural Center?",
    "What are the hours of the Veterans Lounge?",
    "Is there a photography club?",
    "Is there an Albanian student club?",
]


def ages(facts: GraphOnlyFacts) -> None:
    days: dict[str, set[str]] = {}
    with facts.snapshot() as snap:
        print("release", snap.dataset_version)
        for entity in snap.entities:
            collections = {link.get("collection") for link in entity.get("links") or []}
            if "campus_hours" in collections:
                for row in snap.schedule_reader(entity):
                    days.setdefault("campus_hours", set()).add(str(row.get("collected_at"))[:10])
                    if row.get("name") == "Library (Main Building)" and row.get("day") in ("Wednesday", "Friday"):
                        print("LIBRARY_ROW", json.dumps({key: str(row.get(key))[:160] for key in
                              ("day", "schedule", "notes", "collected_at", "valid_from", "valid_until")}))
            if "clubs" in collections:
                for row in snap.record_reader(entity, "clubs"):
                    days.setdefault("clubs", set()).add(str(row.get("collected_at"))[:10])
    print("COLLECTED", json.dumps({key: sorted(value) for key, value in days.items()}))


async def main() -> None:
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    ages(facts)
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    release = json.loads((Path(section_search.__file__).parent.parent / "provider-release.json").read_text())
    far = datetime.datetime(2027, 1, 1, tzinfo=datetime.UTC)
    prices = Prices(release["model"], release["input_nusd_per_token"], release["output_nusd_per_token"],
                    release["cached_input_nusd_per_token"],
                    datetime.datetime.fromisoformat(release["valid_until"]))
    settings = ProviderSettings(
        environment="development", api_key=os.environ.get("BRAIN_OPENAI_API_KEY", "dry"),
        project=None,  # type: ignore[arg-type]
        ledger_url="", prices=prices, writer_max_output_tokens=6000,
        embed_prices=Prices("text-embedding-3-large", 130, 1, 0, far))
    ledger = w.MemoryLedger()
    transport: Any = (w.DryTransport(prices.model, index.dimensions) if w.DRY else w.TimedTransport(settings))
    gateway = Gateway(settings, ledger=ledger, transport=transport)
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True, page_writer="ai",
                        max_turn_nusd=settings.max_turn_nusd)
    engine.warm()
    print("today", datetime.datetime.now(datetime.UTC).isoformat(timespec="minutes"))
    for number, question in enumerate(QUESTIONS, 1):
        result = await asyncio.create_task(w.ask(engine, {"id": f"s{number}", "question": question}, "ai", 1))
        print("ANSWER", json.dumps({"n": number, "q": question, "status": result["status"], "by": result["by"],
                                    "sec": result["sec"], "err": result["err"],
                                    "cited": [c.get("url") for c in (result["body"].get("citations") or [])][:4],
                                    "answer": result["answer"]}))
    print("SPENT", json.dumps({"usd": round(ledger.spent / 1e9, 4), "calls": ledger.calls, "unsure": ledger.unsure}))
    await gateway.close() if hasattr(gateway, "close") else None


if __name__ == "__main__":
    asyncio.run(main())
