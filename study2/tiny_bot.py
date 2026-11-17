"""Temporary paid measurement for the overnight audit of 2026-11-17 (never merged).

A from-scratch page answerer, to see how much of the Brain's page-answer code its answers need.
The whole bot is `tiny_answer` below: embed the question, take the nearest plain page sections
from the same search index, put them under a nine-line prompt, and make one model call at "low"
thinking effort. No read step, no parts, no second look, no code-written parts, no sentence check.
It reads each section's text with the Brain's own reader, so the page words are the same ones.

Arms (ARMS picks them):
  tiny       the question's one vector; the 20 nearest plain sections exactly as they rank
  tiny-8     the same with the 8 nearest
  tiny-read  the Brain's own section search (the question's parts, 2 a page, current pages only,
             each page's short opening) under the same nine-line prompt

It asks the same 30 older how-to practice questions (the frozen blind 60 is not used) TRIES times
an arm and prints every answer whole. Nothing is written anywhere. Spend is counted here from each
call's own usage and no call is made once it could pass CAP_USD. DRY=1 makes no model call.
"""

import asyncio
import datetime
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from rockygpt_brain import one_call
from rockygpt_brain.retrieval import section_search
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.retrieval.meaning import MeaningScores

CAP_NUSD = int(float(os.environ.get("CAP_USD", "0.40")) * 1_000_000_000)
WORST_CALL_NUSD = 14_000 * 125 + 1_600 * 500  # A call's most: 14,000 tokens read, 1,600 written.
AT_ONCE = int(os.environ.get("AT_ONCE", "3") or 3)
DRY = os.environ.get("DRY") == "1"
ARMS = [a for a in os.environ.get("ARMS", "tiny,tiny-8,tiny-read").split(",") if a]
TRIES = int(os.environ.get("TRIES", "3") or 3)
LIMIT = int(os.environ.get("LIMIT", "0") or 0)
EMBED_MODEL, EMBED_NUSD = "text-embedding-3-large", 130

TINY_PROMPT = """You are RockyGPT, a campus assistant for Ramapo College students. Answer the \
student's question using only the numbered sections of the college's own pages given below.
- Give what the sections say for what was asked, exactly as written: every step, link, form, \
date, deadline, amount, room, phone number and email.
- Put the number of the section a statement comes from after it, like [3].
- When two sections disagree, give the value from the page changed most recently.
- For a part of the question no section answers, say once that you don't have verified \
information about it, and name the office most likely to help.
- Never add anything the sections do not say. Today is {today}.
- Short plain sentences; numbered steps are fine. Under 1,600 characters. No greeting."""


class Spend:
    def __init__(self) -> None:
        self.nusd, self.calls = 0, 0

    def room(self) -> bool:
        return self.nusd + AT_ONCE * WORST_CALL_NUSD <= CAP_NUSD


