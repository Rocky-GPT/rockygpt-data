// Temporary diagnostic (removed before merge): the policies page's data as the browser receives it.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const bodies = new Map();
page.on('response', async (r) => {
  const u = r.url();
  if (/catalogPages\//.test(u) && r.status() === 200 && !bodies.has(u.split('?')[0])) {
    try { bodies.set(u.split('?')[0], await r.json()); } catch {}
  }
});
await page.goto('https://catalog.ramapo.edu/quicklinks/academicpolicies', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await browser.close();
for (const [u, d] of bodies) {
  console.log('==', u.replace(/.*catalogPages\//, ''), 'keys:', Object.keys(d).join(','));
  for (const k of ['id', 'slug', 'title', 'name', 'type', 'published', 'publishedAt', 'lastEditedAt', 'url', 'pageId']) if (k in d) console.log('  ', k, JSON.stringify(d[k]).slice(0, 100));
  const ws = d.widgets || []; console.log('  widgets', ws.length, ws.map((w) => w.type).join(','), '| temporaryWidgets', (d.temporaryWidgets || []).length);
  for (const w of ws) {
    if (w.type !== 'tabs') { console.log('   widget', w.type, Object.keys(w).join(','), JSON.stringify(w.data)?.slice(0, 200)); continue; }
    const tabs = w.data || [];
    console.log('   tabs', tabs.length, 'tab keys:', Object.keys(tabs[0] || {}).join(','));
    for (const t of tabs.slice(0, 3)) console.log('    ', JSON.stringify({ id: t.id, name: t.name, anchor: t.anchor, content: (t.content || '').length }));
    const sizes = tabs.map((t) => (t.content || '').length); console.log('    total html', sizes.reduce((a, b) => a + b, 0), 'empty', sizes.filter((s) => !s).length);
  }
}
