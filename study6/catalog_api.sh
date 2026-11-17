#!/usr/bin/env bash
# Temporary diagnostic (removed before merge): find the API the catalog app reads its pages from.
set -u
curl -sSL -A 'Mozilla/5.0' https://catalog.ramapo.edu/quicklinks/academicpolicies -o index.html
node -e '
const html=require("fs").readFileSync("index.html","utf8");
const raw=/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
const p=JSON.parse(raw);
const s=p.filter(e=>typeof e==="string");
console.log("school-ish:", s.filter(x=>/^[a-z]+_[a-z_]+$|ramapo|catalog/i.test(x)&&x.length<60).slice(0,40).join(" | "));
console.log("ids:", s.filter(x=>/^[A-Za-z0-9]{20}$/.test(x)).slice(0,20).join(" "));
console.log("urls:", s.filter(x=>/https?:\/\//.test(x)&&x.length<120).slice(0,30).join("\n"));
'
grep -o 'https://static.catalog.prod.coursedog.com/[^"]*\.js' index.html | sort -u > js.txt
wc -l js.txt
n=0
for js in $(cat js.txt); do
  n=$((n+1)); curl -sSL "$js" -o "b$n.js"
done
cat b*.js | grep -o '"[^"]*/api/[^"]*"' | sort | uniq -c | sort -rn | head -30
cat b*.js | grep -o '`[^`]*api[^`]*pages[^`]*`' | sort -u | head -20
cat b*.js | grep -o '[a-zA-Z/._-]*\/pages\/[^"`]*' | sort -u | head -20
cat b*.js | grep -o 'app\.coursedog\.com[^"`]*' | sort -u | head
