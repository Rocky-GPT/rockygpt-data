"""Save the markup around a schedule label on one public page (one request), to see how the page
builds its list rows (step 6). PAGE names the address, LOOK the words to find."""

import os
import re
import urllib.request
from pathlib import Path

OUT = Path(os.environ.get("OUT_DIR", "."))
page = os.environ.get("PAGE", "https://www.ramapo.edu/stem-center/")
look = os.environ.get("LOOK", "Appointment Required")
request = urllib.request.Request(page, headers={"User-Agent": "Mozilla/5.0 (RockyGPT data study)"})
html = urllib.request.urlopen(request, timeout=30).read().decode("utf-8", "replace")
print("bytes", len(html))
spots = [m.start() for m in re.finditer(re.escape(look), html)][:3]
for at in spots:
    print("=" * 30, at)
    print(html[max(0, at - 1500): at + 2500])
