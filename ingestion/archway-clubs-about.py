#!/usr/bin/env python3
"""
Scrape authenticated Archway club "About" pages to capture contact + socials.

Why:
- The public club signup listing does not reliably include email/social links.
- The authenticated Club "About" view contains contact info + social icons.

Source pages:
- https://archway.ramapo.edu/webapp/_/_/clubs/<club_id>/about

Reads:
- data/raw/clubs.raw.json (club list seeds; contains or can infer clubId)

Writes:
- data/raw/clubs-about.raw.json

Notes:
- This script is HEADFUL by default so you can complete SSO / any prompts.
- Auth is stored in a persistent Playwright profile directory so subsequent
  runs typically do not require signing in again.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from playwright.sync_api import TimeoutError as PwTimeout
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
CLUBS_RAW = ROOT / "data" / "raw" / "clubs.raw.json"

DEFAULT_OUT = ROOT / "data" / "raw" / "clubs-about.raw.json"
DEFAULT_PROFILE_DIR = ROOT / "data" / "playwright" / "archway-profile"

ABOUT_URL_TMPL = "https://archway.ramapo.edu/webapp/_/_/clubs/{club_id}/about"
LOGIN_URL = "https://archway.ramapo.edu/login_only"

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
GROUPME_RE = re.compile(
    r"https?://groupme\.com/join_(?:group|community)/\d+/[A-Za-z0-9_-]{8}", re.I
)

CLUBID_FALLBACK_RE = re.compile(r"\bclub_(\d+)\b|\bcb_club_(\d+)\b|\bemail_restriction_(\d+)\b")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def norm_url(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    # Remove trailing slashes for stable matching.
    while u.endswith("/"):
        u = u[:-1]
    return u


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def extract_club_id(seed: Dict[str, Any]) -> Optional[str]:
    raw = (seed.get("clubId") or "").strip()
    if raw.isdigit():
        return raw
    text = (seed.get("rawCardText") or "").strip()
    m = CLUBID_FALLBACK_RE.search(text)
    if not m:
        return None
    for g in m.groups():
        if g and g.isdigit():
            return g
    return None


def classify_social(url: str) -> Optional[str]:
    try:
        host = url.split("://", 1)[-1].split("/", 1)[0].lower()
    except Exception:
        return None
    if "instagram.com" in host:
        return "instagram"
    if "facebook.com" in host:
        return "facebook"
    if "twitter.com" in host or host == "x.com" or host.endswith(".x.com"):
        return "twitter"
    if "linkedin.com" in host:
        return "linkedin"
    if "groupme.com" in host:
        return "groupme"
    return None


def pick_primary_email(emails: List[str], club_name: str) -> Optional[str]:
    # Prefer non-generic org emails. Allow CSI only for CSI org.
    lower_name = (club_name or "").strip().lower()
    allowed_csi = lower_name == "center for student involvement"

    ignored = {
        "archway-support@ramapo.edu",
    }
    if not allowed_csi:
        ignored.add("csi@ramapo.edu")

    candidates: List[str] = []
    for e in emails:
        ne = e.strip().lower()
        if not ne or "@" not in ne:
            continue
        if ne in ignored:
            continue
        if ne.endswith("@campusgroups.com"):
            continue
        candidates.append(ne)

    # Stable selection: prefer ramapo.edu, then smallest length.
    if not candidates:
        return None
    candidates.sort(key=lambda x: (0 if x.endswith("@ramapo.edu") else 1, len(x), x))
    return candidates[0]


def ensure_logged_in(context: Any, page: Any) -> None:
    """
    Best-effort: if we detect a sign-in wall, open the login page and let the user complete SSO.
    """
    try:
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=45000)
    except Exception:
        pass

    # Heuristic: if there's an "Archway Login" button or "Sign in", the user likely isn't authenticated.
    try:
        needs_login = False
        body = (page.inner_text("body") or "").lower()
        if "archway login" in body or "sign in" in body or "guest accounts" in body:
            needs_login = True
        if not needs_login:
            return
    except Exception:
        return

    sys.stdout.write(
        "\nArchway login required.\n"
        "- A browser window should be open.\n"
        "- Complete the Archway login in that window.\n"
        "- After you see the Archway site logged in, come back here and press Enter.\n\n"
    )
    sys.stdout.flush()
    sys.stdin.readline()


def scrape_about_page(page: Any, club_id: str, club_name: str) -> Dict[str, Any]:
    url = ABOUT_URL_TMPL.format(club_id=club_id)
    started_at = utc_now_iso()
    result: Dict[str, Any] = {
        "clubId": club_id,
        "clubName": club_name,
        "url": url,
        "startedAt": started_at,
        "ok": False,
    }

    try:
        # About pages often hydrate content after initial HTML; wait for network to settle.
        r = page.goto(url, wait_until="networkidle", timeout=45000)
        result["status"] = r.status if r else None
        # Try to wait for contact section; ignore timeouts to avoid failing the run.
        try:
            page.wait_for_selector("text=Contact information", timeout=8000)
        except Exception:
            pass
        try:
            page.wait_for_timeout(1200)
        except Exception:
            pass

        # If we got bounced to login, mark it clearly.
        final_url = page.url
        result["finalUrl"] = final_url
        if "login" in (final_url or "").lower():
            result["error"] = "not_authenticated"
            return result

        # Extract hrefs + visible text across frames (some pages embed content).
        hrefs: List[str] = []
        text_parts: List[str] = []
        frames = []
        try:
            frames = list(page.frames)
        except Exception:
            frames = [page.main_frame]

        for f in frames:
            try:
                part = f.inner_text("body") or ""
                if part.strip():
                    text_parts.append(part)
            except Exception:
                pass
            try:
                hs = f.eval_on_selector_all("a[href]", "els => els.map(e => e.href)") or []
                for h in hs:
                    if isinstance(h, str) and h.strip():
                        hrefs.append(h)
            except Exception:
                pass

        hrefs = [h for h in hrefs if isinstance(h, str) and h.strip()]
        text = "\n".join(text_parts)

        # If we're seeing the sign-in wall inside the about URL, treat it as not authenticated.
        lowered = text.lower()
        if (
            "archway login" in lowered
            or "guest accounts" in lowered
            or "click below to login" in lowered
            or "ramapo college of new jersey" in lowered and "sign in" in lowered and "archway" in lowered
        ):
            result["error"] = "not_authenticated"
            return result

        emails: Set[str] = set()
        for m in EMAIL_RE.findall(text):
            emails.add(m.strip())
        for h in hrefs:
            if h.lower().startswith("mailto:"):
                addr = h.split(":", 1)[-1].split("?", 1)[0].strip()
                if addr:
                    emails.add(addr)

        socials: Dict[str, List[str]] = {"instagram": [], "facebook": [], "twitter": [], "linkedin": [], "groupme": []}
        external_websites: List[str] = []

        for h in hrefs:
            kind = classify_social(h)
            if kind:
                socials[kind].append(h)
                continue
            # Capture non-Archway "Visit website" style links as external websites.
            # Keep it conservative: skip archway/campusgroups and mail/tel.
            hl = h.lower()
            if hl.startswith("mailto:") or hl.startswith("tel:"):
                continue
            try:
                host = h.split("://", 1)[-1].split("/", 1)[0].lower()
            except Exception:
                host = ""
            if "archway.ramapo.edu" in host or "campusgroups.com" in host:
                continue
            external_websites.append(h)

        # Also pull GroupMe links from text (sometimes not in anchors).
        for m in GROUPME_RE.findall(text):
            socials["groupme"].append(m)

        def uniq(xs: List[str]) -> List[str]:
            seen = set()
            out = []
            for x in xs:
                nx = norm_url(x)
                if not nx or nx in seen:
                    continue
                seen.add(nx)
                out.append(x)
            return out

        socials = {k: uniq(v) for k, v in socials.items()}
        external_websites = uniq(external_websites)

        result["emails"] = sorted({e.strip().lower() for e in emails if e.strip()})
        result["email"] = pick_primary_email(result.get("emails") or [], club_name)
        result["instagramUrl"] = socials["instagram"][0] if socials["instagram"] else None
        result["facebookUrl"] = socials["facebook"][0] if socials["facebook"] else None
        result["twitterUrl"] = socials["twitter"][0] if socials["twitter"] else None
        result["linkedinUrl"] = socials["linkedin"][0] if socials["linkedin"] else None
        result["groupmeUrls"] = socials["groupme"] if socials["groupme"] else None
        result["externalWebsiteUrls"] = external_websites if external_websites else None
        result["ok"] = True
        result["finishedAt"] = utc_now_iso()
        return result
    except PwTimeout:
        result["error"] = "timeout"
        result["finishedAt"] = utc_now_iso()
        return result
    except Exception as e:
        result["error"] = f"exception:{type(e).__name__}"
        result["finishedAt"] = utc_now_iso()
        return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR))
    ap.add_argument("--headless", action="store_true", help="Run headless (login often fails).")
    ap.add_argument("--channel", default=os.environ.get("ARCHWAY_BROWSER_CHANNEL", ""))
    ap.add_argument("--max", type=int, default=0, help="Limit number of clubs (0 means all).")
    ap.add_argument("--club-id", default="", help="Scrape a single club id (skips reading clubs.raw.json).")
    ap.add_argument("--pause-ms", type=int, default=250, help="Delay between pages (politeness).")
    args = ap.parse_args()

    out_path = Path(args.out)

    if args.club_id:
        club_seeds = [{"name": f"club:{args.club_id}", "clubId": args.club_id, "rawCardText": ""}]
    else:
        if not CLUBS_RAW.exists():
            raise SystemExit(f"Missing {CLUBS_RAW}")
        club_seeds = read_json(CLUBS_RAW)
        if not isinstance(club_seeds, list):
            raise SystemExit(f"Unexpected shape: {CLUBS_RAW} should be a list")

    seeds: List[Tuple[str, str]] = []
    for seed in club_seeds:
        if not isinstance(seed, dict):
            continue
        cid = extract_club_id(seed)
        if not cid:
            continue
        name = (seed.get("name") or "").strip()
        seeds.append((cid, name))

    # Stable order
    seeds = sorted(set(seeds), key=lambda x: int(x[0]))
    if args.max and args.max > 0:
        seeds = seeds[: args.max]

    collected_at = utc_now_iso()

    with sync_playwright() as p:
        user_data_dir = Path(args.profile_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)

        browser = p.chromium.launch_persistent_context(
            user_data_dir=str(user_data_dir),
            headless=bool(args.headless),
            channel=(args.channel or None),
            viewport={"width": 1280, "height": 800},
        )
        page = browser.new_page()

        ensure_logged_in(browser, page)

        items: List[Dict[str, Any]] = []
        failed_auth = 0

        for i, (cid, name) in enumerate(seeds):
            sys.stdout.write(f"[{i+1}/{len(seeds)}] clubs/{cid} ...\n")
            sys.stdout.flush()
            item = scrape_about_page(page, cid, name)
            items.append(item)

            if item.get("error") == "not_authenticated":
                failed_auth += 1
                # Give the user a chance to log back in.
                ensure_logged_in(browser, page)

            if args.pause_ms and args.pause_ms > 0:
                time.sleep(args.pause_ms / 1000.0)

        try:
            browser.close()
        except Exception:
            pass

    payload = {
        "version": 1,
        "dataset": "archway-clubs-about",
        "collectedAt": collected_at,
        "source": {
            "aboutUrlTemplate": ABOUT_URL_TMPL,
            "loginUrl": LOGIN_URL,
            "profileDir": str(Path(args.profile_dir)),
        },
        "stats": {
            "clubsRequested": len(seeds),
            "clubsScraped": sum(1 for it in items if it.get("ok")),
            "authFailures": failed_auth,
        },
        "items": items,
    }

    write_json(out_path, payload)
    sys.stdout.write(f"\nWrote {out_path}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
