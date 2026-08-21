#!/usr/bin/env python3
"""
Fetch GroupMe directory/community group info (requires login).

Why this exists:
- GroupMe directory group listings are authenticated.
- Headless logins frequently trigger a human verification puzzle.

Default behavior is HEADFUL so the user can complete verification in the opened browser.

Output:
- data/raw/groupme-directory.raw.json (minimized to public group names and join URLs)
"""

import argparse
import getpass
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import requests
from playwright.sync_api import TimeoutError as PwTimeout
from playwright.sync_api import sync_playwright


JOIN_LINK_RE = re.compile(
    r"https?://groupme\.com/join_(?:group|community)/\d+/[A-Za-z0-9_-]{8}", re.I
)


def extract_join_links(obj: Any) -> Set[str]:
    links: Set[str] = set()
    if isinstance(obj, str):
        for m in JOIN_LINK_RE.findall(obj):
            links.add(m)
        return links
    if isinstance(obj, list):
        for v in obj:
            links |= extract_join_links(v)
        return links
    if isinstance(obj, dict):
        for v in obj.values():
            links |= extract_join_links(v)
        return links
    return links


def sanitize_groupme_output(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only fields used by RockyGPT; never persist authenticated API payloads."""
    directory = payload.get("directory") if isinstance(payload.get("directory"), dict) else {}
    directory_groups = (
        payload.get("directoryGroups")
        if isinstance(payload.get("directoryGroups"), dict)
        else {}
    )
    safe_groups: List[Dict[str, str]] = []
    seen: Set[Tuple[str, str]] = set()
    for group in directory_groups.get("groups") or []:
        if not isinstance(group, dict):
            continue
        name = str(group.get("name") or "").strip()
        share_url = str(group.get("share_url") or "").strip()
        if not name or not JOIN_LINK_RE.fullmatch(share_url):
            continue
        key = (name, share_url)
        if key in seen:
            continue
        seen.add(key)
        safe_groups.append({"name": name, "share_url": share_url})
    safe_groups.sort(key=lambda group: (group["name"].lower(), group["share_url"]))

    found_join_links = sorted(
        link
        for link in set(payload.get("foundJoinLinks") or [])
        if isinstance(link, str) and JOIN_LINK_RE.fullmatch(link)
    )
    found_join_links = sorted(set(found_join_links) | {group["share_url"] for group in safe_groups})

    auth = payload.get("auth") if isinstance(payload.get("auth"), dict) else {}
    safe: Dict[str, Any] = {
        "version": "1.1",
        "dataset": "groupme-directory",
        "collectedAt": payload.get("collectedAt"),
        "directory": {
            "id": directory.get("id"),
            "shareUrl": directory.get("shareUrl"),
        },
        "auth": {"authenticated": bool(auth.get("authenticated") or auth.get("hasTokenCookie"))},
        "directoryGroups": {
            "ok": bool(directory_groups.get("ok")),
            "groupsFetched": len(safe_groups),
            "groups": safe_groups,
        },
        "foundJoinLinks": found_join_links,
    }
    if not directory_groups.get("ok") and directory_groups.get("error"):
        safe["directoryGroups"]["error"] = str(directory_groups.get("error"))[:200]
    return safe


def groupme_get(url: str, token: Optional[str]) -> Dict[str, Any]:
    headers: Dict[str, str] = {
        "Accept": "application/json",
        "User-Agent": "RockyGPT groupme fetcher",
    }
    if token:
        headers["X-Access-Token"] = token
    r = requests.get(url, headers=headers, timeout=30)
    try:
        js = r.json()
    except Exception:
        js = None
    return {
        "url": url,
        "status": r.status_code,
        "json": js,
        "text_head": (r.text or "")[:600],
    }


def find_token_cookie(cookies: Any) -> Optional[Dict[str, Any]]:
    for c in cookies or []:
        if c.get("name") == "token" and c.get("domain") and "groupme.com" in c.get("domain"):
            return c
    return None


def read_credentials() -> Tuple[str, str]:
    user = os.environ.get("GROUPME_USER")
    if not user:
        sys.stdout.write("GroupMe email: ")
        sys.stdout.flush()
        user = sys.stdin.readline().strip()
    pwd = os.environ.get("GROUPME_PASS")
    if not pwd:
        pwd = getpass.getpass("GroupMe password: ")
    if not user or not pwd:
        raise SystemExit("Missing GroupMe credentials.")
    return user, pwd


def try_extract_access_token(page: Any, cookies: Any) -> Optional[str]:
    token_cookie = find_token_cookie(cookies)
    if token_cookie and token_cookie.get("value"):
        return str(token_cookie["value"])

    # Some GroupMe web flows keep auth in localStorage; probe common keys.
    try:
        storage = page.evaluate(
            """() => {
              const out = {};
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                out[k] = localStorage.getItem(k);
              }
              return out;
            }"""
        )
    except Exception:
        storage = {}

    if isinstance(storage, dict):
        # Look for obvious token fields without persisting the whole storage blob.
        for k, v in storage.items():
            if not isinstance(v, str) or not v:
                continue
            if "token" not in k.lower() and "session" not in k.lower():
                continue
            try:
                parsed = json.loads(v)
            except Exception:
                parsed = None
            if isinstance(parsed, dict):
                for key in ("token", "access_token", "accessToken"):
                    cand = parsed.get(key)
                    if isinstance(cand, str) and cand.strip():
                        return cand.strip()

    return None


def list_directory_groups_page(
    directory_id: int, token: str, params: Dict[str, Any]
) -> Tuple[int, Optional[List[Dict[str, Any]]], Dict[str, Any]]:
    url = f"https://api.groupme.com/v3/directories/{directory_id}/groups"
    headers: Dict[str, str] = {
        "Accept": "application/json",
        "User-Agent": "RockyGPT groupme fetcher",
        "X-Access-Token": token,
    }
    r = requests.get(url, headers=headers, params=params, timeout=30)
    try:
        js = r.json()
    except Exception:
        js = None
    if not isinstance(js, dict):
        return r.status_code, None, {"error": "non-json response", "text_head": (r.text or "")[:400]}
    resp = js.get("response")
    if isinstance(resp, list):
        return r.status_code, resp, js
    return r.status_code, None, js


def fetch_all_directory_groups(directory_id: int, token: str, page_size: int, max_pages: int) -> Dict[str, Any]:
    # Try a few common pagination schemes and pick the one that yields the largest first page.
    schemes = [
        ("page", "per_page"),
        ("page", "limit"),
        ("page", "page_size"),
        ("offset", "limit"),
    ]

    best = None
    best_count = -1
    best_probe = None

    for scheme in schemes:
        page_key, size_key = scheme
        params = {page_key: 1 if page_key == "page" else 0, size_key: page_size}
        status, resp, js = list_directory_groups_page(directory_id, token, params)
        count = len(resp) if isinstance(resp, list) else -1
        probe = {"scheme": scheme, "params": params, "status": status}
        if isinstance(js, dict) and "meta" in js:
            probe["meta"] = js.get("meta")
        best_probe = best_probe or []
        best_probe.append(probe)
        if status == 200 and count > best_count:
            best = scheme
            best_count = count

    if not best or best_count <= 0:
        return {
            "ok": False,
            "error": "unable to paginate directory groups (no scheme returned results)",
            "probes": best_probe,
            "groups": [],
        }

    page_key, size_key = best
    groups: List[Dict[str, Any]] = []

    for i in range(max_pages):
        if page_key == "page":
            params = {page_key: i + 1, size_key: page_size}
        else:
            # offset-based
            params = {page_key: i * page_size, size_key: page_size}

        status, resp, js = list_directory_groups_page(directory_id, token, params)
        if status != 200 or not isinstance(resp, list):
            return {
                "ok": False,
                "error": "pagination request failed",
                "scheme": best,
                "failedAt": {"status": status, "params": params},
                "groups": groups,
            }

        if not resp:
            break

        groups.extend(resp)

        if len(resp) < page_size:
            break

    # Dedupe by group_id when present.
    seen = set()
    deduped: List[Dict[str, Any]] = []
    for g in groups:
        gid = g.get("group_id") or g.get("id") or json.dumps(g, sort_keys=True)[:200]
        if gid in seen:
            continue
        seen.add(gid)
        deduped.append(g)

    return {
        "ok": True,
        "scheme": best,
        "pageSize": page_size,
        "maxPages": max_pages,
        "groupsFetched": len(deduped),
        "groups": deduped,
        "probes": best_probe,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory-id", type=int, default=int(os.environ.get("GROUPME_DIRECTORY_ID", "1184")))
    parser.add_argument("--share-token", default=os.environ.get("GROUPME_DIRECTORY_TOKEN", "ryYXnL2H"))
    parser.add_argument(
        "--out",
        default=os.environ.get(
            "GROUPME_OUT_PATH",
            os.path.join(os.getcwd(), "data", "raw", "groupme-directory.raw.json"),
        ),
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run headless (may trigger verification and fail to authenticate).",
    )
    parser.add_argument(
        "--channel",
        default=os.environ.get("GROUPME_BROWSER_CHANNEL", ""),
        help='Playwright browser channel to use (e.g. "chrome" or "msedge"). Defaults to bundled Chromium.',
    )
    parser.add_argument(
        "--profile-dir",
        default=os.environ.get(
            "GROUPME_PROFILE_DIR",
            os.path.join(os.getcwd(), "data", ".cache", "groupme-playwright-profile"),
        ),
        help="Persistent profile dir to reuse login (stored locally; should be gitignored).",
    )
    parser.add_argument(
        "--manual-login",
        action="store_true",
        help="Do not type credentials. Opens the browser and waits for you to log in manually.",
    )
    parser.add_argument(
        "--login-timeout-seconds",
        type=int,
        default=int(os.environ.get("GROUPME_LOGIN_TIMEOUT_SECONDS", "240")),
        help="How long to wait for you to complete verification in the browser (headful mode).",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=int(os.environ.get("GROUPME_DIRECTORY_PAGE_SIZE", "100")),
        help="Page size to request from the directory groups endpoint (best-effort).",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=int(os.environ.get("GROUPME_DIRECTORY_MAX_PAGES", "10")),
        help="Max pages to fetch from the directory groups endpoint.",
    )
    parser.add_argument(
        "--sanitize-existing",
        action="store_true",
        help="Rewrite an existing output file using the minimized persistence schema, then exit.",
    )
    args = parser.parse_args()

    if args.sanitize_existing:
        with open(args.out, "r", encoding="utf-8") as source:
            existing = json.load(source)
        with open(args.out, "w", encoding="utf-8") as target:
            json.dump(sanitize_groupme_output(existing), target, indent=2)
            target.write("\n")
        print(args.out)
        return 0

    directory_id: int = args.directory_id
    share_token: str = str(args.share_token).strip()
    if not share_token:
        raise SystemExit("--share-token is required")

    share_url = f"https://groupme.com/join_community/{directory_id}/{share_token}"

    user = ""
    pwd = ""
    if not args.manual_login:
        user, pwd = read_credentials()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    with sync_playwright() as p:
        launch_kwargs: Dict[str, Any] = {"headless": bool(args.headless)}
        if args.channel:
            launch_kwargs["channel"] = args.channel

        # Persistent context is key: it prevents repeated verification challenges and re-logins.
        os.makedirs(args.profile_dir, exist_ok=True)
        context = p.chromium.launch_persistent_context(args.profile_dir, **launch_kwargs)
        page = context.new_page()

        page.goto("https://web.groupme.com/signin", wait_until="domcontentloaded", timeout=120_000)

        if not args.manual_login:
            email = page.locator(
                'input[autocomplete="username"], input[placeholder*="Email" i], input[aria-label*="Email" i], input[name="email"], input[type="email"], input[type="text"]'
            ).first
            password = page.locator(
                'input[autocomplete="current-password"], input[placeholder*="Password" i], input[aria-label*="Password" i], input[name="password"], input[type="password"]'
            ).first

            email.wait_for(timeout=60_000)
            email.fill(user)
            password.wait_for(timeout=60_000)
            password.fill(pwd)

            page.locator('button:has-text("Log in"), button:has-text("Login"), input[type="submit"]').first.click()

        # If GroupMe shows a verification puzzle, it typically appears immediately after login.
        # In headful mode, the user can complete it. We just wait for auth cookies to appear.
        token_cookie: Optional[Dict[str, Any]] = None
        deadline_ms = args.login_timeout_seconds * 1000
        start = page.evaluate("() => Date.now()")

        while True:
            cookies = context.cookies()
            token_cookie = find_token_cookie(cookies)
            access_token = try_extract_access_token(page, cookies)
            if access_token:
                break
            if args.headless:
                break
            now = page.evaluate("() => Date.now()")
            if now - start > deadline_ms:
                break
            page.wait_for_timeout(1000)

        cookies = context.cookies()
        token_cookie = find_token_cookie(cookies)
        token_value = try_extract_access_token(page, cookies)

        # Navigate to the community share page after login (may still redirect/403 without auth).
        try:
            page.goto(share_url, wait_until="domcontentloaded", timeout=120_000)
            page.wait_for_timeout(4000)
        except Exception:
            pass

        api_probe: List[Dict[str, Any]] = [
            # Public preview is unauthenticated and should always work.
            groupme_get(f"https://api.groupme.com/v3/directories/{directory_id}/preview/{share_token}", None),
            groupme_get(f"https://api.groupme.com/v3/directories/{directory_id}", token_value),
        ]

        directory_groups: Dict[str, Any] = {"ok": False, "groups": []}
        if token_value:
            directory_groups = fetch_all_directory_groups(
                directory_id=directory_id,
                token=token_value,
                page_size=max(1, int(args.page_size)),
                max_pages=max(1, int(args.max_pages)),
            )
        else:
            directory_groups = {"ok": False, "error": "missing token", "groups": []}

        join_links_dom = page.evaluate(
            """() => {
              const links = new Set();
              for (const a of document.querySelectorAll('a[href]')) {
                const href = a.href || '';
                if (/groupme\\.com\\/(join_group|join_community)\\//i.test(href)) links.add(href);
              }
              return Array.from(links);
            }"""
        )

        join_links: Set[str] = set(join_links_dom or [])
        for probe in api_probe:
            join_links |= extract_join_links(probe.get("json"))
            join_links |= extract_join_links(probe.get("text_head"))
        join_links |= extract_join_links(directory_groups.get("groups"))

        out = {
            "version": "1.0",
            "dataset": "groupme-directory",
            "collectedAt": datetime.now(timezone.utc).isoformat(),
            "directory": {
                "id": directory_id,
                "shareToken": share_token,
                "shareUrl": share_url,
            },
            "auth": {
                "headless": bool(args.headless),
                "hasTokenCookie": bool(token_value),
                "tokenCookieMeta": (
                    {k: token_cookie.get(k) for k in ("name", "domain", "path", "expires")} if token_cookie else None
                ),
            },
            "page": {
                "finalUrl": page.url,
            },
            "apiProbe": api_probe,
            "directoryGroups": directory_groups,
            "foundJoinLinks": sorted(join_links),
        }

        safe_out = sanitize_groupme_output(out)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(safe_out, f, indent=2)
            f.write("\n")

        context.close()

    print(args.out)
    if not out["auth"]["hasTokenCookie"]:
        print(
            "WARNING: No GroupMe auth token cookie was captured. If you saw a verification puzzle, re-run without --headless and complete it in the opened browser.",
            file=sys.stderr,
        )
    if out.get("directoryGroups", {}).get("ok") is False:
        print("WARNING: directoryGroups fetch failed; see data/raw/groupme-directory.raw.json for details.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
