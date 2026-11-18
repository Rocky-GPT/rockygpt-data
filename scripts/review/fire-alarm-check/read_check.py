"""One-off check (fire alarm thread, 2026-11-18): the phrase floor and Luna's read, as the Brain
makes them (triage.READ_PROMPT and READ_TOOL, READS reads, majority, provider.py's settings), on
the same messages, ROUNDS times each. Run once with the old Brain and once with the new one.
Writes reads-<label>.json. Never prints the key.

Usage: python read_check.py messages.json LABEL ROUNDS
"""

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

from openai import OpenAI

from rockygpt_brain import boundary, triage

MODEL = json.load(open(os.path.join(os.path.dirname(triage.__file__), "provider-release.json")))["model"]
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], project=os.environ.get("OPENAI_PROJECT") or None)


def read_once(text: str) -> tuple[str | None, dict]:
    response = client.responses.create(
        model=MODEL, input=triage.read_messages(text, None, None), tools=[triage.READ_TOOL],
        max_output_tokens=4000, store=False, reasoning={"effort": "low"},
        tool_choice="required", parallel_tool_calls=False, timeout=60)
    u = response.usage
    used = {"input": u.input_tokens, "output": u.output_tokens,
            "cached": getattr(u.input_tokens_details, "cached_tokens", 0) or 0}
    calls = [o for o in response.output if o.type == "function_call"]
    reading = triage.reading_of(json.loads(calls[0].arguments), text) if len(calls) == 1 else None
    return (reading.danger if reading else None), used


def one(job: tuple[dict, int]) -> dict:
    m, rnd = job
    reads = [read_once(m["text"]) for _ in range(triage.READS)]
    dangers = [d for d, _ in reads]
    voted = triage.majority([triage.Reading(danger=d) for d in dangers if d is not None])
    return {"id": m["id"], "round": rnd, "floor": boundary.names_a_danger(m["text"]),
            "reads": dangers, "read": voted.danger if voted else "failed",
            "used": [u for _, u in reads]}


def main(path: str, label: str, rounds: int) -> int:
    messages = json.load(open(path))["messages"]
    jobs = [(m, r) for r in range(1, rounds + 1) for m in messages]
    with ThreadPoolExecutor(6) as pool:
        rows = list(pool.map(one, jobs))
    spent = {k: sum(u[k] for r in rows for u in r["used"]) for k in ("input", "cached", "output")}
    cost = ((spent["input"] - spent["cached"]) * 125 + spent["cached"] * 10 + spent["output"] * 500) / 1e9
    print(f"{label}: {len(rows)} rows, Luna about ${cost:.4f}")
    json.dump({"label": label, "rows": rows, "cost": cost}, open(f"reads-{label}.json", "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2], int(sys.argv[3])))
