// Temporary diagnostic (removed before merge): print the shape of each Coursedog page payload.
import { readFileSync } from 'fs';
for (const file of process.argv.slice(2)) {
  const html = readFileSync(file, 'utf8');
  const raw = /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  console.log(`== ${file}: ${html.length} chars, payload ${raw ? raw.length : 'NONE'}`);
  if (!raw) continue;
  const p = JSON.parse(raw);
  const at = i => (typeof i === 'number' ? p[i] : i);
  const pages = p.filter(e => e && typeof e === 'object' && !Array.isArray(e) && 'widgets' in e);
  console.log(`objects with widgets: ${pages.length}`);
  for (const pg of pages) {
    const keys = Object.keys(pg);
    const widgets = at(pg.widgets);
    const types = Array.isArray(widgets) ? widgets.map(w => at(at(w)?.type)) : widgets;
    let tabs = 0;
    if (Array.isArray(widgets)) for (const w of widgets) { const W = at(w); if (at(W?.type) === 'tabs') tabs += (at(W.data) || []).length; }
    console.log(JSON.stringify({ keys, slug: at(pg.slug), id: at(pg.id), _id: at(pg._id), url: at(pg.url), published: at(pg.published), title: at(pg.title) ?? at(pg.name), types, tabs }));
  }
  const ids = [...new Set((html.match(/\/pages\/[A-Za-z0-9]+/g) || []))];
  console.log('page links:', ids.join(' '));
}
