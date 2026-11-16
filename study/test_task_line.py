"""Temporary paid test (never merged), approved by Dan on 2026-11-16 as "the 5-cent test".

Question: if the Brain's first read also wrote the student's task as one plain "How do I ...?"
line, would code find the right answer card for more messages, without changing what the read
says about small talk, danger, needs and limits?

Nothing in the bot changes. On the downloaded dev graph this script
- runs the Brain's real first read (triage.READ_PROMPT and READ_TOOL, through the Brain's own
  provider.Gateway, three votes a message) as it is today: arm A;
- runs it again with one more field, `task`: arm B;
- matches every task line to the answer cards with the Brain's own match code, and records what
  the chat path does as built (cards on, first read off, no model call);
- keeps its own ledger in memory, which refuses every call once the spend could pass the cap.

Messages: 90 fresh practice messages (60 how-to, 30 other), 30 older how-to questions, and 44
practice messages of every kind (hello, feelings, crisis, can't-know) for the label check.
Arm A is skipped for the 30 older questions: saved runs already hold their reads.

It writes out/part-0.txt (one gzip+base64 line with every number) and out/part-1.txt and
part-2.txt (what code would say from the cards a task line led to clearly).
"""

import asyncio
import base64
import copy
import datetime
import gzip
import inspect
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from rockygpt_brain import card_answer, one_call, triage
from rockygpt_brain.contract import ChatRequest
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.provider import Gateway, GatewayError, TurnBudget
from rockygpt_brain.retrieval import answer_cards
from rockygpt_brain.retrieval.entity_facts import MEANING_PAST_TERM
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts
from rockygpt_brain.settings import Prices, ProviderSettings
from rockygpt_brain.spending import Reservation, SpendingError
from rockygpt_brain.turn import intake

NOW = datetime.datetime(2026, 11, 16, 15, tzinfo=datetime.UTC)
EMBED_USD_PER_TOKEN = 0.13 / 1_000_000  # text-embedding-3-large
# The ledger refuses a call once what is spent plus what is held for calls in flight would pass
# this. A hold is the worst case of one call (about $0.002), so the real spend stops lower.
CAP_NUSD = 120_000_000
# Arm A on the fresh messages is the last part. It is skipped when the calls so far cost so much
# that it would take the real spend past this.
SOFT_NUSD = 85_000_000
VOTE_SECONDS = 20.0  # The Brain allows 8; slower votes are counted, not lost.
MESSAGES_AT_ONCE = 4
SAID_PARTS = 2

TASK_FIELD = """\
- task: when the question asks how to get one thing done at Ramapo (apply, register, pay, appeal,
  request, replace, change, cancel, report, join or get something), that one thing as a short
  plain question that starts with "How do I": "someone took my bike from outside the dorm last
  night what do i do" is "How do I report a stolen bike?". Say only the thing to get done, in
  everyday words, without the student's story, reasons or feelings. Keep who it is for and which
  term when the student says so (a transfer student, a parent, the spring semester), and the
  student's own names for things; never add a name, a place or a fact. Leave it empty when the
  question is empty, when it asks for a fact and not how to do something (a date, hours, a
  place, a person, a price, a list, whether something exists or is allowed), and when the
  message asks how to do two or more different things.
"""
LAST_LINE = "Answer only with the read_message tool."
assert triage.READ_PROMPT.endswith(LAST_LINE)
PROMPT_B = triage.READ_PROMPT[:-len(LAST_LINE)] + TASK_FIELD + LAST_LINE
TOOL_B: dict[str, Any] = copy.deepcopy(triage.READ_TOOL)
TOOL_B["parameters"]["required"].append("task")
TOOL_B["parameters"]["properties"]["task"] = {"type": "string"}


