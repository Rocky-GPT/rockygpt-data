import assert from 'node:assert/strict';
import test from 'node:test';
import { documentTitle, isOutdatedTitle, menuDocuments, menuListings } from './menu-documents';

const venue = (name: string, uri?: string, type = 'Download') => ({ content: { main: { name, menus: uri ? [{ content: { main: {
  name: `${name} Menu`, link: { media: { content: { main: { type, uri, mimeType: 'application/pdf' } } } } } } }] : [] } } });
const state = (fragments: unknown[], extra = 'https://media-prd.example.net/web/en-us/media/Catering_tcm17-1.pdf') =>
  ({ composition: { subject: { regions: [{ fragments }] } }, other: extra });

test('a venue menu file keeps its venue, its own title and an address on the state\'s media host', () => {
  assert.equal(documentTitle('/web/en-us/media/Atrium%20Menu%20Boards%202026_tcm17-92157.pdf'), 'Atrium Menu Boards 2026');
  assert.deepEqual(menuDocuments(state([venue('The Atrium', '/web/en-us/media/Atrium%20Menu%20Boards%202026_tcm17-92157.pdf'),
    venue("Dunkin'"), venue('Birch Tree Inn', '/en-us/locations/birch-tree-inn', 'Link')])), [{
    name: 'The Atrium', title: 'Atrium Menu Boards 2026', mimeType: 'application/pdf',
    url: 'https://media-prd.example.net/web/en-us/media/Atrium%20Menu%20Boards%202026_tcm17-92157.pdf' }]);
  // No media host stated anywhere in the state: the relative file is left out, not guessed.
  assert.deepEqual(menuDocuments(state([venue('The Atrium', '/web/en-us/media/A.pdf')], '')), []);
});

test('a menu file titled only with an earlier year is an old file and left out', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  assert.equal(isOutdatedTitle('Starbucks FallMenu2024', now), true);
  assert.equal(isOutdatedTitle('Atrium Menu Boards 2026', now), false);
  assert.equal(isOutdatedTitle('The Atrium Menu', now), false);
});

test('a venue publishes dated menus only when its listing links a menu page', () => {
  const birch = { content: { main: { name: 'Birch Tree Inn', menus: [{ content: { main: { name: 'Birch Tree Inn Menu',
    link: { uri: '/en-us/locations/birch-tree-inn' } } } }] } } };
  const noMenus = { content: { main: { name: 'Hours Only' } } };
  assert.deepEqual(menuListings(state([birch, venue('The Atrium', '/web/en-us/media/A.pdf'), venue("Dunkin'"), noMenus])), [
    { name: 'Birch Tree Inn', dated: true, menus: [{ name: 'Birch Tree Inn Menu', kind: 'page', uri: '/en-us/locations/birch-tree-inn' }] },
    { name: 'The Atrium', dated: false, menus: [{ name: 'The Atrium Menu', kind: 'file', uri: '/web/en-us/media/A.pdf' }] },
    // An empty list is the page saying it names no menu; a fragment with no list at all is not a venue listing.
    { name: "Dunkin'", dated: false, menus: [] },
  ]);
});
