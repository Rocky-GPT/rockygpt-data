import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogDepartments, catalogPageData, catalogSettings } from './catalog-page-settings';

/** A page whose embedded data is the given table, as the catalog serializes it. */
const page = (table: unknown[]) => `<html><body><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(table)}</script></body></html>`;

test('page data revives shared references, wrappers and constants from one table', () => {
  const data = catalogPageData(page([{ shared: 1, again: 1, wrapped: 3, missing: -1 }, { name: 2 }, 'value', ['ShallowReactive', 4], [1, 2]])) as Record<string, any>;
  assert.equal(data.shared, data.again);
  assert.equal(data.shared.name, 'value');
  assert.deepEqual(data.wrapped, [{ name: 'value' }, 'value']);
  assert.equal(data.missing, undefined);
  assert.throws(() => catalogPageData('<html></html>'), /no embedded page data/);
});

/** The catalog's serialized form of a plain value: each value is an index into one table. */
function serialize(value: unknown): unknown[] {
  const table: unknown[] = [];
  const add = (item: unknown): number => {
    const index = table.push(null) - 1;
    table[index] = Array.isArray(item) ? item.map(add)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, add(child)])) : item;
    return index;
  };
  add(value);
  return table;
}

test('layouts list each tab with its fields under the catalog labels, and departments by ID', () => {
  const question = (id: string) => ({ type: 'question', id });
  const card = (title: string, ...ids: string[]) => ({ type: 'card', config: { title }, children: [{ type: 'row', children: ids.map(question) }] });
  const html = page(serialize({ pinia: { settings: {
    programPageTemplate: { questions: { o01gn: { label: 'Learning Goals and Outcomes' }, career: { label: 'Program Level' } },
      template: [card('Description and Outcomes', 'o01gn', 'career'), card('Unlabelled', 'tiLLp'), { type: 'card', config: { title: 'Empty' }, children: [] }] },
    coursePageTemplate: { questions: { description: { label: 'Course Description' } }, template: [card('Description and Details', 'description')] },
  } }, departments: [
    { id: 'dept-cmps', displayName: 'Computer Science (CMPS)', customFields: { educationInstitutionUnitType: 'department' } },
    { id: 'person', displayName: 'Not a department' },
  ] }));
  const settings = catalogSettings(html);
  assert.deepEqual(settings.program.tabs, [
    { title: 'Description and Outcomes', fields: [{ key: 'o01gn', label: 'Learning Goals and Outcomes' }, { key: 'career', label: 'Program Level' }] },
    // A field without a label keeps its key, so a capture can tell it is unlabelled.
    { title: 'Unlabelled', fields: [{ key: 'tiLLp', label: 'tiLLp' }] },
  ]);
  assert.deepEqual(settings.course.tabs, [{ title: 'Description and Details', fields: [{ key: 'description', label: 'Course Description' }] }]);
  assert.deepEqual(catalogDepartments(html), [{ id: 'dept-cmps', name: 'Computer Science (CMPS)' }]);
  assert.throws(() => catalogSettings(page(serialize({ pinia: { settings: {} } }))), /layout lists no fields/);
});
