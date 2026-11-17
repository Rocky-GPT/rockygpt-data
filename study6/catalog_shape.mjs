// Temporary diagnostic (removed before merge): find where the policy tabs sit in the payload.
import { readFileSync } from 'fs';
const file = process.argv[2];
const slug = process.argv[3];
const html = readFileSync(file, 'utf8');
const raw = /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
const p = JSON.parse(raw);
const at = i => (typeof i === 'number' ? p[i] : i);
const isObj = e => e && typeof e === 'object' && !Array.isArray(e);
const short = v => JSON.stringify(v)?.slice(0, 160);
const refs = idx => p.map((e, i) => [i, e]).filter(([, e]) => (isObj(e) && Object.values(e).includes(idx)) || (Array.isArray(e) && e.includes(idx)));
const keyCount = {};
for (const e of p) if (isObj(e)) for (const k of Object.keys(e)) keyCount[k] = (keyCount[k] || 0) + 1;
console.log('keys with widget/tab/page/publish:', Object.entries(keyCount).filter(([k]) => /widget|tab|page|publish|slug|anchor|content/i.test(k)).map(([k, n]) => `${k}:${n}`).join(' '));
for (const needle of [slug, 'integrity-of-degree-programs', 'tabs']) {
  const hits = p.map((e, i) => [i, e]).filter(([, e]) => e === needle);
  console.log(`== "${needle}": ${hits.length} hits at ${hits.map(h => h[0]).slice(0, 5)}`);
  for (const [i] of hits.slice(0, 3)) {
    for (const [j, parent] of refs(i).slice(0, 3)) {
      console.log(`  parent ${j}: keys=${isObj(parent) ? Object.keys(parent).join(',') : 'array len ' + parent.length}`);
      if (isObj(parent)) for (const [k, v] of Object.entries(parent)) console.log(`     ${k} -> ${short(at(v))}`);
      for (const [g, grand] of refs(j).slice(0, 2)) console.log(`    grandparent ${g}: ${isObj(grand) ? Object.keys(grand).join(',') : 'array len ' + grand.length}`);
    }
  }
}
console.log('top level 0..3:', short(p[0]), short(p[1]), short(p[2]));
