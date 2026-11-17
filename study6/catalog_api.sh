#!/usr/bin/env bash
# Temporary diagnostic (removed before merge): the catalog app's page API.
set -u
curl -sSL -A 'Mozilla/5.0' https://catalog.ramapo.edu/quicklinks/academicpolicies -o page.html
grep -o 'https://static.catalog.prod.coursedog.com/[^"]*\.js' page.html | sort -u > js.txt
n=0; for js in $(cat js.txt); do n=$((n+1)); curl -sSL "$js" -o "b$n.js"; done
echo "--- config"
grep -oE '.{0,40}(BASE_URL|baseUrl|apiUrl|API_URL)[^,;]{0,120}' page.html | head -10
grep -oE '"https://[a-z.]*coursedog[a-z.]*"' page.html | sort -u | head
grep -oE 'https://[a-z.-]*coursedog\.com[^"`]{0,40}' b*.js | sort -u | head -20
echo "--- page fetches"
cat b*.js | grep -oE '.{0,100}`[^`]{0,40}(/pages|pages/|/ca/|catalogs/)[^`]{0,80}`.{0,60}' | sort -u | head -40
echo "--- school/catalog ids in payload"
node -e '
const html=require("fs").readFileSync("page.html","utf8");
const p=JSON.parse(/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
const at=i=>typeof i==="number"?p[i]:i; const isObj=e=>e&&typeof e==="object"&&!Array.isArray(e);
for(const [i,e] of p.entries()) if(isObj(e)&&("catalogId" in e||"schoolId" in e||"school" in e||"BASE_URL" in e||"baseUrl" in e)) console.log(i,Object.entries(e).map(([k,v])=>k+"="+JSON.stringify(at(v))?.slice(0,80)).join(" | ").slice(0,700));
console.log("strings:",p.filter(s=>typeof s==="string"&&/ramapo_|^20\d\d-20\d\d|catalog/i.test(s)&&s.length<50).slice(0,30).join(" | "));
'