class MemoryLedger:
    """The Brain's ledger interface, kept in memory, with a hard cap."""

    def __init__(self) -> None:
        self.spent, self.calls, self.unsure, self.paused = 0, 0, 0, False
        self.held: dict[str, int] = {}
        self.tokens = [0, 0, 0]

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
        for at, name in enumerate(("input_tokens", "cached_tokens", "output_tokens")):
            self.tokens[at] += int(usage.get(name, 0))

    async def uncertain(self, reservation: Reservation, code: str) -> None:
        # The hold stays: a call that may have been charged counts at its worst case.
        self.unsure += 1

    async def release(self, reservation: Reservation, code: str, now: datetime.datetime) -> None:
        self.held.pop(reservation.operation_id, None)

    async def pause(self) -> None:
        self.paused = True


class FakeTransport:
    """The free dry run (DRY=1): no model call. It answers in the provider's shape so that every
    later step of this script runs once before any money is spent."""

    def __init__(self, model: str) -> None:
        self.model = model

    async def send(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        latest = json.loads(request["input"][1]["content"])["latest_message"]
        said: dict[str, Any] = {"social": "none", "danger": "none", "needs": [], "limit": "none",
                                "question": latest}
        if "task" in request["tools"][0]["parameters"]["properties"]:
            said["task"] = "How do I " + " ".join(latest.split()[:9]).rstrip("?.!") + "?"
        return {"id": "dry", "model": self.model, "status": "completed",
                "usage": {"input_tokens": 1800, "output_tokens": 40,
                          "input_tokens_details": {"cached_tokens": 1500}},
                "output": [{"type": "function_call", "call_id": "dry", "name": "read_message",
                            "arguments": json.dumps(said)}]}

    async def embed(self, request: dict[str, Any], remaining_seconds: float) -> dict[str, Any]:
        raise NotImplementedError

    async def close(self) -> None:
        return None


def embed(texts: list[str], model: str, dimensions: int) -> tuple[list[list[float]], int]:
    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps({"model": model, "input": texts, "dimensions": dimensions}).encode(),
        headers={"content-type": "application/json",
                 "authorization": "Bearer " + os.environ["BRAIN_OPENAI_API_KEY"]})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        # Never the message or a header: only the status.
        raise SystemExit(f"embeddings failed with HTTP {error.code}") from None
    rows = sorted(reply["data"], key=lambda d: d["index"])
    return [row["embedding"] for row in rows], int(reply["usage"]["total_tokens"])


class EmbedOnly:
    """Embeds (each text once), and refuses every model call: the chat path as built."""

    def __init__(self, model: str) -> None:
        self.model, self.tokens, self.refused = model, 0, 0
        self.known: dict[str, list[float]] = {}

    def learn(self, texts: list[str], dimensions: int) -> None:
        new = [t for t in dict.fromkeys(texts) if t not in self.known]
        for start in range(0, len(new), 400):
            vectors, tokens = embed(new[start:start + 400], self.model, dimensions)
            self.tokens += tokens
            self.known.update(zip(new[start:start + 400], vectors, strict=True))

    async def embed_many(self, texts: Any, *, dimensions: int, budget: Any) -> list[list[float]]:
        await asyncio.to_thread(self.learn, list(texts), dimensions)
        return [self.known[t] for t in texts]

    async def complete(self, *, input: Any, tools: Any, budget: Any) -> Any:
        self.refused += 1
        raise GatewayError("study_refuses_model_calls")

    async def ready(self) -> bool:
        return True


GATE_NAMES = ("searchable", "asked_at", "earlier", "kind", "calendar_asked", "people_asked",
              "named_people", "programs", "code_parts", "computed", "academic", "people", "clubs")
GATE: dict[str, Any] = {}


def gate_line() -> int:
    source, start = inspect.getsourcelines(ChatEngine._one_call)
    for offset, line in enumerate(source):
        if "self._cards_now() and searchable" in line:
            return start + offset
    raise SystemExit("the card gate's line was not found")


