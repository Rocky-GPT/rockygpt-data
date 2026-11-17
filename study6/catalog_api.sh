#!/usr/bin/env bash
# Temporary diagnostic (removed before merge): the shape of the catalog page the index links.
set -u
curl -sSL -A 'Mozilla/5.0' https://catalog.ramapo.edu/pages/R532kjMfIcfnIkM0srb3 -o page.html -w '%{http_code} %{url_effective} %{size_download}\n'
node -e '
const html=require("fs").readFileSync("page.html","utf8");
const raw=/<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
if(!raw){console.log("no payload; title", /<title>([^<]*)/.exec(html)?.[1]); process.exit(0);}
const p=JSON.parse(raw);
const at=i=>typeof i==="number"?p[i]:i;
const isObj=e=>e&&typeof e==="object"&&!Array.isArray(e);
const show=o=>Object.entries(o).map(([k,v])=>k+"="+JSON.stringify(at(v))?.slice(0,70)).join(" | ").slice(0,1500);
console.log("payload entries",p.length);
const htmlStr=p.map((e,i)=>[i,e]).filter(([,e])=>typeof e==="string"&&/<(p|h[1-6]|ul|li)\b/.test(e)&&e.length>200);
console.log("html strings",htmlStr.length, htmlStr.slice(0,5).map(([i,s])=>i+":"+s.length).join(" "));
for(const [k,o] of p.map((e,i)=>[i,e]).filter(([,e])=>isObj(e)&&("widgets" in e||"temporaryWidgets" in e)).slice(0,4)) console.log("WIDGETS-OBJ",k,show(o));
for(const [k,o] of p.map((e,i)=>[i,e]).filter(([,e])=>isObj(e)&&"type" in e&&at(e.type)==="tabs").slice(0,3)) console.log("TABS-OBJ",k,show(o));
if(htmlStr.length){const i=htmlStr[0][0];for(const [k,o] of p.map((e,j)=>[j,e]).filter(([,e])=>isObj(e)&&Object.values(e).includes(i)).slice(0,2)) console.log("PARENT",k,show(o));
 const arrs=p.map((e,j)=>[j,e]).filter(([,e])=>Array.isArray(e)&&e.includes(htmlStr[0][0])); console.log("ARR-PARENTS",arrs.length);}
const ids=[...new Set(p.filter(e=>typeof e==="string"&&/R532kjMfIcfnIkM0srb3/.test(e)))]; console.log("slug strings",ids.slice(0,5));
for(const [k,o] of p.map((e,i)=>[i,e]).filter(([,e])=>isObj(e)&&Object.values(e).some(v=>at(v)==="R532kjMfIcfnIkM0srb3")).slice(0,4)) console.log("HAS-SLUG",k,show(o));
'
