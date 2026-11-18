"""The four checks before building the blind-miss fixes (temporary, never merged).

1. How many stored page sections are schedules or lists kept as one run-on line, and how many of
   those carry a label inside the text that belongs to the rows after it (the Precalculus shape).
3. What the first read returns for 20 fresh two-part texting questions, and how often its clean
   question is thrown away (triage.asked), with what code's word matching makes of each version.
4. Whether dated service notices ("no shuttle Nov 25 to 29") are anywhere in the graph.
(Check 2 needs the data side and runs in the dev build.)
Only check 3 calls a model: 20 questions, three reads each, capped at $0.05.
"""

import asyncio
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402
from rockygpt_brain import events, triage  # noqa: E402
from rockygpt_brain.context import build_context  # noqa: E402
from rockygpt_brain.contract import ChatRequest  # noqa: E402
from rockygpt_brain.retrieval.entity_facts import linked_rows  # noqa: E402
from rockygpt_brain.turn import intake  # noqa: E402

OUT = Path(os.environ.get("OUT_DIR", "."))
DAY = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
TIME = r"\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m"
SLOT = re.compile(rf"\b{DAY}s?\b[^.;|]{{0,25}}?{TIME}", re.I)
# A label inside the text that rules the rows after it: "1-on-3 — Appointment Required through
# Connect Monday 4:00", "Walk-in hours: Monday ...", "By appointment only Tuesday ...".
LABEL_BEFORE_SLOT = re.compile(
    rf"(?:appointment|appt|walk[- ]?in|drop[- ]?in|required|only|virtual|online|in[- ]person|"
    rf"zoom|closed|cancel\w*|session|hours)\b[^.]{{0,40}}?\b{DAY}s?\b[^.;|]{{0,25}}?{TIME}", re.I)
NOTICE = re.compile(
    r"\b(?:no (?:shuttle|bus|service)|will not (?:run|operate|be running|be operating)|"
    r"not (?:running|operating|in service)|suspend\w*|no (?:weekend )?service|"
    r"shuttle (?:service )?(?:will be )?(?:closed|cancel\w*))\b", re.I)


def sections_check(facts: Any) -> dict[str, Any]:
    total = schedules = labelled = pages = 0
    by_folder: Counter[str] = Counter()
    examples: list[dict[str, Any]] = []
    notices: list[dict[str, Any]] = []
    seen_pages: set[str] = set()
    with facts.snapshot() as snapshot:
        for entity in snapshot.entities:
            if not any(link.get("collection") == "office_sections" for link in entity["links"]):
                continue
            rows = linked_rows(entity, snapshot.record_reader(entity, "office_sections"),
                               "office_sections")
            for row in rows:
                if str(row.get("id")) in seen_pages:
                    continue
                seen_pages.add(str(row.get("id")))
                pages += 1
                url = str(row.get("url") or "")
                for section in row.get("sections") or []:
                    if not isinstance(section, dict):
                        continue
                    text = str(section.get("text") or "")
                    total += 1
                    slots = SLOT.findall(text)
                    if NOTICE.search(text):
                        found = NOTICE.search(text)
                        notices.append({"url": url, "heading": section.get("heading"),
                                        "around": text[max(0, found.start() - 150):
                                                       found.end() + 150]})
                    if len(slots) < 3:
                        continue
                    schedules += 1
                    labels = LABEL_BEFORE_SLOT.findall(text)
                    # A label that rules rows is one that is not at the very start of the text.
                    inner = [m for m in LABEL_BEFORE_SLOT.finditer(text) if m.start() > 0]
                    if inner:
                        labelled += 1
                        by_folder[url.split("/")[3] if url.count("/") > 3 else url] += 1
                        if len(examples) < 40:
                            examples.append({"url": url, "heading": section.get("heading"),
                                             "slots": len(slots), "labels": len(labels),
                                             "start": text[:300]})
    return {"pages": pages, "sections": total, "schedule_sections": schedules,
            "schedule_sections_with_inner_label": labelled,
            "by_folder": by_folder.most_common(40), "examples": examples,
            "notices_in_sections": notices}


def records_check(facts: Any) -> list[dict[str, Any]]:
    """Notices in the shuttle and other linked records (not office pages)."""
    found = []
    with facts.snapshot() as snapshot:
        for entity in snapshot.entities:
            for collection in ("shuttle_trips", "shuttle_stops", "campus_topics", "terms",
                               "calendar_dates"):
                if not any(link.get("collection") == collection for link in entity["links"]):
                    continue
                for row in snapshot.record_reader(entity, collection):
                    text = json.dumps(row, ensure_ascii=False, default=str)
                    if NOTICE.search(text) or re.search(r"thanksgiving|holiday", text, re.I):
                        hit = NOTICE.search(text) or re.search(r"thanksgiving|holiday", text,
                                                               re.I)
                        found.append({"entity": entity.get("name"), "collection": collection,
                                      "around": text[max(0, hit.start() - 200): hit.end() + 200]})
    return found[:60]