def watch_gate() -> None:
    """Copies what the card gate's conditions hold when the chat path reaches it."""
    code, line = ChatEngine._one_call.__code__, gate_line()

    def short(name: str, value: Any) -> Any:
        if name == "asked_at":
            return value
        if name in ("earlier", "kind"):
            return value is not None
        if name == "programs":
            return bool(value and any(value))
        return bool(value)

    def local(frame: Any, event: str, arg: Any) -> Any:
        if event == "line" and frame.f_lineno == line:
            GATE.update({name: short(name, frame.f_locals.get(name)) for name in GATE_NAMES})
        return local

    def tracer(frame: Any, event: str, arg: Any) -> Any:
        return local if frame.f_code is code else None

    sys.settrace(tracer)


async def ask(engine: ChatEngine, message: str) -> dict[str, Any]:
    request = ChatRequest.model_validate({"messages": [{"role": "user", "content": message}]})
    GATE.clear()
    try:
        result = await engine.answer(intake(request, now=NOW), request)
        trace = result.trace or {}
    except Exception as error:  # noqa: BLE001  The study reads every message.
        trace = {"decidedBy": type(error).__name__}
    note = trace.get("answerCard") or {}
    return {"by": trace.get("decidedBy"), "said": bool(note.get("said")), "why": note.get("why"),
            "gate": dict(GATE) or None}


