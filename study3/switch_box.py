"""Temporary free measurement for the overnight audit of 2026-11-17 (never merged).

What happens to the Brain's memory when a new release of the graph arrives while students are
asking? The live Brain reads the new release in a second engine while the first keeps answering
(api/releases.py), so for a while it holds two. This script does exactly that, with the Brain's own
Releases class, inside a box the size of the live one: it serves a release, keeps asking practice
messages (not the frozen blind 60) with a stand-in for the model, then puts a second copy of the
release beside the first under another name and lets the Brain switch to it, twice. It prints the
memory held before, the peak during, and what is held after. It costs nothing and writes only
inside its own graph folder copy.
"""

import asyncio
import datetime
import inspect
import json
import os
import shutil
import statistics
import threading
import time
import types
from pathlib import Path
from typing import Any

import mem_box as m
import rockygpt_brain
from rockygpt_brain.api.releases import Releases
from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import Gateway
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.settings import Prices, ProviderSettings
from rockygpt_brain.turn import intake

AT_ONCE = int(os.environ.get("AT_ONCE", "2"))


def split() -> str:
    """Of the memory held, how much is the process's own (cannot be dropped) and how much is
    files it has open in memory (the system can drop those when the box is short)."""
    found = {}
    for line in open("/proc/self/status"):
        if line.startswith(("RssAnon", "RssFile", "RssShmem")):
            found[line.split(":")[0]] = round(int(line.split()[1]) / 1e3)
    return (f"own {found.get('RssAnon', '?')} MB + open files {found.get('RssFile', '?')} MB"
            f" + shared {found.get('RssShmem', '?')} MB")
SWITCHES = int(os.environ.get("SWITCHES", "2"))
BEFORE = int(os.environ.get("BEFORE", "40"))  # messages answered before each switch


def other_copy(folder: Path, pointer: dict[str, Any], tag: str) -> dict[str, Any]:
    """The same release under another file name, as its own files: what a new nightly release
    of about the same size looks like to the Brain."""
    stem = Path(pointer["file"]).stem
    new = f"release-{tag}"
    for path in sorted(folder.iterdir()):
        if path.name == stem + ".lbug" or path.name.startswith(stem + "."):
            target = folder / path.name.replace(stem, new, 1)
            if not target.exists():
                shutil.copyfile(path, target)
    again = json.loads(json.dumps(pointer))
    again["file"] = pointer["file"].replace(stem, new, 1)
    for entry in again.get("files") or []:
        entry["name"] = entry["name"].replace(stem, new, 1)
    return again


async def main() -> None:
    here = Path(__file__).parent
    source = Path(os.environ.get("GRAPH_DIR", ".published"))
    folder = Path(os.environ.get("WORK_DIR", "/tmp/switch-graph"))
    if folder != source:  # In the box the folder is made ready outside it (PREPARE_ONLY).
        if folder.exists():
            shutil.rmtree(folder)
        shutil.copytree(source, folder)
        for path in folder.iterdir():
            path.chmod(0o644)
    if os.environ.get("PREPARE_ONLY"):
        first = json.loads((folder / "active.json").read_text())
        other_copy(folder, first, "0000000000000001")
        m.say(f"prepared {folder}: {sorted(p.name for p in folder.iterdir())}")
        return
    m.say(f"writer {m.WRITER}; brain code {os.environ.get('BRAIN_REF', '?')}; {AT_ONCE} asking "
          f"at once; box: {m.box()}")
    facts = GraphOnlyFacts(folder)
    index = facts.meaning_index()
    assert index is not None
    m.say(f"release {facts.active_release()[0]}; search units {len(index.units)}")
    rows = json.loads((here / "questions.json").read_text()) + json.loads(
        (here / "read_messages.json").read_text())
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
    gateway = Gateway(settings, ledger=m.FreeLedger(),
                      transport=m.StandIn(prices.model, index.dimensions))
    options = {"output": "written", "howto_one_call": True, "page_writer": m.WRITER}
    accepted = inspect.signature(ChatEngine.__init__).parameters
    state = types.SimpleNamespace(engine=ChatEngine(
        gateway, facts, **{k: v for k, v in options.items() if k in accepted}))
    state.engine.warm()
    dimensions = index.dimensions
    del facts, index  # Only the engine holds its release now, as in the live app.
    m.say(f"after warm {m.held_mb()} MB (peak {m.peak_mb()} MB); {split()}")
    releases = Releases(state, folder)
    first = json.loads((folder / "active.json").read_text())
    pointers = [other_copy(folder, first, "0000000000000001"), first]

    seconds: list[float] = []
    stop = False
    position = 0

    async def asker() -> None:
        nonlocal position
        while not stop:
            row = rows[position % len(rows)]
            position += 1
            request = ChatRequest.model_validate(
                {"messages": [{"role": "user", "content": row["question"]}]})
            begun = time.monotonic()
            try:
                await state.engine.answer(intake(request), request)
            except Exception:  # noqa: BLE001  Only the time is kept.
                pass
            seconds.append(time.monotonic() - begun)

    askers = [asyncio.create_task(asker()) for _ in range(AT_ONCE)]

    async def answered(count: int) -> None:
        if not AT_ONCE:  # Nobody is asking: the early-morning case.
            await asyncio.sleep(3)
            return
        target = len(seconds) + count
        while len(seconds) < target:
            await asyncio.sleep(0.2)

    await answered(BEFORE)
    for number in range(SWITCHES):
        usual = statistics.median(seconds[-BEFORE:] or [0.0])
        m.say(f"BEFORE SWITCH {number + 1}: holds {m.held_mb()} MB ({split()}; peak so far {m.peak_mb()} MB); "
              f"code seconds an answer middle {round(usual, 2)}; box: {m.box()}")
        pointer = pointers[number % 2]
        temp = folder / ".active.tmp"
        temp.write_text(json.dumps(pointer, indent=2) + "\n")
        os.replace(temp, folder / "active.json")
        mark = len(seconds)
        result: dict[str, Any] = {}

        def switch() -> None:
            begun = time.monotonic()
            result["switched"] = releases.check_once()
            result["took"] = round(time.monotonic() - begun, 1)
            result["at_switch_mb"] = m.held_mb()
            releases.give_back()
            result["after_give_back_mb"] = f"{m.held_mb()} MB ({split()})"

        thread = threading.Thread(target=switch)
        thread.start()
        top, top_split = 0, ""
        while thread.is_alive():
            now = m.held_mb()
            if now > top:
                top, top_split = now, split()
            await asyncio.sleep(0.05)
        during = seconds[mark:] or [0.0]
        m.say(f"SWITCH {number + 1}: switched {result.get('switched')}; reading the new release "
              f"took {result.get('took')} s while {len(during)} answers finished (their code "
              f"seconds middle {round(statistics.median(during), 2)}, slowest "
              f"{round(max(during), 2)}); most held during {top} MB ({top_split}); held at the switch "
              f"{result.get('at_switch_mb')} MB; after giving memory back "
              f"{result.get('after_give_back_mb')}; peak so far {m.peak_mb()} MB; box: {m.box()}")
        await answered(BEFORE)
    stop = True
    await asyncio.gather(*askers)
    m.say(f"AFTER: holds {m.held_mb()} MB ({split()}); peak {m.peak_mb()} MB; box: {m.box()}")
    m.say("FINISHED without running out of memory")


if __name__ == "__main__":
    asyncio.run(main())
