import assert from 'node:assert/strict';
import test from 'node:test';
import { documentTitle, menuDocuments } from './menu-documents';

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