QUESTIONS = [
    "wen does the library close tn n is there printing",
    "hw do i get a parking permit n how much is it",
    "is the pool open sat n do i need my id",
    "wheres the career center n can they look at my resume",
    "whats the add drop deadline 4 spring n can i do it online",
    "is there a chess club n when do they meet",
    "how do i get my transcript sent n does it cost $$",
    "is counseling free here n how do i book",
    "wat time does the atrium open 2morrow n do they have vegan stuff",
    "can freshmen have cars n where do we park",
    "hows the shuttle to the mall work n is it free",
    "who do i talk 2 abt a hold on my acct n where r they",
    "any basketball games this wk n r they free for students",
    "how do i get an on campus job n wheres the list",
    "wheres the it help desk n can they fix my laptop",
    "is there a food pantry on campus n do i need 2 sign up",
    "lost my id card how do i get a new one n how much",
    "when is spring break n do the dorms close",
    "can i take a class pass fail n whats the deadline",
    "wheres the testing center n do i need an appt 4 a makeup exam",
]


def spelled_out(text: str) -> str:
    """The student's words with the shorthand list spelled out (the fix step 3 would make)."""
    def one(match: re.Match[str]) -> str:
        word = match.group(0)
        ways = triage.SPELLED_OUT.get(word.casefold().replace("'", ""))
        return " ".join(ways[0]) if ways else word
    return re.sub(r"[A-Za-z0-9']+", one, text)


def matching(text: str) -> dict[str, Any]:
    words = events.topic_words(text)
    kinds, rest = events.asked_kinds(text, words)
    return {"asks_events": events.asks_events(text), "topic": sorted(words),
            "kinds": sorted(kinds), "pieces": triage_pieces(text)}


def triage_pieces(text: str) -> list[str]:
    from rockygpt_brain import one_call
    return one_call.parts_of(text)


async def reads_check(engine: Any) -> list[dict[str, Any]]:
    rows = []
    for q in QUESTIONS:
        request = ChatRequest.model_validate({"messages": [{"role": "user", "content": q}]})
        turn, context = intake(request), build_context(request)
        trace: dict[str, Any] = {}
        reading = await engine._read(turn, context, trace)
        if reading is not None:
            reading = await engine._read_checked(context, reading, trace)
        question = (await engine._asked(context, reading, False)) if reading else None
        clean = reading.question if reading else ""
        rows.append({
            "q": q, "read": trace.get("read"),
            "kept_read_question": bool(question) and question == clean,
            "asked": question,
            "keeps_words": triage.keeps_words(q, clean) if clean else None,
            "raw": matching(q), "clean": matching(clean) if clean else None,
            "spelled": matching(spelled_out(q)), "spelled_text": spelled_out(q)})
    return rows


async def main() -> None:
    facts, gateway, engine, ledger = common.build(cap_usd=0.05)
    print("release", facts.active_release()[0])
    sections = sections_check(facts)
    print("CHECK 1:", json.dumps({k: v for k, v in sections.items()
                                  if k not in ("examples", "notices_in_sections")}))
    for e in sections["examples"][:25]:
        print("  EX", e["url"], "|", e["heading"], "|", e["slots"], "|", e["start"][:220])
    print("CHECK 4: notices in office sections:", len(sections["notices_in_sections"]))
    for n in sections["notices_in_sections"][:40]:
        print("  N", n["url"], "|", n["heading"], "|", n["around"].replace("\n", " "))
    records = records_check(facts)
    print("CHECK 4: notices/holiday words in shuttle and calendar records:", len(records))
    for r in records[:40]:
        print("  R", r["entity"], r["collection"], "|", r["around"])
    reads = await reads_check(engine) if os.environ.get("READS", "1") == "1" else []
    thrown = [r for r in reads if r["read"] and r["read"].get("question")
              and not r["kept_read_question"]]
    print(f"CHECK 3: {len(reads)} questions; read's clean question thrown away {len(thrown)}")
    for r in reads:
        read = r["read"] or {}
        print(f"  Q {r['q']!r}\n    clean={read.get('question')!r} topic={read.get('topic')} "
              f"needs={read.get('needs')} limit={read.get('limit')} kept={r['kept_read_question']}"
              f" keeps_words={r['keeps_words']}\n    raw kinds={r['raw']['kinds']} "
              f"topic={r['raw']['topic']} | clean kinds={(r['clean'] or {}).get('kinds')} | "
              f"spelled kinds={r['spelled']['kinds']} topic={r['spelled']['topic']}\n"
              f"    raw parts={r['raw']['pieces']}\n    clean parts="
              f"{(r['clean'] or {}).get('pieces')}")
    (OUT / "checks.json").write_text(json.dumps(
        {"sections": sections, "records": records, "reads": reads}, ensure_ascii=False,
        default=str))
    await gateway.close()
    print(f"TOTAL spent ${ledger.spent / 1e9:.4f} in {ledger.calls} calls")


if __name__ == "__main__":
    asyncio.run(main())
