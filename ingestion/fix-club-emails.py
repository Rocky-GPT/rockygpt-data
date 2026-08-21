#!/usr/bin/env python3
"""Fix club emails by re-scoring candidates from raw detail pages.

Goal:
- Remove generic/footer emails (especially csi@ramapo.edu)
- Prefer emails found on contact-us pages and those matching club name/slug

Reads:
- data/raw/clubs-detail.raw.json
- data/raw/clubs-about.raw.json (optional, preferred)
- public/data/clubs.json
- data/normalized/clubs.json

Writes (in-place):
- public/data/clubs.json
- data/normalized/clubs.json
"""

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

ROOT = Path(__file__).resolve().parents[2]
DETAIL = ROOT / 'data' / 'raw' / 'clubs-detail.raw.json'
ABOUT = ROOT / 'data' / 'raw' / 'clubs-about.raw.json'
PUBLIC = ROOT / 'public' / 'data' / 'clubs.json'
NORMALIZED = ROOT / 'data' / 'normalized' / 'clubs.json'

IGNORED = {
  'csi@ramapo.edu',
  'archway-support@ramapo.edu',
}

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)

STOPWORDS = {
  'a','an','and','at','for','from','in','of','on','or','the','to','with',
  'ramapo','college','rcnj','club','organization','org','team','society','association',
  'meeting','general','group','official',
}


def norm_email(e: str) -> str:
  return e.strip().lower()


def norm_name(s: str) -> str:
  return ' '.join(re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).split()).strip()


def tokens(name: str) -> List[str]:
  out = []
  for t in norm_name(name).split(' '):
    if len(t) >= 2 and t not in STOPWORDS:
      out.append(t)
  return out


def slug_from_website(url: Optional[str]) -> str:
  if not url:
    return ''
  try:
    # crude parse
    parts = url.split('://', 1)[-1].split('/', 1)
    path = parts[1] if len(parts) > 1 else ''
    seg = path.split('?', 1)[0].split('#', 1)[0].strip('/').split('/', 1)[0]
    return seg.lower()
  except Exception:
    return ''


def first_segment(url: str) -> str:
  try:
    parts = url.split('://', 1)[-1].split('/', 1)
    path = parts[1] if len(parts) > 1 else ''
    seg = path.split('?', 1)[0].split('#', 1)[0].strip('/').split('/', 1)[0]
    return seg.lower()
  except Exception:
    return ''


def score_candidate(club_name: str, slug: str, email: str, occ: int, on_contact: bool, global_count: int) -> int:
  e = norm_email(email)
  if '@' not in e:
    return -10**9
  if e in IGNORED:
    return -10**9
  if e.endswith('@campusgroups.com'):
    return -10**9
  local, domain = e.split('@', 1)
  score = 0
  if domain == 'ramapo.edu':
    score += 1
  if on_contact:
    score += 8
  score += min(5, occ)
  for t in tokens(club_name):
    if t and t in local:
      score += 2
  slug_token = re.sub(r'[^a-z0-9]', '', slug)
  if slug_token and slug_token in local:
    score += 3
  # global_count here is spread (unique slugs), not raw occurrences.
  if global_count >= 30:
    score -= 80
  elif global_count >= 10:
    score -= 40
  elif global_count >= 5:
    score -= 20
  elif global_count == 1:
    score += 2
  return score


