#!/usr/bin/env python3
"""
Merge GroupMe directory join links into normalized club records.

Inputs:
- data/raw/groupme-directory.raw.json (from scripts/fetch/groupme-directory.py)
- public/data/clubs.json
- data/normalized/clubs.json

Outputs (in-place):
- public/data/clubs.json
- data/normalized/clubs.json
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


ROOT = Path(__file__).resolve().parents[2]
GROUPME_RAW = ROOT / "data" / "raw" / "groupme-directory.raw.json"
PUBLIC_CLUBS = ROOT / "public" / "data" / "clubs.json"
NORMALIZED_CLUBS = ROOT / "data" / "normalized" / "clubs.json"


STOPWORDS = {
    "a",
    "an",
    "and",
    "at",
    "for",
    "from",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
    "ramapo",
    "college",
    "rcnj",
    "club",
    "organization",
    "org",
    "team",
    "society",
    "association",
    "meeting",
    "general",
    "group",
    "official",
}


def norm_name(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split()).strip()


def tokens(value: str) -> List[str]:
    parts = norm_name(value).split(" ")
    return [p for p in parts if len(p) >= 2 and p not in STOPWORDS]


def score_overlap(a: List[str], b: List[str]) -> Tuple[float, int]:
    if not a or not b:
        return 0.0, 0
    sa, sb = set(a), set(b)
    overlap = len(sa & sb)
    denom = max(len(sa), len(sb))
    return (overlap / denom) if denom else 0.0, overlap


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    if not GROUPME_RAW.exists():
        raise SystemExit(f"Missing {GROUPME_RAW}")
    if not PUBLIC_CLUBS.exists():
        raise SystemExit(f"Missing {PUBLIC_CLUBS}")
    if not NORMALIZED_CLUBS.exists():
        raise SystemExit(f"Missing {NORMALIZED_CLUBS}")

    gm = load_json(GROUPME_RAW)
    groups = (
        gm.get("directoryGroups", {}).get("groups", [])
        if gm.get("directoryGroups", {}).get("ok")
        else []
    )
    group_rows = []
    url_to_name = {}
    for g in groups:
        name = (g or {}).get("name") or ""
        url = (g or {}).get("share_url") or ""
        if not name or not url:
            continue
        url_to_name[url] = name
        group_rows.append(
            {
                "name": name,
                "url": url,
                "norm": norm_name(name),
                "tokens": tokens(name),
            }
        )

    if not group_rows:
        raise SystemExit("No groups with share_url found in GroupMe raw.")

    def merge_into(clubs_path: Path) -> int:
        clubs = load_json(clubs_path)
        updated = 0
        for club in clubs:
            club_name = club.get("name") or ""
            if not club_name:
                continue

            club_norm = norm_name(club_name)
            club_tokens = tokens(club_name)

            candidates: List[Tuple[float, str]] = []
            best = 0.0

            for g in group_rows:
                if club_norm and g["norm"] and club_norm == g["norm"]:
                    candidates.append((1.0, g["url"]))
                    best = 1.0
                    continue

                sc, ov = score_overlap(club_tokens, g["tokens"])
                if ov < 2:
                    continue
                if sc < 0.85:
                    continue
                candidates.append((sc, g["url"]))
                if sc > best:
                    best = sc

            if not candidates:
                continue

            candidates.sort(key=lambda x: (-x[0], x[1]))
            picked = []
            for sc, url in candidates:
                if sc == 1.0 or (sc >= 0.92 and sc >= best - 0.02):
                    picked.append(url)
                if len(picked) >= 3:
                    break

            existing = club.get("groupmeUrls") or []
            merged = sorted(set(existing + picked))
            # Attach group names when possible.
            groupme_groups = []
            for url in merged:
                nm = url_to_name.get(url)
                if nm:
                    groupme_groups.append({"name": nm, "url": url})

            changed = merged != existing
            # Keep groupmeGroups deterministic.
            groupme_groups = sorted(groupme_groups, key=lambda x: (x["name"].lower(), x["url"]))
            existing_groups = club.get("groupmeGroups") or []
            if groupme_groups and groupme_groups != existing_groups:
                club["groupmeGroups"] = groupme_groups
                changed = True

            if changed:
                club["groupmeUrls"] = merged
                updated += 1

        dump_json(clubs_path, clubs)
        return updated

    updated_public = merge_into(PUBLIC_CLUBS)
    updated_norm = merge_into(NORMALIZED_CLUBS)

    print(f"Updated clubs with GroupMe links: public={updated_public}, normalized={updated_norm}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
