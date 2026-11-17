// Temporary diagnostic (removed before merge): where the policy text sits in the catalog page.
import { readFileSync } from 'fs';
import { load } from 'cheerio';
const html = readFileSync(process.argv[2], 'utf8');
const raw = /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
const p = JSON.parse(raw);
const at = i => (typeof i === 'number' ? p[i] : i);
const isObj = e => e && typeof e === 'object' && !Array.isArray(e);
p.forEach((e, i) => { if (isObj(e) && 'content' in e) console.log(`content obj ${i}: keys=${Object.keys(e).join(',')} content=${JSON.stringify(at(e.content))?.slice(0, 300)}`); });
const longStrings = p.map((e, i) => [i, e]).filter(([, e]) => typeof e === 'string' && e.length > 2000);
console.log('long strings in payload:', longStrings.length, longStrings.slice(0, 8).map(([i, s]) => `${i}:${s.length}:${JSON.stringify(s.slice(0, 120))}`).join('\n  '));
const $ = load(html);
$('script, style, noscript').remove();
console.log('visible text chars', $('body').text().replace(/\s+/g, ' ').length);
const ids = []; $('[id]').each((_, el) => ids.push(`${el.tagName}#${$(el).attr('id')}`));
console.log('ids', ids.length, ids.slice(0, 80).join(' '));
const hit = html.indexOf('integrity-of-degree-programs');
console.log('around anchor:', html.slice(Math.max(0, hit - 600), hit + 400).replace(/\s+/g, ' '));
const heads = []; $('h1,h2,h3,[role=tab],button').each((_, el) => heads.push(`${el.tagName}:${$(el).text().replace(/\s+/g, ' ').trim().slice(0, 60)}`));
console.log('heads/tabs', heads.length, heads.slice(0, 60).join(' | '));
for (const m of html.matchAll(/https?:\/\/[a-z0-9.-]*coursedog[a-z0-9.\/_-]*api[^"'\s]*/gi)) { console.log('api url', m[0]); }
