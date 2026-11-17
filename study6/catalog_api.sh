#!/usr/bin/env bash
# Temporary diagnostic (removed before merge): what the catalog's public sitemap lists, whether
# its server-rendered pages hold policy text, and how the dining site's script holds its menu key.
set -u
curl -sSL -A 'Mozilla/5.0' https://catalog.ramapo.edu/sitemap.xml -o sitemap.xml -w '%{http_code} %{size_download}\n'
grep -o '<loc>[^<]*</loc>' sitemap.xml | sed 's/<[^>]*>//g' > locs.txt
wc -l < locs.txt; sed -E 's#https?://[^/]+(/[^/?#]*).*#\1#' locs.txt | sort | uniq -c | sort -rn | head
grep -i 'polic\|/pages/' locs.txt | head -20
for u in $(grep -i '/pages/\|polic' locs.txt | head -3); do
  sleep 1; curl -sSL -A 'Mozilla/5.0' "$u" -o p.html -w "$u %{http_code} %{size_download}\n"
  node -e 'const {load}=require("cheerio");const $=load(require("fs").readFileSync("p.html","utf8"));$("script,style").remove();const t=$("#main-content").text().replace(/\s+/g," ").trim();console.log("  text",t.length,":",t.slice(0,300))'
done
echo "--- dining key context"
curl -sSL https://ramapo.sodexomyway.com/static/js/main.eee9cc65.js | grep -oE '.{0,160}68717828-b754-420d-9488-4c37cb7d7ef7.{0,80}' | head -3