def build_best_emails(detail: dict, clubs: list) -> Dict[str, Optional[str]]:
  # Prefer authenticated About scrape results when available.
  about_best: Dict[str, str] = {}
  if ABOUT.exists():
    try:
      about = json.loads(ABOUT.read_text(encoding='utf-8'))
      items = about.get('items') if isinstance(about, dict) else None
      if isinstance(items, list):
        for it in items:
          if not isinstance(it, dict):
            continue
          name = (it.get('clubName') or '').strip()
          email = (it.get('email') or '').strip().lower()
          if not name or not email:
            continue
          if email in IGNORED and name.strip().lower() != 'center for student involvement':
            continue
          if email.endswith('@campusgroups.com'):
            continue
          about_best[name] = email
    except Exception:
      about_best = {}

  pages = detail.get('pages') or []

  global_spread: Dict[str, Set[str]] = defaultdict(set)
  for p in pages:
    if p.get('sourceType') != 'detail':
      continue
    # Count any email-like text on the page to identify global footer addresses.
    blob = []
    blob.append(p.get('url') or '')
    for c in (p.get('contacts') or []):
      blob.append((c.get('email') or ''))
    for s in (p.get('sections') or []):
      blob.append((s.get('heading') or ''))
      blob.append((s.get('text') or ''))
    for lst in (p.get('lists') or []):
      for it in (lst or []):
        blob.append(it or '')
    for t in (p.get('tables') or []):
      for h in (t.get('headers') or []):
        blob.append(h or '')
      for row in (t.get('rows') or []):
        for cell in (row or []):
          blob.append(cell or '')
    text = "\n".join(blob)
    slug = first_segment(p.get('url') or '')
    for e in EMAIL_RE.findall(text):
      ne = norm_email(e)
      if not ne:
        continue
      if ne in IGNORED or ne.endswith('@campusgroups.com'):
        continue
      if slug:
        global_spread[ne].add(slug)

  global_counts = Counter({k: len(v) for k, v in global_spread.items()})

  slug_to_club = {}
  for club in clubs:
    slug = slug_from_website(club.get('websiteUrl'))
    if slug:
      slug_to_club[slug] = club

  # candidates[club_name] -> email -> (occ, on_contact)
  candidates: Dict[str, Dict[str, List[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))

  for p in pages:
    if p.get('sourceType') != 'detail':
      continue
    url = p.get('url') or ''
    seg = first_segment(url)
    if not seg:
      continue
    club = slug_to_club.get(seg)
    if not club:
      continue
    club_name = club.get('name') or ''
    on_contact = 1 if re.search(r'/contact-us/?$', url, re.I) else 0

    blob = []
    for c in (p.get('contacts') or []):
      blob.append((c.get('email') or ''))
    for s in (p.get('sections') or []):
      blob.append((s.get('heading') or ''))
      blob.append((s.get('text') or ''))
    for lst in (p.get('lists') or []):
      for it in (lst or []):
        blob.append(it or '')
    for t in (p.get('tables') or []):
      for h in (t.get('headers') or []):
        blob.append(h or '')
      for row in (t.get('rows') or []):
        for cell in (row or []):
          blob.append(cell or '')
    text = "\n".join(blob)
    for e in EMAIL_RE.findall(text):
      ne = norm_email(e)
      if not ne or '@' not in ne:
        continue
      if ne in IGNORED:
        continue
      # Skip obvious scrape artifacts like "podcastclub@ramapo.eduwrpr"
      if ne.endswith('ramapo.eduwrpr') or ne.endswith('ramapo.eduwr'):
        continue
      rec = candidates[club_name][ne]
      rec[0] += 1
      rec[1] = 1 if (rec[1] or on_contact) else 0

  best: Dict[str, Optional[str]] = {}
  for club in clubs:
    name = club.get('name') or ''
    slug = slug_from_website(club.get('websiteUrl'))

    # About scrape is the source of truth when present.
    if name in about_best:
      best[name] = about_best[name]
      continue

    # Keep CSI email only for the CSI org itself.
    if name.strip().lower() == 'center for student involvement':
      best[name] = 'csi@ramapo.edu'
      continue

    cand_map = candidates.get(name) or {}
    best_email = None
    best_score = -10**9
    for ne, (occ, on_contact) in cand_map.items():
      s = score_candidate(name, slug, ne, occ, bool(on_contact), global_counts.get(ne, 0))
      if s > best_score:
        best_score = s
        best_email = ne

    if not best_email or best_score < 6:
      best[name] = None
    else:
      best[name] = best_email

  return best


def apply_to_file(path: Path, best_by_name: Dict[str, Optional[str]]) -> Tuple[int, int]:
  clubs = json.loads(path.read_text(encoding='utf-8'))
  changed = 0
  cleared_csi = 0
  for c in clubs:
    name = c.get('name')
    if not name:
      continue
    before = (c.get('email') or '').strip() or None
    after = best_by_name.get(name, before)

    if before and norm_email(before) == 'csi@ramapo.edu' and (after is None or norm_email(after) != 'csi@ramapo.edu'):
      cleared_csi += 1

    if after is None:
      c.pop('email', None)
    else:
      c['email'] = after

    if before != after:
      changed += 1

  path.write_text(json.dumps(clubs, indent=2) + '\n', encoding='utf-8')
  return changed, cleared_csi


def main() -> int:
  if not DETAIL.exists():
    raise SystemExit(f'Missing {DETAIL}')
  detail = json.loads(DETAIL.read_text(encoding='utf-8'))

  clubs_public = json.loads(PUBLIC.read_text(encoding='utf-8'))
  best = build_best_emails(detail, clubs_public)

  pub_changed, pub_cleared = apply_to_file(PUBLIC, best)
  norm_changed, norm_cleared = apply_to_file(NORMALIZED, best)

  print(f'Updated emails: public changed={pub_changed}, cleared_csi={pub_cleared}')
  print(f'Updated emails: normalized changed={norm_changed}, cleared_csi={norm_cleared}')
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