async def vote(gateway: Gateway, prompt: str, tool: dict[str, Any],
               latest: str) -> dict[str, Any]:
    """One read of one message, the way engine._read makes it, with one retry when the provider
    was busy. Only labels, the two lines, seconds and token counts are kept."""
    messages = triage.read_messages(latest, None, None)
    messages[0] = {"role": "system", "content": prompt}
    failed = "unknown"
    for attempt in (1, 2):
        budget = TurnBudget("study-" + uuid.uuid4().hex[:12], time.monotonic() + VOTE_SECONDS,
                            max_calls=1, max_cost_nusd=25_000_000 // triage.READS)
        started = time.monotonic()
        try:
            async with asyncio.timeout(VOTE_SECONDS):
                completion = await gateway.complete(input=messages, tools=[tool], budget=budget)
        except Exception as error:  # noqa: BLE001  Only a code-controlled name is kept.
            failed = str(getattr(error, "code", type(error).__name__))
            if attempt == 1 and getattr(error, "retryable", False):
                await asyncio.sleep(3)
                continue
            return {"err": failed}
        seconds = time.monotonic() - started
        calls = completion.tool_calls
        reading = (triage.reading_of(calls[0].arguments, latest)
                   if len(calls) == 1 and calls[0].name == "read_message"
                   and not completion.text.strip() else None)
        if reading is None:
            return {"err": "malformed"}
        task = calls[0].arguments.get("task")
        usage = completion.usage
        return {"s": reading.social, "d": reading.danger, "n": list(reading.needs),
                "l": reading.limit, "q": reading.question,
                "t": " ".join(task.split())[:300] if isinstance(task, str) else None,
                "sec": round(seconds, 2), "in": usage.input_tokens, "c": usage.cached_tokens,
                "out": usage.output_tokens}
    return {"err": failed}


async def read_all(gateway: Gateway, rows: list[dict[str, Any]], arm: str) -> None:
    """Three votes a message, a few messages at a time; each row gets row[arm] = its votes."""
    prompt, tool = ((triage.READ_PROMPT, triage.READ_TOOL) if arm == "A" else (PROMPT_B, TOOL_B))
    todo = [row for row in rows if arm not in row]
    if not todo:
        return
    # The first call alone, so the provider has the prompt cached before the rest go out.
    first = [await vote(gateway, prompt, tool, todo[0]["question"])]
    gate = asyncio.Semaphore(MESSAGES_AT_ONCE)

    async def one(row: dict[str, Any], already: list[dict[str, Any]]) -> None:
        async with gate:
            more = await asyncio.gather(*(vote(gateway, prompt, tool, row["question"])
                                          for _ in range(triage.READS - len(already))))
            row[arm] = [*already, *more]

    await asyncio.gather(*(one(row, first if n == 0 else []) for n, row in enumerate(todo)))


def the_reading(votes: list[dict[str, Any]]) -> triage.Reading | None:
    return triage.majority([triage.Reading(v["s"], v["d"], tuple(v["n"]), v["l"], v["q"])
                            for v in votes if "err" not in v])


async def main() -> None:
    here = Path(__file__).parent
    out = Path("out")
    out.mkdir(exist_ok=True)
    facts = GraphOnlyFacts(Path(".published"))
    index = facts.meaning_index()
    assert index is not None, "no meaning index beside the release"
    fresh = json.loads((here / "practice.json").read_text())
    older = json.loads((here / "older.json").read_text())
    labels = json.loads((here / "labels.json").read_text())
    every = [*fresh, *older, *labels]
    assert len({row["id"] for row in every}) == len(every)

    # The paid part: the Brain's own gateway and request, with the ledger in memory.
    release = json.loads((Path(triage.__file__).parent / "provider-release.json").read_text())
    prices = Prices(release["model"], release["input_nusd_per_token"],
                    release["output_nusd_per_token"], release["cached_input_nusd_per_token"],
                    datetime.datetime.fromisoformat(release["valid_until"]))
    settings = ProviderSettings(environment="development",
                                api_key=os.environ["BRAIN_OPENAI_API_KEY"],
                                project=None,  # type: ignore[arg-type]
                                ledger_url="", prices=prices)
    ledger = MemoryLedger()
    dry = os.environ.get("DRY") == "1"
    paid = (Gateway(settings, ledger=ledger, transport=FakeTransport(prices.model))
            if dry else Gateway(settings, ledger=ledger))
    print("DRY RUN: no model call is made" if dry else "PAID RUN: the model is called",
          flush=True)
    marks: list[tuple[str, int, int]] = []

    async def part(name: str, rows: list[dict[str, Any]], arm: str) -> None:
        await read_all(paid, rows, arm)
        marks.append((name, ledger.calls, ledger.spent))
        print(f"{name}: {ledger.calls} calls settled so far, ${ledger.spent / 1e9:.4f}",
              flush=True)

    try:
        await part("B fresh+older", [*fresh, *older], "B")
        await part("B labels", labels, "B")
        await part("A labels", labels, "A")
        per_call = ledger.spent / max(ledger.calls, 1)
        ahead = per_call * len(fresh) * triage.READS
        if ledger.spent + ahead > SOFT_NUSD:
            print(f"arm A on the fresh messages is skipped: ${ledger.spent / 1e9:.4f} spent and "
                  f"about ${ahead / 1e9:.4f} more would pass ${SOFT_NUSD / 1e9:.3f}")
        else:
            await part("A fresh", fresh, "A")
    finally:
        await paid.close()
        kept = {row["id"]: {arm: row[arm] for arm in ("A", "B") if arm in row} for row in every}
        print("== VOTES_B64_GZIP " + base64.b64encode(gzip.compress(
            json.dumps(kept, separators=(",", ":"), ensure_ascii=False).encode(), 9)).decode(),
            flush=True)

    # The free part: the card match, with the Brain's own code.
    gateway = EmbedOnly(index.model)
    lines = [v["t"] for row in every for v in row.get("B", []) if v.get("t")]
    texts = [row["question"] for row in every] + lines
    texts += [part for row in [*fresh, *older] for part in one_call.parts_of(row["question"])]
    gateway.learn(texts, index.dimensions)
    engine = ChatEngine(gateway, facts, output="written", howto_one_call=True,  # type: ignore[arg-type]
                        read_first=False, card_answers=True, page_writer="ai")
    found = engine._card_tasks(index)
    assert found is not None, "no cards beside the release"
    today = NOW.date()
    table: dict[int, list[Any]] = {}
    said_of: dict[int, str | None] = {}

    def ranked(text: str) -> tuple[list[int], dict[int, float]]:
        best: dict[int, float] = {}
        for key, score in index.scores(gateway.known[text]).items():
            at = found.card_of.get(key)
            if at is None:
                continue
            if at in found.passed:
                score -= MEANING_PAST_TERM
            if score > best.get(at, -2.0):
                best[at] = score
        return sorted(best, key=lambda at: (-best[at], at)), best

    def name(at: int) -> None:
        if at in table:
            return
        card = found.cards[at]
        member = (card.get("members") or [{}])[0]
        label = one_call.unit_labels(index, [(str(member.get("record_id")),
                                               str(member.get("key")))])[0]
        table[at] = [label[:110], str(card.get("status") or ""), None]

    def read(at: int) -> None:
        """Whether code answers from the card, and what it would say."""
        if at in said_of:
            return
        name(at)
        try:
            own = dict(answer_cards.view(facts, found.cards[at], found.nodes, today,
                                         dataset_version=index.dataset_version,
                                         identity_hash=index.identity_hash)["card"])
        except Exception as error:  # noqa: BLE001
            table[at][2], said_of[at] = type(error).__name__, None
            return
        why = card_answer.refusal(own)
        said = engine.card_said(own, today) if why is None else None
        table[at][2] = why or ("" if said is not None else "check")
        table[at].append(str(own["task"].get("task") or "")[:90])
        table[at].append(str(own["task"].get("applies_to") or "")[:60])
        table[at].append(str(own["task"].get("term") or "")[:30])
        said_of[at] = said[0] if said is not None else None

    def match(text: str, whole: list[int]) -> list[Any] | None:
        """[first card, its copies, top x1000, lead x1000, clear, its place in the whole message's
        ranking (the best of the card and its copies), the five best cards]."""
        order, best = ranked(text)
        found_best = card_answer.best_card(index.scores(gateway.known[text]), found.card_of,
                                           found.passed, found.near)
        if found_best is None or not order:
            return None
        first, top, lead, _over = found_best
        copies = sorted(found.near.get(first, ()))
        for at in order[:5]:
            name(at)
        if top >= 0.66:
            read(first)
        places = [whole.index(at) for at in (first, *copies) if at in whole]
        return [first, copies, round(top * 1000), round(lead * 1000),
                bool(card_answer.clear(top, lead)), min(places, default=999),
                [[at, round(best[at] * 1000)] for at in order[:5]]]

    def answer_of(row: dict[str, Any]) -> int | None:
        """The rule under test: at least two of the read's task lines lead clearly to the same
        card (or a copy of it), the card is among the three best for the student's own words,
        and code can answer from it."""
        leads = [m for m in (row["lines"].get(v.get("t") or "") for v in row.get("B", []))
                 if m is not None and m[4]]
        for m in leads:
            same = [o for o in leads if o[0] == m[0] or o[0] in m[1]]
            if len(same) >= 2 and m[5] <= 2 and said_of.get(m[0]):
                return int(m[0])
        return None

    result: dict[str, Any] = {"rows": []}
    for row in every:
        whole, _ = ranked(row["question"])
        row["whole"] = match(row["question"], whole)
        row["lines"] = {text: match(text, whole)
                        for text in dict.fromkeys(v["t"] for v in row.get("B", []) if v.get("t"))}
    watch_gate()
    for row in [*fresh, *older]:
        row["path"] = await ask(engine, row["question"])
        pieces, parts = one_call.pieces_of(row["question"]), one_call.parts_of(row["question"])
        row["asked_at"] = card_answer.asking_part(pieces, parts)
    sys.settrace(None)
    for row in every:
        row["answer"] = answer_of(row)
        result["rows"].append({k: v for k, v in row.items() if k != "question"})
    result["cards"] = {str(at): row for at, row in sorted(table.items())}
    result["spend"] = {"calls": ledger.calls, "nusd": ledger.spent, "tokens": ledger.tokens,
                       "held": sum(ledger.held.values()), "unsure": ledger.unsure,
                       "paused": ledger.paused, "marks": marks,
                       "embed_tokens": gateway.tokens}
    result["release"] = index.dataset_version

    # What the log shows at once.
    print(f"release {index.dataset_version}: {len(found.cards)} cards; {len(texts)} texts, "
          f"{gateway.tokens} embedding tokens, ${gateway.tokens * EMBED_USD_PER_TOKEN:.6f}; "
          f"{gateway.refused} model calls refused on the chat path")
    print(f"model calls settled: {ledger.calls}; tokens in {ledger.tokens[0]} (cached "
          f"{ledger.tokens[1]}), out {ledger.tokens[2]}; spend by the Brain's rates "
          f"${ledger.spent / 1e9:.4f}; held ${sum(ledger.held.values()) / 1e9:.4f}; "
          f"unsure {ledger.unsure}; paused {ledger.paused}")
    for arm in ("A", "B"):
        votes = [v for row in every for v in row.get(arm, [])]
        good = [v for v in votes if "err" not in v]
        errors: dict[str, int] = {}
        for v in votes:
            if "err" in v:
                errors[v["err"]] = errors.get(v["err"], 0) + 1
        if good:
            print(f"arm {arm}: {len(good)} of {len(votes)} votes read; middle "
                  f"{statistics.median(v['sec'] for v in good):.2f} s, slowest "
                  f"{max(v['sec'] for v in good):.2f} s, over 8 s: "
                  f"{sum(v['sec'] > 8 for v in good)}; middle output tokens "
                  f"{statistics.median(v['out'] for v in good)}; failures {errors}")
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in every:
        groups.setdefault(row["group"], []).append(row)
    for group, rows in groups.items():
        with_line = sum(1 for row in rows
                        if sum(1 for v in row.get("B", []) if v.get("t")) >= 2)
        answered = [row["id"] for row in rows if row["answer"] is not None]
        built = [row["id"] for row in rows if (row.get("path") or {}).get("said")]
        print(f"{group}: {len(rows)} messages; a task line from 2+ reads: {with_line}; "
              f"card answer by the rule: {len(answered)} {answered}; as built: {len(built)} "
              f"{built}")
    differ = 0
    for row in every:
        if "A" in row and "B" in row:
            a, b = the_reading(row["A"]), the_reading(row["B"])
            if a is None or b is None:
                continue
            if (a.social, a.danger, a.needs, a.limit, bool(a.question)) != (
                    b.social, b.danger, b.needs, b.limit, bool(b.question)):
                differ += 1
                print(f"labels differ {row['id']}: A {a.social}/{a.danger}/{list(a.needs)}/"
                      f"{a.limit}/{bool(a.question)} B {b.social}/{b.danger}/{list(b.needs)}/"
                      f"{b.limit}/{bool(b.question)}")
    print(f"messages whose majority labels differ between the arms: {differ}")

    blob = base64.b64encode(gzip.compress(json.dumps(result, separators=(",", ":"),
                                                     ensure_ascii=False).encode(), 9)).decode()
    (out / "part-0.txt").write_text(f"== BLOB of {len(blob)} characters\n== BLOB_PART 0 {blob}\n")
    # What code would say, only from the cards a task line (or the whole message) led to clearly.
    led = {m[0] for row in every for m in [row["whole"], *row["lines"].values()]
           if m is not None and m[4]}
    answers = [(at, text) for at, text in sorted(said_of.items()) if text and at in led]
    for n in range(SAID_PARTS):
        mine = [pair for k, pair in enumerate(answers) if k % SAID_PARTS == n]
        text = []
        for at, said in mine:
            text.append(f"@@ {at} | {table[at][0]}")
            text += ["   " + line.strip()[:400] for line in said.splitlines() if line.strip()]
        text.append(f"== SAID_PART {n}: {len(mine)} of {len(answers)} answers")
        (out / f"part-{1 + n}.txt").write_text("\n".join(text) + "\n")
    print(f"{len(table)} cards named, {len(answers)} answers by code to read; blob of "
          f"{len(blob)} characters")


if __name__ == "__main__":
    asyncio.run(main())
