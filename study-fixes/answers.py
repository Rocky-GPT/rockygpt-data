"""Ask a list of fresh messages (none from the 11-18 blind set) with production's engine, every
answer whole, so the Brain before and after a fix can be compared. QUESTIONS names the file in
study-fixes/sets/. Capped at CAP_USD (default $0.15).
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402

OUT = Path(os.environ.get("OUT_DIR", "."))


async def main() -> None:
    facts, gateway, engine, ledger = common.build(float(os.environ.get("CAP_USD", "0.15")))
    rows = json.loads((Path(__file__).parent / "sets" / os.environ["QUESTIONS"]).read_text())
    print("release", facts.active_release()[0], "questions", len(rows))
    engine.warm()
    gate = asyncio.Semaphore(int(os.environ.get("AT_ONCE", "3")))
    done: list[dict[str, Any]] = []

    async def one(row: dict[str, Any]) -> None:
        async with gate:
            done.append(await asyncio.create_task(common.ask(engine, row, "x", 1)))

    await asyncio.gather(*(one(r) for r in rows))
    done.sort(key=lambda r: r["id"])
    for r in done:
        read = r.get("read") or {}
        print(f"=== {r['id']} | {r['question']}\n--- by={r['by']} status={r['status']} "
              f"sec={r['sec']} err={r['err']} read: needs={read.get('needs')} "
              f"limit={read.get('limit')} topic={read.get('topic')} asked={read.get('asked')} "
              f"q={read.get('question')!r} general={read.get('general')!r}\n{r['answer']}\n")
    (OUT / "rows.json").write_text(json.dumps(done, ensure_ascii=False))
    await gateway.close()
    print(f"TOTAL spent ${ledger.spent / 1e9:.4f} in {ledger.calls} calls")


if __name__ == "__main__":
    asyncio.run(main())
