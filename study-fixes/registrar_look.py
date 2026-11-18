"""Study only: the Registrar page's staff text on the live graph (no model call)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common  # noqa: E402
from rockygpt_brain.retrieval.entity_facts import linked_rows  # noqa: E402

facts, gateway, engine, ledger = common.build(0.0)
print("release", facts.active_release()[0])
seen = set()
with facts.snapshot() as snapshot:
    for entity in snapshot.entities:
        for row in linked_rows(entity, snapshot.record_reader(entity, "office_sections"), "office_sections") if any(l.get("collection") == "office_sections" for l in entity["links"]) else []:
            url = str(row.get("url") or "")
            if "/registrar/" not in url or url in seen:
                continue
            seen.add(url)
            for s in row.get("sections") or []:
                text = str(s.get("text") or "")
                if any(n in text for n in ("Beth Foster", "Jill Pierson", "Kathy Larsen", "Vanessa Ramos")):
                    print("URL", url, "HEADING", s.get("heading"))
                    print(repr(text[:3000]))
                    print("---")
