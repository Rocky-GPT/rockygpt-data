#!/usr/bin/env bash
# Temporary diagnostic (removed before merge): where the policy texts live in the catalog app.
set -u
curl -sSL -A 'Mozilla/5.0' https://catalog.ramapo.edu/quicklinks/academicpolicies -o page.html -w '%{http_code} %{url_effective} %{size_download}\n'
node -e '
const html=require("fs").readFileSync("page.html","utf8");
const raw=/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
const p=JSON.parse(raw);
const at=i=>typeof i==="number"?p[i]:i;
const isObj=e=>e&&typeof e==="object"&&!Array.isArray(e);
const show=o=>Object.entries(o).map(([k,v])=>k+"="+JSON.stringify(at(v))?.slice(0,60)).join(" | ").slice(0,900);
console.log("payload chars", raw.length, "entries", p.length, "other scripts", (html.match(/<script/g)||[]).length);
const strs=p.map((e,i)=>[i,e]).filter(([,e])=>typeof e==="string").sort((a,b)=>b[1].length-a[1].length);
for(const [i,s] of strs.slice(0,8)){console.log("LONG",i,s.length,JSON.stringify(s.slice(0,200)));
  for(const [k,o] of p.map((e,j)=>[j,e]).filter(([,e])=>isObj(e)&&Object.values(e).includes(i)).slice(0,1)) console.log("   PARENT",k,show(o));}
const keys={};for(const e of p) if(isObj(e)) {const k=Object.keys(e).sort().join(",");keys[k]=(keys[k]||0)+1;}
console.log("OBJECT SHAPES");for(const [k,n] of Object.entries(keys).sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(n, k.slice(0,300));
const hit=p.map((e,i)=>[i,e]).filter(([,e])=>typeof e==="string"&&/Academic Integrity/i.test(e)).slice(0,5);
console.log("INTEGRITY strings", hit.map(([i,s])=>i+":"+s.length+":"+JSON.stringify(s.slice(0,120))).join("\n "));
const anch=p.map((e,i)=>[i,e]).filter(([,e])=>e==="academic-integrity");
for(const [i] of anch) for(const [k,o] of p.map((e,j)=>[j,e]).filter(([,e])=>isObj(e)&&Object.values(e).includes(i)).slice(0,2)) console.log("ANCHOR-PARENT",k,show(o));
'
grep -o 'https://static.catalog.prod.coursedog.com/[^"]*\.js' page.html | sort -u > js.txt
n=0; for js in $(cat js.txt); do n=$((n+1)); curl -sSL "$js" -o "b$n.js"; done
echo "--- api-ish"
cat b*.js | grep -oE '.{0,60}(api/v[0-9]|coursedog\.com/api|apiBase|baseURL|\$fetch\(`)[^;]{0,100}' | sort -u | head -40
