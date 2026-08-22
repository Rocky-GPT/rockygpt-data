#!/usr/bin/env python3
"""
Merge Archway authenticated "About" contact/social info into clubs datasets.

Reads:
- data/raw/clubs.raw.json (to map websiteUrl/name <-> clubId)
- data/raw/clubs-about.raw.json (scraped about pages)
- public/data/clubs.json
- data/normalized/clubs.json

Writes (in-place):
- public/data/clubs.json
- data/normalized/clubs.json
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]

CLUBS_RAW = ROOT / "data" / "raw" / "clubs.raw.json"
ABOUT_RAW = ROOT / "data" / "raw" / "clubs-about.raw.json"
PUBLIC = ROOT / "public" / "data" / "clubs.json"
NORMALIZED = ROOT / "data" / "normalized" / "clubs.json"

EMAIL_RE = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def norm(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split()).strip()


def norm_url(u: Optional[str]) -> str:
    u = (u or "").strip()
    while u.endswith("/"):
        u = u[:-1]
    return u.lower()


def build_seed_maps(clubs_raw: List[Dict[str, Any]]) -> Tuple[Dict[str, str], Dict[str, str], Dict[str, Dict[str, Any]]]:
    """
    Returns:
    - by_website_url: normalized websiteUrl -> clubId
    - by_name: normalized name -> clubId
    - seed_by_id: clubId -> seed record
    """
    by_website_url: Dict[str, str] = {}
    by_name: Dict[str, str] = {}
    seed_by_id: Dict[str, Dict[str, Any]] = {}

    for c in clubs_raw:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("clubId") or "").strip()
        if not cid.isdigit():
            # Try fallback patterns embedded in rawCardText.
            txt = (c.get("rawCardText") or "")
            m = re.search(r"\bclub_(\d+)\b|\bcb_club_(\d+)\b|\bemail_restriction_(\d+)\b", txt)
            if m:
                for g in m.groups():
                    if g and g.isdigit():
                        cid = g
                        break
        if not cid.isdigit():
            continue

        seed_by_id[cid] = c

        w = norm_url(c.get("websiteUrl"))
        if w:
            by_website_url[w] = cid
        n = norm(c.get("name") or "")
        if n:
            by_name[n] = cid

    return by_website_url, by_name, seed_by_id


def is_valid_email(e: Optional[str]) -> bool:
    if not e:
        return False
    return bool(EMAIL_RE.match(e.strip()))


def merge_one(club: Dict[str, Any], club_id: str, about: Dict[str, Any]) -> bool:
    changed = False

    def set_if(value_key: str, new_value: Optional[str]) -> None:
        nonlocal changed
        if not new_value:
            return
        old = (club.get(value_key) or "").strip()
        if old != new_value:
            club[value_key] = new_value
            changed = True

    # Email: override if about has a plausible email.
    about_email = (about.get("email") or "").strip().lower()
    if is_valid_email(about_email):
        old = (club.get("email") or "").strip().lower()
        if old != about_email:
            club["email"] = about_email
            changed = True

    # Social links
    set_if("instagramUrl", (about.get("instagramUrl") or "").strip())
    set_if("facebookUrl", (about.get("facebookUrl") or "").strip())
    set_if("twitterUrl", (about.get("twitterUrl") or "").strip())
    set_if("linkedinUrl", (about.get("linkedinUrl") or "").strip())

    # Optional: external websites (keep first as primary)
    ext = about.get("externalWebsiteUrls") or []
    if isinstance(ext, list) and ext:
        first = str(ext[0]).strip()
        if first:
            set_if("externalWebsiteUrl", first)

    # GroupMe links discovered on about page (not always present)
    gm = about.get("groupmeUrls") or []
    if isinstance(gm, list) and gm:
        # Don't clobber existing; append unique.
        existing = club.get("groupmeUrls") or []
        if not isinstance(existing, list):
            existing = []
        merged = []
        seen = set()
        for x in existing + gm:
            if not isinstance(x, str):
                continue
            nx = x.strip()
            if not nx or nx in seen:
                continue
            seen.add(nx)
            merged.append(nx)
        if merged and merged != existing:
            club["groupmeUrls"] = merged
            changed = True

    return changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--about", default=str(ABOUT_RAW))
    ap.add_argument("--clubs-raw", default=str(CLUBS_RAW))
    ap.add_argument("--public", default=str(PUBLIC))
    ap.add_argument("--normalized", default=str(NORMALIZED))
    args = ap.parse_args()

    clubs_raw = read_json(Path(args.clubs_raw))
    if not isinstance(clubs_raw, list):
        raise SystemExit("Expected clubs.raw.json to be a list")

    about_raw = read_json(Path(args.about))
    items = about_raw.get("items") if isinstance(about_raw, dict) else None
    if not isinstance(items, list):
        raise SystemExit("Expected clubs-about.raw.json to be an object with .items[]")

    about_by_id: Dict[str, Dict[str, Any]] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        cid = str(it.get("clubId") or "").strip()
        if cid:
            about_by_id[cid] = it

    by_website_url, by_name, _seed_by_id = build_seed_maps(clubs_raw)

    def merge_file(path: Path) -> Dict[str, int]:
        data = read_json(path)
        if not isinstance(data, list):
            raise SystemExit(f"Expected {path} to be a list")
        changed = 0
        matched = 0
        for club in data:
            if not isinstance(club, dict):
                continue
            cid = ""
            w = norm_url(club.get("websiteUrl"))
            if w and w in by_website_url:
                cid = by_website_url[w]
            if not cid:
                n = norm(club.get("name") or "")
                cid = by_name.get(n, "")
            if not cid:
                continue
            about = about_by_id.get(cid)
            if not about:
                continue
            matched += 1
            if merge_one(club, cid, about):
                changed += 1
        write_json(path, data)
        return {"matched": matched, "changed": changed, "total": len(data)}

    pub_stats = merge_file(Path(args.public))
    norm_stats = merge_file(Path(args.normalized))

    sys.stdout.write(f"Updated {args.public}: {pub_stats}\\n")
    sys.stdout.write(f"Updated {args.normalized}: {norm_stats}\\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
