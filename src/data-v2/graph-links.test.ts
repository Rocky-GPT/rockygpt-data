import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { compileStops, linkDirectoryPeople, linkHoursDesks, linkReviewedListings, linkRouteOffice, linkTopicOffices, markUnlinked, stopIdentityId, type ReviewedListings } from './graph-links';
import { aliasRecords, type AliasLedger } from './identity-aliases';

const node = (n: number, kind: CampusIdentity['kind'], name: string, links: CampusIdentity['links'] = []): CampusIdentity =>
  ({ id: `00000000-0000-4000-8000-00000000030${n}`, kind, name, aliases: [], links });

test('a topic is handled_by each office its row names exactly', () => {
  const aid = node(1, 'office', 'Financial Aid');
  const accounts = node(2, 'office', 'Student Accounts');
  const topic = node(3, 'topic', 'Scholarships', [{ collection: 'campus_topics', source_key: 'office-pages', source_record_keys: ['Scholarships'] }]);
  linkTopicOffices([aid, accounts, topic], [{ source_key: 'office-pages', source_record_key: 'Scholarships', url: 'https://www.ramapo.edu/scholarships/faqs/', handled_by: ['Student Accounts', 'Financial Aid', 'Nobody'] }]);
  assert.deepEqual(topic.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['handled_by', accounts.id], ['handled_by', aid.id]]);
});

test('routes stop at shared stop nodes, and a campus stop is in the building it names', () => {
  const map = { buildings: [{ key: 'building_bradley', name: 'Bill Bradley Sports and Recreation Center', aliases: ['bradley center', 'gym'], mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1133348?sbc/', roomPrefixes: ['BR'] }] };
  const artifact = campusBuildingsArtifact(map);
  const bradley = node(9, 'building', 'Bill Bradley Sports and Recreation Center');
  bradley.id = campusBuildingId(artifact.buildings[0]);
  const route = (n: number, name: string) => node(n, 'route', name, [{ collection: 'shuttle_stops', source_key: 'transportation', source_record_keys: [`${name}:stop:Ramapo College (Bradley Center)`, `${name}:stop:Garden State Plaza`] }]);
  const sunday = route(1, 'Sunday'); const saturday = route(2, 'Saturday');
  const rows = ['Sunday', 'Saturday'].flatMap(r => [
    { source_key: 'transportation', source_record_key: `${r}:stop:Ramapo College (Bradley Center)`, name: 'Ramapo College (Bradley Center)', label: 'Ramapo College' },
    { source_key: 'transportation', source_record_key: `${r}:stop:Garden State Plaza`, name: 'Garden State Plaza', pickup: 'the Bus Shelters' }]);
  const result = compileStops([bradley, sunday, saturday], rows, artifact, map);
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name]), [
    [stopIdentityId('Ramapo College (Bradley Center)'), 'stop', 'Ramapo College (Bradley Center)'], [stopIdentityId('Garden State Plaza'), 'stop', 'Garden State Plaza']]);
  for (const r of [sunday, saturday]) assert.deepEqual(r.relationships?.map(x => x.type), ['stops_at', 'stops_at']);
  assert.deepEqual(result.entities[0].relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : null), [bradley.id]);
  assert.equal(result.entities[1].relationships, undefined);
  assert.deepEqual(result.records.rows.map(r => [r.source_record_key, r.pickup]), [['Ramapo College (Bradley Center)', null], ['Garden State Plaza', 'the Bus Shelters']]);
});

test('a stop label is an alias with its source noted, so the alias report can trace it', () => {
  const route = node(1, 'route', 'Sunday', [{ collection: 'shuttle_stops', source_key: 'transportation', source_record_keys: ['Sunday:stop:City MD Ramsey'] }]);
  const ledger: AliasLedger = new Map();
  const result = compileStops([route], [{ source_key: 'transportation', source_record_key: 'Sunday:stop:City MD Ramsey', name: 'City MD Ramsey', label: 'CityMD Ramsey Urgent Care' }],
    campusBuildingsArtifact({ buildings: [] }), { buildings: [] }, '', ledger);
  assert.deepEqual(result.entities[0].aliases, ['CityMD Ramsey Urgent Care']);
  assert.deepEqual(aliasRecords(result.entities, ledger)[0].sources, [{ basis: 'record_name', evidence: { collection: 'shuttle_stops', source_key: 'transportation',
    source_record_key: 'Sunday:stop:City MD Ramsey', field: 'label', source_url: 'https://www.ramapo.edu/about/transportation-services/ramapo-roadrunner-express-shuttle/' } }]);
});

