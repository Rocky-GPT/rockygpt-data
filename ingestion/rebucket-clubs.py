#!/usr/bin/env python3
"""
Re-bucket clubs into:
- student_orgs: category contains "Student Organization"
- honor_societies: category contains "Honor Society" (or "Honour Society")
- greek_life: category contains "Greek Life" or fraternity/sorority markers
- athletics: category contains "Athletics" or "Sports / Recreation"
- departments: category contains "Department"
- other: everything else

Writes (in-place):
- public/data/clubs.json
- data/normalized/clubs.json
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data" / "clubs.json"
NORMALIZED = ROOT / "data" / "normalized" / "clubs.json"


def read_json(path: Path) -> Any:
  return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, obj: Any) -> None:
  path.write_text(json.dumps(obj, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def infer_bucket(category: str) -> str:
  cl = (category or "").lower()
  if "department" in cl:
    return "departments"
  if ("greek life" in cl or "fratern" in cl or "sororit" in cl or "greek letter" in cl) and "department" not in cl:
    return "greek_life"
  if "athletics" in cl or "sports / recreation" in cl:
    return "athletics"
  if "honor society" in cl or "honour society" in cl:
    return "honor_societies"
  if "student organization" in cl:
    return "student_orgs"
  return "other"


def rebucket(path: Path) -> Dict[str, int]:
  data = read_json(path)
  if not isinstance(data, list):
    raise SystemExit(f"Expected a list in {path}")
  changed = 0
  for c in data:
    if not isinstance(c, dict):
      continue
    before = c.get("bucket")
    after = infer_bucket(str(c.get("category") or ""))
    if before != after:
      c["bucket"] = after
      changed += 1
  write_json(path, data)
  return {"total": len(data), "changed": changed}


def main() -> int:
  pub = rebucket(PUBLIC)
  norm = rebucket(NORMALIZED)
  print(f"Updated {PUBLIC}: {pub}")
  print(f"Updated {NORMALIZED}: {norm}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
