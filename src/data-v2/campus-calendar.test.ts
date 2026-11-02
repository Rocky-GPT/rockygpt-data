import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCampusIdentities } from './campus-identities';
import { calendarDateIdentityId, compileCalendarIdentities, termIdentityId } from './campus-calendar';

const CURRENT = 'https://www.ramapo.edu/academic-calendars/';
const FUTURE = 'https://www.ramapo.edu/academic-calendars/future-calendars/';
const calendar = [
  { name: 'Fall 2026', sourceUrl: CURRENT, events: [
    { date: 'Nov. 25', title: 'Thanksgiving Break (No Classes)', description: '12:00 am - 11:59 pm' },
    { date: 'Dec. 17', title: 'First Day of Winter Classes', description: '12:00 am - 11:59 pm' },
  ] },
  { name: 'Winter 2027', sourceUrl: FUTURE, events: [
    { date: 'Dec. 17', title: 'First Day of Winter Classes', description: '12:00 am - 11:59 pm' },
    { date: 'Jan. 13', title: 'Finals and the Last Day of Winter Semester', description: '12:00 am - 11:59 pm' },
  ] },
  { name: 'Board Notes', events: [{ date: 'Jan. 01', title: 'Something' }] },
];

test('each term and each dated entry is a node, and a date links every term that lists it', () => {
  const graph = compileCalendarIdentities(calendar, '2026-11-02T10:00:00.000Z');
  const byName = new Map(graph.entities.map(entity => [entity.name, entity]));
  assert.deepEqual(graph.entities.filter(e => e.kind === 'term').map(e => e.name), ['Fall 2026', 'Winter 2027']);
  // Listed under both terms: one node, two in_term links, and dated 2026 (it was dated 2027).
  const winterStart = byName.get('First Day of Winter Classes (Dec 17, 2026)');
  assert.ok(winterStart);
  assert.equal(winterStart.id, calendarDateIdentityId('2026-12-17:First Day of Winter Classes'));
  assert.deepEqual(winterStart.relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : ''),
    [termIdentityId('fall-2026'), termIdentityId('winter-2027')]);
  assert.deepEqual(winterStart.relationships?.map(r => r.evidence[0].source_url), [CURRENT, FUTURE]);
  const row = graph.dates.rows.find(r => r.source_record_key === '2026-12-17:First Day of Winter Classes');
  assert.equal(row?.kind, 'classes_begin');
  assert.deepEqual(row?.terms, ['Fall 2026', 'Winter 2027']);
  assert.equal(graph.dates.collected_at, '2026-11-02T10:00:00.000Z');
  assert.equal(graph.terms.rows.find(r => r.source_record_key === 'winter-2027')?.source_url, FUTURE);
  // A section that is not a term is reported, never guessed into one.
  assert.equal(graph.unresolved.length, 1);
  validateCampusIdentities({ schema_version: 1, entities: graph.entities });
});

test('ids are stable across runs', () => {
  assert.deepEqual(compileCalendarIdentities(calendar).entities.map(e => e.id),
    compileCalendarIdentities(calendar).entities.map(e => e.id));
  assert.equal(termIdentityId('fall-2026'), termIdentityId('fall-2026'));
});