test('a topic is handled_by a student group with its own desk, which is still a club when topics link', () => {
  const news = node(1, 'organization', 'Ramapo News');
  const topic = node(3, 'topic', 'Student Media', [{ collection: 'campus_topics', source_key: 'office-pages', source_record_keys: ['Student Media'] }]);
  linkTopicOffices([news, topic], [{ source_key: 'office-pages', source_record_key: 'Student Media', url: 'https://www.ramapo.edu/student-media/', handled_by: ['Ramapo News'] }]);
  assert.deepEqual(topic.relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : null), [news.id]);
});

const sitePages = (keys: string[]): CampusIdentity['links'] => [{ collection: 'office_sections', source_key: 'office-pages', source_record_keys: keys }];
const targets = (entity: CampusIdentity) => (entity.relationships ?? []).map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]);

test('a desk known only by one office\'s hours page is listed_by that office', () => {
  const library = node(1, 'office', 'Library', sitePages(['www.ramapo.edu/library/library-hours/']));
  const hoursOnly = (n: number, name: string) => node(n, 'office', name, [{ collection: 'campus_hours', source_key: 'campus-hours', source_record_keys: [`${name}:Monday`] }]);
  const lab = hoursOnly(2, 'Game Lab'); const admin = hoursOnly(3, 'Administrative Offices');
  const withContact = hoursOnly(4, 'Bookstore'); withContact.links.push({ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:bookstore'] });
  const hours = [
    { source_key: 'campus-hours', source_record_key: 'Game Lab:Monday', source_url: 'https://www.ramapo.edu/library/library-hours/' },
    { source_key: 'campus-hours', source_record_key: 'Administrative Offices:Monday', source_url: 'https://www.ramapo.edu/about/campus-hours/' },
    { source_key: 'campus-hours', source_record_key: 'Bookstore:Monday', source_url: 'https://www.ramapo.edu/library/library-hours/' }];
  assert.equal(linkHoursDesks([library, lab, admin, withContact], hours), 1);
  assert.deepEqual(targets(lab), [['listed_by', library.id]]);
  assert.deepEqual(targets(admin), []);
  assert.deepEqual(targets(withContact), []);
});

test('a directory person filed under an office is listed_by it; faculty rows and unknown offices are left alone', () => {
  const president = node(1, 'organization', 'Office of the President');
  const person = (n: number, key: string) => node(n, 'person', key, [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: [key] }]);
  const jebb = person(2, 'other:cindy-r-jebb-ph-d'); const prof = person(3, 'faculty:a-b:office-of-the-president'); const nobody = person(4, 'other:x');
  const rows = [
    { source_key: 'campus-directory', source_record_key: 'other:cindy-r-jebb-ph-d', department: 'Office of the President', normalization_metadata: { evidence: { source_urls: ['https://www.ramapo.edu/college-leadership/'] } } },
    { source_key: 'campus-directory', source_record_key: 'faculty:a-b:office-of-the-president', department: 'Office of the President' },
    { source_key: 'campus-directory', source_record_key: 'other:x', department: 'Office of Nothing' }];
  assert.equal(linkDirectoryPeople([president, jebb, prof, nobody], rows), 1);
  assert.deepEqual(targets(jebb), [['listed_by', president.id]]);
  assert.equal(jebb.relationships?.[0].evidence[0].source_url, 'https://www.ramapo.edu/college-leadership/');
  assert.deepEqual(targets(prof), []);
});

test('each shuttle route is listed_by the office whose pages publish its timetable', () => {
  const transport = node(1, 'office', 'Transportation Services', sitePages(['www.ramapo.edu/about/transportation-services/ramapo-roadrunner-express-shuttle/']));
  const route = node(2, 'route', 'Sunday Roadrunner Express', [{ collection: 'shuttle_trips', source_key: 'transportation', source_record_keys: ['Sunday Roadrunner Express:0:10:00 AM'] }]);
  assert.equal(linkRouteOffice([transport, route]), 1);
  assert.deepEqual(targets(route), [['listed_by', transport.id]]);
});

test('a reviewed listing links only while its page section still says the reviewed words', () => {
  const csw = node(1, 'office', 'Center for Student Wellness'); const counseling = node(2, 'office', 'Counseling Center'); const health = node(3, 'office', 'Health Services');
  const reviewed: ReviewedListings = { schema_version: 1, listings: [
    { node: 'Counseling Center', listed_by: 'Center for Student Wellness', url: 'https://www.ramapo.edu/csw/', section: 'Counseling Services', quote: 'Location: Building D, room D-216', reviewed_at: '2026-11-02', note: '' },
    { node: 'Health Services', listed_by: 'Center for Student Wellness', url: 'https://www.ramapo.edu/csw/', section: 'Health', quote: 'near the South Gate', reviewed_at: '2026-11-02', note: '' }] };
  const pages = [{ source_key: 'office-pages', source_record_key: 'www.ramapo.edu/csw/', sections: [
    { heading: 'Counseling Services', text: 'Location:  Building D, room D-216 (entrance behind stairwell on left)' },
    { heading: 'Health', text: 'Location: Building E' }] }];
  const result = linkReviewedListings([csw, counseling, health], pages, reviewed);
  assert.equal(result.linked, 1);
  assert.deepEqual(targets(counseling), [['listed_by', csw.id]]);
  assert.deepEqual(targets(health), []);
  assert.equal(result.unresolved.length, 1);
});

test('every node with no link in or out carries a note on why, and on purpose when it should stay alone', () => {
  const office = node(1, 'office', 'ResNET'); const lab = node(2, 'office', 'Game Lab'); const library = node(3, 'office', 'Library');
  const field = node(4, 'building', 'Softball Field'); const program = node(5, 'program', 'NMG-Non-Degree-MAPP');
  const ended = node(6, 'topic', 'Provisional Teacher Program', [{ collection: 'campus_topics', source_key: 'office-pages', source_record_keys: ['Provisional Teacher Program'] }]);
  const course = node(7, 'course', 'DATA 450', [{ collection: 'courses', source_key: 'catalog', source_record_keys: ['DATA 450'] }]);
  const teacher = node(8, 'person', 'A Teacher');
  lab.relationships = [{ type: 'listed_by', target_entity_id: library.id, evidence: [{ collection: 'campus_hours', source_key: 'campus-hours', source_record_key: 'Game Lab:Monday', field: 'source_url' }] }];
  teacher.relationships = [{ type: 'profile_course', target_record: { collection: 'courses', source_key: 'catalog', source_record_key: 'DATA 450' }, evidence: [{ collection: 'faculty', source_key: 'faculty', source_record_key: 'x', field: 'courses' }] }];
  library.unlinked = { reason: 'stale', on_purpose: false };
  const count = markUnlinked([office, lab, library, field, program, ended, course, teacher],
    [{ source_key: 'office-pages', source_record_key: 'Provisional Teacher Program', status: 'retired' }],
    { schema_version: 1, nodes: [{ kind: 'program', name: 'NMG-Non-Degree-MAPP', reason: 'A catalog placeholder.', reviewed_at: '2026-11-03', note: '' }] });
  assert.deepEqual(count, { total: 4, on_purpose: 2 });
  assert.equal(office.unlinked?.on_purpose, false); assert.match(office.unlinked?.reason ?? '', /No room or building/);
  assert.match(field.unlinked?.reason ?? '', /campus map/);
  assert.deepEqual(program.unlinked, { reason: 'A catalog placeholder.', on_purpose: true });
  assert.equal(ended.unlinked?.on_purpose, true);
  for (const linked of [lab, library, course, teacher]) assert.equal(linked.unlinked, undefined);
});
