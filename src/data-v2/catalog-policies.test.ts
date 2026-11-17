import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogPolicyPages, checkCatalogPoliciesOwner, isCatalogPageRecord, policiesPageUrl, publishedPolicies,
  type CatalogPoliciesCapture } from './catalog-policies';

// The catalog page record the index's own script receives: the published tabs and an unpublished draft.
function pageRecord(published: string[], draft: string[]): unknown {
  const tabs = (names: string[]) => names.map(name => ({ id: String(name.length), name,
    anchor: name.toLowerCase().replace(/\s+/g, '-'), content: `<h2>${name}</h2><p>${name} rule.</p><h3>Procedure</h3><p>Email the Provost.</p>` }));
  return { id: 'ABC123', slug: 'ABC123', published: true, publishedAt: Date.UTC(2026, 8, 16),
    widgets: [{ type: 'tabs', data: tabs(published) }], temporaryWidgets: [{ type: 'tabs', data: tabs(draft) }] };
}

test('the index links one catalog page, and only its published tabs are read', () => {
  assert.equal(policiesPageUrl('<a href="/pages/ABC123">Used Name</a><a href="/pages/ABC123#x">Grading</a>'),
    'https://catalog.ramapo.edu/pages/ABC123');
  assert.throws(() => policiesPageUrl('<a href="/pages/A1">a</a><a href="/pages/B2">b</a>'), /2 catalog pages/);
  const { policies, publishedAt } = publishedPolicies(pageRecord(['Used Name', 'Grading System'], ['Draft Only']), 'ABC123');
  assert.deepEqual(policies.map(policy => policy.name), ['Used Name', 'Grading System']);
  assert.equal(publishedAt, '2026-09-16T00:00:00.000Z');
  assert.throws(() => publishedPolicies({ id: 'ABC123', published: false, widgets: [] }, 'ABC123'));
  assert.throws(() => publishedPolicies({ id: 'OTHER', published: true, widgets: [] }, 'ABC123'));
});

test('only the record of the linked catalog page is taken from what the browser receives', () => {
  assert.equal(isCatalogPageRecord('https://app.coursedog.com/api/v1/cm/ramapo/catalogPages/CAT1/ABC123?x=1', 'ABC123'), true);
  assert.equal(isCatalogPageRecord('https://app.coursedog.com/api/v1/cm/ramapo/catalogPages/CAT1/ABC1234', 'ABC123'), false);
  assert.equal(isCatalogPageRecord('https://catalog.ramapo.edu/pages/ABC123', 'ABC123'), false);
});

test('each policy is a row cited to its own tab, its sections named under the policy', () => {
  const { policies } = publishedPolicies(pageRecord(['Used Name'], []), 'ABC123');
  const capture: CatalogPoliciesCapture = { dataset: 'catalog-policies', collectedAt: '2026-10-20T00:00:00.000Z',
    index: { url: 'https://catalog.ramapo.edu/quicklinks/academicpolicies',
      text: 'The Office of the Provost is the unit responsible for the maintenance and implementation of all academic policies.' },
    page: { url: 'https://catalog.ramapo.edu/pages/ABC123', publishedAt: null }, policies };
  const [row] = catalogPolicyPages(capture);
  assert.equal(row.url, 'https://catalog.ramapo.edu/quicklinks/academicpolicies#used-name');
  assert.equal(row.key, 'catalog.ramapo.edu/pages/ABC123/#used-name');
  assert.deepEqual(row.sections.map(section => section.heading), ['Used Name', 'Used Name: Procedure']);
  const owner = { folder: 'catalog-academic-policies', owner: 'Office of the Provost', evidence_url: capture.index.url, reviewed_on: '2026-10-19',
    evidence_quote: 'The Office of the Provost is the unit responsible for the maintenance and implementation of all academic policies' };
  assert.equal(checkCatalogPoliciesOwner(owner, capture).owner, 'Office of the Provost');
  assert.throws(() => checkCatalogPoliciesOwner({ ...owner, evidence_quote: 'gone words' }, capture), /no longer on/);
});
