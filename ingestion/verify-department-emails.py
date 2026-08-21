#!/usr/bin/env python3
"""Keep department emails only if they are supported by that department's Archway raw pages.

This avoids false positives from other raw datasets.

Reads:
- public/data/clubs.json
- data/normalized/clubs.json
- data/raw/clubs-detail.raw.json

Writes (in-place):
- public/data/clubs.json
- data/normalized/clubs.json

Rule:
- For bucket == 'departments': keep email only if it appears in the text of any page under the same Archway org slug.
- Always allow csi@ramapo.edu only for 'Center for Student Involvement'.
"""

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'public' / 'data' / 'clubs.json'
NORMALIZED = ROOT / 'data' / 'normalized' / 'clubs.json'
DETAIL = ROOT / 'data' / 'raw' / 'clubs-detail.raw.json'

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)


def norm_email(e: str) -> str:
  return (e or '').strip().lower()


def slug_from_archway_url(url: Optional[str]) -> str:
  if not url or 'archway.ramapo.edu/' not in url:
    return ''
  return url.split('archway.ramapo.edu/', 1)[1].split('/', 1)[0].lower()


def extract_emails_from_page(page: Dict[str, Any]) -> Set[str]:
  parts: List[str] = []
  parts.append(page.get('url') or '')
  for c in page.get('contacts') or []:
    parts.append(c.get('email') or '')
  for s in page.get('sections') or []:
    parts.append(s.get('heading') or '')
    parts.append(s.get('text') or '')
  for lst in page.get('lists') or []:
    for it in lst or []:
      parts.append(it or '')
  for t in page.get('tables') or []:
    for h in t.get('headers') or []:
      parts.append(h or '')
    for row in t.get('rows') or []:
      for cell in row or []:
        parts.append(cell or '')
  for d in page.get('documents') or []:
    parts.append(d.get('label') or '')
    parts.append(d.get('url') or '')
  text='\n'.join(p for p in parts if p)
  return set(norm_email(e) for e in EMAIL_RE.findall(text))


def build_slug_email_index(detail: dict) -> Dict[str, Set[str]]:
  by_slug: Dict[str, Set[str]] = defaultdict(set)
  for p in detail.get('pages') or []:
    if p.get('sourceType') != 'detail':
      continue
    url = p.get('url') or ''
    if 'archway.ramapo.edu/' not in url:
      continue
    slug = slug_from_archway_url(url)
    if not slug:
      continue
    by_slug[slug] |= extract_emails_from_page(p)
  return by_slug


def apply(path: Path, slug_emails: Dict[str, Set[str]]) -> Tuple[int, int]:
  clubs = json.loads(path.read_text(encoding='utf-8'))
  removed = 0
  kept = 0

  for c in clubs:
    if c.get('bucket') != 'departments':
      continue
    email = c.get('email')
    if not email:
      continue

    name = (c.get('name') or '').strip().lower()
    em = norm_email(email)

    if em == 'csi@ramapo.edu' and name == 'center for student involvement':
      kept += 1
      continue

    slug = slug_from_archway_url(c.get('websiteUrl'))
    supported = False
    if slug and em in (slug_emails.get(slug) or set()):
      supported = True

    if supported:
      kept += 1
    else:
      c.pop('email', None)
      removed += 1

  path.write_text(json.dumps(clubs, indent=2) + '\n', encoding='utf-8')
  return kept, removed


def main() -> int:
  detail = json.loads(DETAIL.read_text(encoding='utf-8'))
  slug_emails = build_slug_email_index(detail)

  pub_kept, pub_removed = apply(PUBLIC, slug_emails)
  norm_kept, norm_removed = apply(NORMALIZED, slug_emails)

  print(f'public: kept={pub_kept} removed={pub_removed}')
  print(f'normalized: kept={norm_kept} removed={norm_removed}')
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
