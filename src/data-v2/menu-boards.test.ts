import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { compileMenuBoard, menuBoardItemKey, type ReviewedMenuBoard } from './menu-boards';
import atrium from '../reference/atrium-menu-board.json';

const URL = 'https://media-prd.sodexomyway.net/web/en-us/media/Atrium%20Menu%20Boards%202026_tcm17-92157.pdf';
const venue = (): CampusIdentity => ({ id: '00000000-0000-4000-8000-000000000501', kind: 'venue', name: 'The Atrium', aliases: [], links: [] });
const board: ReviewedMenuBoard = { venue: 'The Atrium', document_url: URL, document_title: 'Atrium Menu Boards 2026', document_sha256: 'x', read_at: '2026-11-02',
  items: [{ page: 1, station: 'The Grill', section: 'Breakfast', name: 'Steak & Eggs', prices: [{ price: '$9.99', calories: '860 cal' }], contains: 'Milk, Eggs, Wheat, Soy and Gluten' }] };

test('a venue links its menu board items while the dining site still lists that file', () => {
  const atriumNode = venue();
  const result = compileMenuBoard([atriumNode], [{ name: 'The Atrium', url: URL, collected_at: '2026-11-02T17:58:09Z' }], board);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.records.collected_at, '2026-11-02T17:58:09Z');
  assert.deepEqual(result.records.rows.map(row => [row.source_record_key, row.source_url, row.contains]), [['1:The Grill:Breakfast:Steak & Eggs', URL, 'Milk, Eggs, Wheat, Soy and Gluten']]);
  assert.deepEqual(atriumNode.links, [{ collection: 'menu_board_items', source_key: 'dining', source_record_keys: ['1:The Grill:Breakfast:Steak & Eggs'] }]);
});

test('a new menu file leaves the old board out and says so', () => {
  const atriumNode = venue();
  const result = compileMenuBoard([atriumNode], [{ name: 'The Atrium', url: URL.replace('2026', '2027') }], board);
  assert.deepEqual(result.records.rows, []);
  assert.deepEqual(atriumNode.links, []);
  assert.equal(result.unresolved[0].kind, 'missing_connection');
});

test('the reviewed Atrium board has one key per item, and every price is printed money', () => {
  const items = (atrium as ReviewedMenuBoard).items;
  assert.equal(new Set(items.map(menuBoardItemKey)).size, items.length);
  for (const item of items) for (const price of [...item.prices ?? [], ...(item.options ?? []).flatMap(o => [...o.prices ?? [], ...o.price ? [{ price: o.price }] : []])]) {
    assert.match(String(price.price), /^\$\d+\.\d{2}$/, `${item.name}`);
  }
});
