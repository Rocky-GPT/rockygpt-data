import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogPolicyPages, checkCatalogPoliciesOwner, policiesPageUrl, publishedPolicies,
  type CatalogPoliciesCapture } from './catalog-policies';

// A Nuxt payload: a flat array whose objects point at other entries by their index.
function nuxtPage(published: string[], draft: string[]): string {
  const payload: unknown[] = [];
  const add = (value: unknown) => { payload.push(value); return payload.length - 1; };
  const tabs = (names: string[]) => add(names.map(name => add({ id: add(name.length), name: add(name),
    anchor: add(name.toLowerCase().replace(/\s+/g, '-')), content: add(`<h2>${name}</h2><p>${name} rule.</p><h3>Procedure</h3><p>Email the Provost.</p>`) })));
  const widget = (names: string[]) => add([add({ type: add('tabs'), data: tabs(names) })]);
  const temporary = widget(draft), live = widget(published);
  add({ slug: add('ABC123'), published: add(true), publishedAt: add(Date.UTC(2026, 8, 16)), widgets: live, temporaryWidgets: temporary });
  return `<html><body><script type="application/json" data-nuxt-data="nuxt-app" id="__NUXT_DATA__">${JSON.stringify(payload)}</script></body></html>`;
}

test('the index links one catalog page, and only its published tabs are read', () => {
  assert.equal(policiesPageUrl('<a href="/pages/ABC123">Used Name</a><a href="/pages/ABC123#x">Grading</a>'),
    'https://catalog.ramapo.edu/pages/ABC123');
  assert.throws(() => policiesPageUrl('<a href="/pages/A1">a</a><a href="/pages/B2">b</a>'), /2 catalog pages/);
  const { policies, publishedAt } = publishedPolicies(nuxtPage(['Used Name', 'Grading System'], ['Draft Only']), 'ABC123');
  assert.deepEqual(policies.map(policy => policy.name), ['Used Name', 'Grading System']);
  assert.equal(publishedAt, '2026-09-16T00:00:00.000Z');
});

test('each policy is a row cited to its own tab, its sections named under the policy', () => {
  const { policies } = publishedPolicies(nuxtPage(['Used Name'], []), 'ABC123');
  const capture: CatalogPoliciesCapture = { dataset: 'catalog-policies', collectedAt: '2026-10-20T00:00:00.000Z',
    index: { url: 'https://catalog.ramapo.edu/quicklinks/academicpolicies',
      text: 'The Office of the Provost is the unit responsible for the maintenance and implementation of all academic policies.' },
    page: { url: 'https://catalog.ramapo.edu/pages/ABC123', publishedAt: null }, policies };
  const [row] = catalogPolicyPages(capture);
  assert.equal(row.url, 'https://catalog.ramapo.edu/pages/ABC123#used-name');
  assert.equal(row.key, 'catalog.ramapo.edu/pages/ABC123/#used-name');
  assert.deepEqual(row.sections.map(section => section.heading), ['Used Name', 'Used Name: Procedure']);
  const owner = { folder: 'catalog-academic-policies', owner: 'Office of the Provost', evidence_url: capture.index.url, reviewed_on: '2026-10-19',
    evidence_quote: 'The Office of the Provost is the unit responsible for the maintenance and implementation of all academic policies' };
  assert.equal(checkCatalogPoliciesOwner(owner, capture).owner, 'Office of the Provost');
  assert.throws(() => checkCatalogPoliciesOwner({ ...owner, evidence_quote: 'gone words' }, capture), /no longer on/);
});