async def tiny_answer(client: Any, facts: Any, index: Any, prices: dict[str, int], spend: Spend,
                      question: str, arm: str, today: datetime.date) -> dict[str, Any]:
    """The whole from-scratch bot: one search, one short prompt, one model call."""
    timing: dict[str, float] = {}
    started = time.monotonic()
    texts = one_call.parts_of(question) if arm == "tiny-read" else [question]
    if DRY:
        vectors = [[((sum(map(ord, t)) * (k + 3)) % 97 - 48) / 97 for k in range(index.dimensions)]
                   for t in texts]
    else:
        embedded = await client.embeddings.create(model=EMBED_MODEL, input=texts,
                                                  dimensions=index.dimensions, timeout=20)
        vectors = [item.embedding for item in embedded.data]
        spend.nusd += int(embedded.usage.prompt_tokens) * EMBED_NUSD
    timing["embed"] = time.monotonic() - started

    def read() -> list[dict[str, Any]]:
        if arm == "tiny-read":
            chosen = section_search.sections(index, vectors, today)
        else:
            raw = index.scores(vectors[0])
            keys = [k for k in raw if not k[1].startswith("e")][:8 if arm == "tiny-8" else 20]
            scores = MeaningScores({k: raw[k] for k in keys})
            scores.at = {}
            chosen = (scores, keys)
        offices, _ = one_call.gather(facts, index, vectors, question, index.dataset_version,
                                     index.identity_hash, (), chosen=chosen)
        return sorted(({**s, "office": o["office"]} for o in offices for s in o["sections"]),
                      key=lambda s: int(s["n"]))

    begun = time.monotonic()
    sections = await asyncio.to_thread(read)
    timing["read"] = time.monotonic() - begun
    listed = "\n\n".join(
        f"[{s['n']}] {s['office']} | {s['heading']} | {s['page']}"
        + (f" | page changed {s['page_updated']}" if s.get("page_updated") else "")
        + (f" | for a term that is over: {s['past_term']}" if s.get("past_term") else "")
        + f"\n{s['text']}" for s in sections)
    request = {"model": prices["model"], "reasoning": {"effort": "low"}, "max_output_tokens": 1600,
               "input": [{"role": "system", "content": TINY_PROMPT.format(
                   today=f"{today:%A, %B} {today.day}, {today.year}")},
                         {"role": "user", "content": f"Question: {question}\n\nSections:\n{listed}"}]}
    begun = time.monotonic()
    first: float | None = None
    usage: dict[str, Any] = {}
    if DRY:
        text = "This is a dry run reply [1]."
        usage = {"input_tokens": len(json.dumps(request)) // 4, "output_tokens": 10}
    else:
        final: Any = None
        stream = await client.responses.create(**request, stream=True, timeout=60)
        async for event in stream:
            kind = getattr(event, "type", "")
            if first is None and kind == "response.output_text.delta":
                first = time.monotonic() - begun
            if kind in ("response.completed", "response.incomplete", "response.failed"):
                final = event.response
        if final is None:
            raise RuntimeError("stream ended without a response")
        data = final.model_dump(exclude_none=True)
        usage = data.get("usage") or {}
        text = "".join(part.get("text") or "" for item in data.get("output") or []
                       if item.get("type") == "message" for part in item.get("content") or []
                       if part.get("type") == "output_text").strip()
    timing["model"] = time.monotonic() - begun
    cached = int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
    read_tokens, written = int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0)
    spend.nusd += ((read_tokens - cached) * prices["input_nusd_per_token"]
                   + cached * prices["cached_input_nusd_per_token"]
                   + written * prices["output_nusd_per_token"])
    spend.calls += 1
    by_n = {int(s["n"]): s for s in sections}
    used = sorted({int(n) for mark in re.findall(r"\[([\d,\s–-]+)\]", text)
                   for n in re.findall(r"\d+", mark) if int(n) in by_n})
    citations = [{"id": f"section-{n}", "title": str(by_n[n].get("heading") or ""),
                  "url": by_n[n]["page"]} for n in used if by_n[n].get("page")]
    if citations:
        text += "\n\nSources: " + " ".join(f"[{c['id'][8:]}]({c['url']})" for c in citations)
    return {"answer": text, "citations": citations, "sections": len(sections),
            "first": round(first, 2) if first is not None else None,
            "sec": round(time.monotonic() - started, 2),
            "timing": {k: round(v, 2) for k, v in timing.items()},
            "in": read_tokens, "cached": cached, "out": written,
            "think": int((usage.get("output_tokens_details") or {}).get("reasoning_tokens") or 0)}


def _host(url: str) -> str:
    return url.split("://", 1)[-1].rstrip("/").casefold()


def cites(row: dict[str, Any], citations: list[dict[str, Any]]) -> bool | None:
    """Whether the reply cites a page the graders said the answer needs (the row's facts)."""
    wanted = [_host(u) for fact in row.get("facts") or [] for u in fact.get("urls") or []]
    if not wanted:
        return None
    given = [_host(str(c.get("url") or "")) for c in citations]
    return any(w in g or g in w for w in wanted for g in given if g)


