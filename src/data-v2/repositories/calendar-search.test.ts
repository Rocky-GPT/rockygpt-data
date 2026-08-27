import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileRepositoryV2 } from './file-repository';

function fixture(t: test.TestContext): FileRepositoryV2 {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-calendar-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data/normalized'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data/normalized/calendar.json'),
    JSON.stringify([
      {
        name: 'Fall 2031',
        events: Array.from({ length: 7 }, (_, index) => ({
          date: `Sep. ${index + 1}`,
          title: `Session ${index + 1} - Last Day to Add/Drop`,
        })),
      },
    ])
  );
  return new FileRepositoryV2(root);
}

test('calendar search returns every match for the brain to filter and order', async (t) => {
  const found = await fixture(t).findAcademicDates('add drop');
  assert.equal(found.length, 7);
});
