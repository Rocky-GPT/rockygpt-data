"""Fetch the home page of each school or program site no office owns yet (one request each) and
print the lines that name a school, office, email or phone, so an owner can be reviewed with the
site's own words. No model call."""

import html as stdhtml
import re
import time
import urllib.request

FOLDERS = ["centers-institutes", "certificates", "cli", "dh", "dmc", "dnp", "mals", "mase", "mba",
           "mpp", "msac", "msn", "sabrincenter", "scholarsday", "siah", "social-work", "ssec", "te"]
WANT = re.compile(r"school of|office|@ramapo\.edu|\(201\)|684-|convener|director|dean|contact|"
                  r"anisfield|nursing|social sciences|humanities|business", re.I)
for folder in FOLDERS:
    url = f"https://www.ramapo.edu/{folder}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "RockyGPT-study/1.0"})
        page = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        print(f"##### {folder}: {exc}")
        continue
    body = re.sub(r"(?is)<(script|style|nav|head)\b.*?</\1>", " ", page)
    body = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d|tr|td)>", "\n", body)
    text = stdhtml.unescape(re.sub(r"<[^>]+>", " ", body))
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln and len(ln) < 400]
    title = re.search(r"(?is)<title>(.*?)</title>", page)
    print(f"##### {folder} | {stdhtml.unescape(title.group(1).strip()) if title else ''}")
    seen = set()
    for ln in lines:
        if WANT.search(ln) and ln not in seen:
            seen.add(ln)
            print("   ", ln[:300])
    time.sleep(2)