def middle(values: list[float]) -> float | None:
    return round(statistics.median(values), 2) if values else None


async def main() -> None:
    here = Path(__file__).parent
    facts = GraphOnlyFacts(Path(os.environ.get("GRAPH_DIR", ".published")))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    rows = json.loads((here / "questions.json").read_text())
    if LIMIT:
        rows = rows[:LIMIT]
    prices = json.loads((Path(one_call.__file__).parent / "provider-release.json").read_text())
    client: Any = None
    if not DRY:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=os.environ["BRAIN_OPENAI_API_KEY"], max_retries=0,
                             base_url="https://api.openai.com/v1")
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-5))).date()
    spend = Spend()
    print(f"release {facts.active_release()[0]}; units {len(index.units)}; questions {len(rows)}; "
          f"arms {ARMS}; tries {TRIES}; dry {DRY}; today {today}")
    done: list[dict[str, Any]] = []
    gate = asyncio.Semaphore(AT_ONCE)

    async def one(row: dict[str, Any], arm: str, run: int) -> None:
        async with gate:
            if not spend.room():
                done.append({"id": row["id"], "arm": arm, "run": run, "err": "cap"})
                return
            try:
                got = await tiny_answer(client, facts, index, prices, spend, row["question"], arm,
                                        today)
                error = None
            except Exception as failure:  # noqa: BLE001  Only the kind of failure is kept.
                got, error = {"answer": "", "citations": []}, type(failure).__name__
            done.append({
                "id": row["id"], "arm": arm, "group": row.get("group"), "run": run,
                "question": row["question"],
                "body": {"answer": got["answer"], "citations": got["citations"]},
                "cites": cites(row, got["citations"]), "err": error,
                "no_info": "don't have verified" in got["answer"], "chars": len(got["answer"]),
                **{k: got.get(k) for k in ("sections", "first", "sec", "timing", "in", "cached",
                                           "out", "think")}})

    for arm in ARMS:
        for run in range(1, TRIES + 1):
            begun = time.monotonic()
            await asyncio.gather(*(one(row, arm, run) for row in rows))
            print(f"arm {arm} try {run} done in {round(time.monotonic() - begun)} s; spent so far "
                  f"${spend.nusd / 1e9:.4f} in {spend.calls} model calls")
    if client is not None:
        await client.close()
    print("=== ROWS (every answer whole)")
    for r in (done if os.environ.get("ROWS", "1") != "0" else []):
        print("SAVE " + json.dumps(r, ensure_ascii=False, separators=(",", ":")))
    print("=== SUMMARY")
    for arm in ARMS:
        mine = [r for r in done if r["arm"] == arm and not r.get("err")]
        graded = [r for r in mine if r["cites"] is not None]
        print(f"ARM {arm}: answered {len(mine)}, errors "
              f"{sum(1 for r in done if r['arm'] == arm and r.get('err'))}; whole answer seconds "
              f"middle {middle([r['sec'] for r in mine])}, 90th "
              f"{sorted(r['sec'] for r in mine)[int(len(mine) * 0.9) - 1] if mine else None}; "
              f"first answer word middle {middle([r['first'] for r in mine if r['first']])}; "
              f"embed {middle([r['timing']['embed'] for r in mine])}, read "
              f"{middle([r['timing']['read'] for r in mine])}, model "
              f"{middle([r['timing']['model'] for r in mine])}; sections read middle "
              f"{middle([r['sections'] for r in mine])}; tokens read "
              f"{middle([r['in'] for r in mine])} cached {middle([r['cached'] for r in mine])} "
              f"written {middle([r['out'] for r in mine])} thinking "
              f"{middle([r['think'] for r in mine])}; reply chars "
              f"{middle([r['chars'] for r in mine])}; cites a graders' page "
              f"{sum(1 for r in graded if r['cites'])} of {len(graded)}; says no verified info "
              f"{sum(1 for r in mine if r['no_info'])}")
    print(f"TOTAL spent ${spend.nusd / 1e9:.4f} in {spend.calls} model calls")
    sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
