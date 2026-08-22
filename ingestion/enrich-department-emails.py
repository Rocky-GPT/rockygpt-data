#!/usr/bin/env python3
"""Enrich department club records with emails found anywhere in data/raw.

This is a best-effort pass over existing raw datasets to fill missing department emails.
We do NOT overwrite an existing email.

Inputs:
- public/data/clubs.json
- data/normalized/clubs.json
- data/raw/*.raw.json (RawDatasetV1 pages or simple arrays)

Outputs (in-place):
- public/data/clubs.json
- data/normalized/clubs.json

Heuristics:
- Only applies to records with bucket == 'departments'
- Matches pages by keyword overlap with department name
- Extracts emails from page.contacts + sections/lists/tables/documents/url
- Ignores generic/noise emails (csi@ramapo.edu, archway-support@ramapo.edu, *@campusgroups.com)
"""

import glob
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public' / 'data' / 'clubs.json'
NORMALIZED = ROOT / 'data' / 'normalized' / 'clubs.json'
RAW_DIR = ROOT / 'data' / 'raw'

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)

IGNORED_EMAILS = {
  'csi@ramapo.edu',
  'archway-support@ramapo.edu',
}

STOPWORDS = {
  'a','an','and','at','for','from','in','of','on','or','the','to','with',
  'ramapo','college','rcnj','department','departments','office','center','program',
  'services','service','student','students','affairs',
}


def norm(s: str) -> str:
  return ' '.join(re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).split()).strip()


def tokens(name: str) -> List[str]:
  out = []
  for t in norm(name).split(' '):
    if len(t) >= 3 and t not in STOPWORDS:
      out.append(t)
  return out


def clean_email(e: str) -> Optional[str]:
  if not e:
    return None
  e = e.strip().lower()
  # Strip obvious trailing punctuation
  e = e.rstrip('.,;:)')
  if '@' not in e:
    return None
  if e in IGNORED_EMAILS:
    return None
  if e.endswith('@campusgroups.com'):
    return None
  # Filter known scrape artifacts
  if e.endswith('ramapo.eduwrpr') or e.endswith('ramapo.eduwr'):
    return None
  return e


def extract_emails_from_obj(obj: Any) -> Set[str]:
  emails: Set[str] = set()
  if obj is None:
    return emails
  if isinstance(obj, str):
    for e in EMAIL_RE.findall(obj):
      ce = clean_email(e)
      if ce:
        emails.add(ce)
    return emails
  if isinstance(obj, list):
    for v in obj:
      emails |= extract_emails_from_obj(v)
    return emails
  if isinstance(obj, dict):
    for v in obj.values():
      emails |= extract_emails_from_obj(v)
    return emails
  return emails


def page_text(page: Dict[str, Any]) -> str:
  parts: List[str] = []
  parts.append(page.get('url') or '')
  for c in page.get('contacts') or []:
    parts.append(c.get('name') or '')
    parts.append(c.get('email') or '')
    parts.append(c.get('phone') or '')
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
  return '\n'.join(p for p in parts if p)


def load_json(path: Path) -> Any:
  return json.loads(path.read_text(encoding='utf-8'))


def dump_json(path: Path, obj: Any) -> None:
  path.write_text(json.dumps(obj, indent=2) + '\n', encoding='utf-8')


def build_raw_pages_index() -> List[Tuple[str, Dict[str, Any], str, Set[str]]]:
  out: List[Tuple[str, Dict[str, Any], str, Set[str]]] = []
  for fp in sorted(glob.glob(str(RAW_DIR / '*.raw.json'))):
    name = Path(fp).name
    data = load_json(Path(fp))

    # RawDatasetV1 style
    if isinstance(data, dict) and isinstance(data.get('pages'), list):
      for page in data['pages']:
        if not isinstance(page, dict):
          continue
        text = page_text(page)
        if not text:
          continue
        emails = extract_emails_from_obj(text)
        out.append((name, page, text.lower(), emails))
      continue

    # Array of records style (e.g. clubs.raw.json)
    if isinstance(data, list):
      for row in data:
        if not isinstance(row, dict):
          continue
        text = json.dumps(row)
        emails = extract_emails_from_obj(text)
        out.append((name, row, text.lower(), emails))
      continue

    # Other dict
    text = json.dumps(data)
    emails = extract_emails_from_obj(text)
    out.append((name, {'_root': True}, text.lower(), emails))

  return out


def pick_best_email(candidates: Dict[str, int]) -> Optional[str]:
  if not candidates:
    return None
  # Prefer ramapo.edu
  def key(e: str) -> Tuple[int, int, str]:
    domain = e.split('@', 1)[1] if '@' in e else ''
    domain_score = 2 if domain == 'ramapo.edu' else (1 if domain.endswith('.edu') else 0)
    return (-domain_score, -candidates[e], e)

  return sorted(candidates.keys(), key=key)[0]


def enrich(path: Path, raw_index) -> Tuple[int, int]:
  clubs = load_json(path)
  updated = 0
  considered = 0

  for c in clubs:
    if c.get('bucket') != 'departments':
      continue
    if c.get('email'):
      continue

    name = c.get('name') or ''
    toks = tokens(name)
    if not toks:
      continue

    considered += 1
    counts: Dict[str, int] = defaultdict(int)

    for raw_name, _page, text_lower, emails in raw_index:
      if not emails:
        continue

      # Require at least 2 token hits for most departments; 1 token for longer unique words.
      hits = 0
      for t in toks:
        if t in text_lower:
          hits += 1
      if hits >= 2 or (hits == 1 and any(len(t) >= 8 and t in text_lower for t in toks)):
        for e in emails:
          counts[e] += hits

    best = pick_best_email(counts)
    if best:
      c['email'] = best
      updated += 1

  dump_json(path, clubs)
  return updated, considered


def main() -> int:
  raw_index = build_raw_pages_index()
  pub_updated, pub_considered = enrich(PUBLIC, raw_index)
  norm_updated, norm_considered = enrich(NORMALIZED, raw_index)

  print(f'public: filled {pub_updated} of {pub_considered} missing department emails')
  print(f'normalized: filled {norm_updated} of {norm_considered} missing department emails')
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
