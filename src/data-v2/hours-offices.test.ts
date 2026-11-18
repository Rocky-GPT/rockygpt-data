import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { hoursOfficeId, hoursOfficeName, linkHoursOffices } from './hours-offices';

// Audit 2026-11-17, cause 5: offices renamed on Archway lost their hours, because office names
// came only from reviewed lists and the club list. Hours no node holds take their page's name.
const row = (key: string, name: string) => ({ source_key: 'campus-hours', source_record_key: key, name, source_url: 'https://www.ramapo.edu/veterans/' });
const desk = (id: string, name: string, aliases: string[] = []): CampusIdentity =>
  ({ id, kind: 'office', name, aliases, links: [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: [`office:${id}`] }] });

test('a schedule names its office without its season', () => {
  assert.equal(hoursOfficeName('Office of Access, Belonging and Community (Summer)'), 'Office of Access, Belonging and Community');
  assert.equal(hoursOfficeName('Veterans Lounge'), 'Veterans Lounge');
});

test('hours no node holds make one office node of their page name, with every season of it', () => {
  const entities: CampusIdentity[] = [];
  const unresolved: IdentityCoverageIssue[] = [{ collection: 'campus_hours', record: 'veterans-lounge', reason: 'x', kind: 'unlinked_record' }];
  const count = linkHoursOffices(entities, [row('veterans-lounge', 'Veterans Lounge'), row('veterans-lounge-summer', 'Veterans Lounge (Summer)')], unresolved);
  assert.deepEqual(count, { created: 1, joined: 0 });
  assert.deepEqual(entities, [{ id: hoursOfficeId('Veterans Lounge'), kind: 'office', name: 'Veterans Lounge', aliases: [],
    links: [{ collection: 'campus_hours', source_key: 'campus-hours', source_record_keys: ['veterans-lounge', 'veterans-lounge-summer'] }] }]);
  assert.deepEqual(unresolved, []);
  // The node keeps its ID from one release to the next.
  assert.equal(hoursOfficeId('veterans  lounge'), hoursOfficeId('Veterans Lounge'));
});

test('they join the one desk already named so, and a name two desks share is reported, not guessed', () => {
  const entities = [desk('a', 'Multicultural Center', ['The Multicultural Center'])];
  assert.deepEqual(linkHoursOffices(entities, [row('mc', 'The Multicultural Center')], []), { created: 0, joined: 1 });
  assert.deepEqual(entities[0].links[1], { collection: 'campus_hours', source_key: 'campus-hours', source_record_keys: ['mc'] });

  const twice = [desk('a', 'Testing Center'), desk('b', 'Testing Center')];
  const unresolved: IdentityCoverageIssue[] = [];
  assert.deepEqual(linkHoursOffices(twice, [row('tc', 'Testing Center')], unresolved), { created: 0, joined: 0 });
  assert.equal(unresolved[0].kind, 'missing_connection');
  assert.ok(twice.every((entity) => entity.links.length === 1));
});

test('hours a node already holds are left where they are', () => {
  const holder: CampusIdentity = { ...desk('a', 'Library'), links: [{ collection: 'campus_hours', source_key: 'campus-hours', source_record_keys: ['lib'] }] };
  const entities = [holder];
  assert.deepEqual(linkHoursOffices(entities, [row('lib', 'Veterans Lounge')], []), { created: 0, joined: 0 });
  assert.equal(entities.length, 1);
});
