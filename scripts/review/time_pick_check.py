"""One-off check (tools review 2026-11-18): the read's time picks against a person's picks.

Asks each message the way the Brain does (triage.READ_PROMPT and READ_TOOL, READS reads, the
vote) and compares the voted picks with `want`. Prints each miss and the totals. About $0.01.
Usage (cloud job): python time_pick_check.py time-pick-messages.json
"""

import json
import os
import sys

from openai import OpenAI

from rockygpt_brain import triage

MODEL = json.load(open(os.path.join(os.path.dirname(triage.__file__), "provider-release.json")))["model"]
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], project=os.environ.get("OPENAI_PROJECT") or None)


def read_once(text: str) -> triage.Reading | None:
    response = client.responses.create(
        model=MODEL, input=triage.read_messages(text, None, None), tools=[triage.READ_TOOL],
        max_output_tokens=4000, store=False, service_tier="default", reasoning={"effort": "low"},
        tool_choice="required", parallel_tool_calls=False, timeout=60)
    calls = [o for o in response.output if o.type == "function_call"]
    return triage.reading_of(json.loads(calls[0].arguments), text) if len(calls) == 1 else None


def main(path: str) -> int:
    messages = json.load(open(path))["messages"]
    fields = right = whole = 0
    for m in messages:
        reads = [r for r in (read_once(m["text"]) for _ in range(triage.READS)) if r]
        voted = triage.majority(reads)
        got = voted.time if voted is not None else None
        misses = []
        for name, want in m["want"].items():
            fields += 1
            have = getattr(got, name) if got is not None else "no picks"
            if have == want:
                right += 1
            else:
                misses.append(f"{name}: want {want}, got {have}")
        whole += not misses
        print(f"{m['id']} {'ok  ' if not misses else 'MISS'} {m['text']!r}"
              + (f"  -> {'; '.join(misses)}" if misses else "")
              + f"  [reads: {[r.time.as_trace() if r.time else None for r in reads]}]")
    print(f"\nWhole messages right: {whole} of {len(messages)}. Fields right: {right} of {fields}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
