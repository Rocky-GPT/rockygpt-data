import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateCurrentDatasetV2 } from './validate';

// Thanksgiving 2026: the menu service published no menu for the day, so today's menu file was an
// empty list, and the whole publish stopped on "menu.json has 0 (minimum 1)" two runs in a row.
function datasetWithTodaysMenu(menu: unknown): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-closed-day-'));
  fs.mkdirSync(path.join(cwd, 'data/normalized'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'data/normalized/menu.json'), JSON.stringify(menu));
  return cwd;
}

const menuErrors = (cwd: string) => validateCurrentDatasetV2({ cwd, now: new Date('2026-11-26T04:00:00Z') })
  .errors.filter((error) => error.includes('data/normalized/menu.json'));

test('a day with no published menu does not stop the publish', () => {
  assert.deepEqual(menuErrors(datasetWithTodaysMenu([])), []);
});

test('a menu that is there but unreadable still stops it', () => {
  assert.ok(menuErrors(datasetWithTodaysMenu([{ name: 'Lunch', groups: [] }])).length > 0);
  assert.ok(menuErrors(datasetWithTodaysMenu({ not: 'a list' })).length > 0);
});
