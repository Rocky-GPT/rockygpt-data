import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileRepositoryV2 } from './file-repository';
import { calendarConcept } from '../calendar-concepts';

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
          title: `Session I - Last Day to Add/Drop (${index + 1})`,
        })),
      },
    ])
  );
  return new FileRepositoryV2(root);
}

test('calendar search returns every match for the brain to filter and order', async (t) => {
  const found = await fixture(t).findAcademicDates('add drop');
  assert.equal(found.length, 7);
  assert.deepEqual(
    {
      family: found[0].family,
      kind: found[0].kind,
      termId: found[0].termId,
      sessionId: found[0].sessionId,
      startsAt: found[0].startsAt,
    },
    {
      family: 'registration',
      kind: 'add_drop_deadline',
      termId: 'fall-2031',
      sessionId: 'session-i',
      startsAt: '2031-09-01T04:00:00.000Z',
    }
  );
});

test('calendar concepts distinguish source wording from stable domain kinds', () => {
  assert.deepEqual(
    calendarConcept('Fall 2031', {
      date: 'Sep. 1',
      title: 'Full Semester Courses - Last Day to Add/Drop for 100% Tuition Refund',
      description: '12:00 am - 11:59 pm',
    }),
    {
      family: 'registration',
      kind: 'add_drop_deadline',
      termId: 'fall-2031',
      session: 'Full Semester',
      sessionId: 'full-semester',
      startsAt: '2031-09-01T04:00:00.000Z',
    }
  );
});
