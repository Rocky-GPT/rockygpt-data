#!/usr/bin/env bash
# Temporary diagnostic (removed before merge): the catalog page through Coursedog's API, and
# whether the dining menu key is published on the dining site.
set -u
API=https://app.coursedog.com/api/v1/ca/ramapo_banner_ethos/catalogPages/M5oLMPPyryupPuSnHx7w
echo "--- robots"; curl -sS https://app.coursedog.com/robots.txt | head -20; curl -sS https://catalog.ramapo.edu/robots.txt | head -10
curl -sSL -A 'Mozilla/5.0' https://catalog.ramapo.edu/quicklinks/academicpolicies -o page.html
echo "--- data-page-id in page"; grep -o 'data-page-id="[^"]*"' page.html | sort | uniq -c | head
curl -sS "$API/R532kjMfIcfnIkM0srb3" -o api.json -w '%{http_code} %{size_download}\n'
node -e '
const d=JSON.parse(require("fs").readFileSync("api.json","utf8"));
console.log("keys", Object.keys(d).join(","));
for (const k of ["id","slug","title","name","published","publishedAt","lastEditedAt","url"]) console.log(k, JSON.stringify(d[k])?.slice(0,100));
const ws=d.widgets||[]; console.log("widgets", ws.length, ws.map(w=>w.type).join(","));
for (const w of ws.slice(0,6)) { const data=w.data; console.log(" widget", w.type, Array.isArray(data)?"array "+data.length:typeof data, JSON.stringify(Array.isArray(data)?data[0]:data)?.slice(0,400)); }
const tw=d.temporaryWidgets||[]; console.log("temporaryWidgets", tw.length);
'
echo "--- dining key"
curl -sSL -A 'Mozilla/5.0' https://ramapo.sodexomyway.com/en-us/locations/birch-tree-inn -o birch.html -w '%{http_code} %{size_download}\n'
KEY=68717828-b754-420d-9488-4c37cb7d7ef7
grep -c "$KEY" birch.html; grep -oE '.{0,60}'"$KEY"'.{0,20}' birch.html | head -3
grep -oE '"[A-Za-z]*[Aa]pi[Kk]ey"\s*:\s*"[^"]{0,60}"' birch.html | head -5
for js in $(grep -oE 'src="[^"]+\.js[^"]*"' birch.html | cut -d'"' -f2 | head -20); do case "$js" in http*) u="$js";; //*) u="https:$js";; *) u="https://ramapo.sodexomyway.com$js";; esac; if curl -sSL "$u" | grep -q "$KEY"; then echo "key in $u"; fi; done
