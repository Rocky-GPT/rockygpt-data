"""Temporary free check (never merged): which way does code answer "list a field's professors"?

For each practice question it follows the Brain's own people branches (engine._one_call, in the
order the engine tries them) on the dev graph, and says which one would answer:

  course    people.course_teachers: profiles that list a course the question names
  catalog   engine._faculty_part: everyone the catalog links to the program (faculty_text)
  writer    the page writer, given people.teachers() (profile words) and the catalog list

and how many people each one gives. No model call and no embedding is made: it costs nothing.
"""

import json
import sys
from pathlib import Path
from typing import Any

from rockygpt_brain import one_call
from rockygpt_brain import people as people_module
from rockygpt_brain.engine import ChatEngine
from rockygpt_brain.retrieval.graph_store import GraphOnlyFacts, read_pointer

QUESTIONS = [
    # Field lists (what step 4 is about); none is from the blind set.
    "who teaches chemistry here? is there a list of the chem faculty",
    "can you list all the professors in the mathematics department",
    "who are the psychology faculty",
    "list the nursing professors",
    "who teaches history at ramapo",
    "i need a list of every professor in computer science",
    "who are all the biology professors",
    "which professors are in the economics department",
    "give me all the business faculty",
    "who teaches communication arts",
    "who are the profs in the literature program",
    "list of physics faculty please",
    "who teaches political science? any list?",
    "all the sociology professors and their emails",
    "who teaches environmental science",
    "who are the music professors",
    "who teaches data science",
    "show me the faculty for accounting",
    "who teaches criminal justice",
    "who is on the social work faculty",
    "who teaches computer science at ramapo? like a list of the cs professors",
    "can you give me a list of all the professors in the biology department",
    # These must keep their answers: one course, a research topic, one program's convener.
    "who teaches intro to psych",
    "who teaches calc 2",
    "which professors teach organic chemistry 2",
    "who teaches CMPS 147",
    "who researches machine learning",
    "which professors study climate change",
    "who is the psychology convener",
    "who teaches computer science 2",
]


class NoModel:
    """Every model call is an error: this check makes none."""

    async def complete(self, **_: Any) -> Any:
        raise RuntimeError("no model call in this check")

    async def ready(self) -> bool:
        return True


def names(entries: list[dict[str, Any]]) -> list[str]:
    return [str(e.get("name") or "") for e in entries]


def main() -> None:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else ".published")
    facts = GraphOnlyFacts(folder, release=read_pointer(folder))
    engine = ChatEngine(NoModel(), facts, output="written")  # type: ignore[arg-type]
    directory = engine._directory()
    print(f"directory {len(directory)} people; release {facts.active_release()[0]}")
    rows = []
    for q in QUESTIONS:
        programs = engine._programs_named(q)
        named_people = engine._people_named(q)
        list_ask = people_module.asks_faculty_list(q)
        lead_ask = people_module.asks_program_lead(q)
        more = one_call.asks_more(people_module.without_field_asks(q))
        course = (engine._course_teachers(q, 0)
                  if people_module.asks_who_teaches(q) and not named_people else None)
        codes = people_module.courses_named(q, engine._course_titles())
        catalog = (engine._faculty_part(programs[0], 0, not list_ask, q)
                   if programs[0] and (list_ask or lead_ask) else (None, [], []))
        catalog_people = [p for p in catalog[2] if "conveners" not in p]
        taught = (people_module.teachers(directory, q)
                  if people_module.asks_people_topic(q) and course is None
                  and not people_module.asks_leadership(q) else [])
        listed = people_module.listed(directory, q) if people_module.asks_people_list(q) else []
        if course is not None and not more:
            route = "course"
        elif programs[0] and not named_people and course is None and (list_ask or lead_ask) \
                and not more and catalog[0]:
            route = "catalog"
        else:
            route = "writer"
        row = {
            "q": q, "route": route,
            "programs": names(programs[0]), "named_people": names(named_people),
            "list_ask": list_ask, "lead_ask": lead_ask, "asks_more": more,
            "people_asked": people_module.asks_people(q),
            "topic_ask": people_module.asks_people_topic(q),
            "codes": codes[:8], "n_codes": len(codes),
            "course_people": len(course[2]["people"]) if course else None,
            "catalog_people": len(catalog_people),
            "teachers": names(taught), "listed": len(listed),
        }
        if course is not None:
            row["course_text"] = course[0][:300]
        if catalog[0]:
            row["catalog_head"] = catalog[0].splitlines()[0][:200]
        if taught and catalog_people:
            row["teachers_in_catalog"] = len(set(names(taught)) & set(names(catalog_people)))
        rows.append(row)
        print("ROW " + json.dumps(row))
    print("SUMMARY " + json.dumps({r["q"][:40]: r["route"] for r in rows}))


if __name__ == "__main__":
    main()
