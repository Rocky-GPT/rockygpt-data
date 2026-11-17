// Temporary diagnostic (removed before merge): the catalog's policy subpages and their shape.
import { readFileSync, writeFileSync } from 'fs';
import { load } from 'cheerio';
const mode = process.argv[2];
if (mode === 'links') {
  const $ = load(readFileSync(process.argv[3], 'utf8'));
  const links = new Set();
  $('#main-content a[href]').each((_, a) => links.add($(a).attr('href')));
  console.log('main-content links', links.size);
  for (const l of links) console.log('LINK', l);
  writeFileSync('links.txt', [...links].join('\n'));
} else {
  for (const file of process.argv.slice(3)) {
    const html = readFileSync(file, 'utf8');
    const $ = load(html);
    const raw = /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const p = raw ? JSON.parse(raw) : [];
    const isObj = e => e && typeof e === 'object' && !Array.isArray(e);
    const at = i => (typeof i === 'number' ? p[i] : i);
    const html2k = p.map((e, i) => [i, e]).filter(([, e]) => typeof e === 'string' && /<(p|h[1-6]|ul|li)\b/.test(e) && e.length > 300);
    console.log(`== ${file}: ${html.length} chars; payload strings with HTML: ${html2k.length} (${html2k.map(([i, s]) => `${i}:${s.length}`).slice(0, 6).join(' ')})`);
    for (const [i] of html2k.slice(0, 2)) {
      for (const [j, parent] of p.map((e, k) => [k, e]).filter(([, e]) => isObj(e) && Object.values(e).includes(i)).slice(0, 2)) {
        console.log(`  parent ${j}: ${Object.entries(parent).map(([k, v]) => `${k}=${JSON.stringify(at(v))?.slice(0, 80)}`).join(' | ')}`);
      }
    }
    const pageObjs = p.filter(e => isObj(e) && ('slug' in e || 'pageId' in e) && ('title' in e || 'name' in e));
    for (const o of pageObjs.slice(0, 4)) console.log('  page-like', Object.entries(o).map(([k, v]) => `${k}=${JSON.stringify(at(v))?.slice(0, 60)}`).join(' | ').slice(0, 900));
    const main = $('#tab-content-panel').length ? $('#tab-content-panel') : $('#main-content');
    main.find('script,style').remove();
    console.log('  main text', main.text().replace(/\s+/g, ' ').trim().length, ':', main.text().replace(/\s+/g, ' ').trim().slice(0, 700));
    const hs = []; main.find('h1,h2,h3,h4').each((_, el) => hs.push(`${el.tagName}:${$(el).text().trim().slice(0, 50)}`));
    console.log('  headings', hs.slice(0, 20).join(' | '));
    console.log('  meta', $('meta[property="article:modified_time"]').attr('content'), $('link[rel=canonical]').attr('href'));
  }
}
