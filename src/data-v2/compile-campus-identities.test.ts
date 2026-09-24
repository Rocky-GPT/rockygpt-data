import assert from 'node:assert/strict';
import test from 'node:test';
import profileUrlAliases from '../reference/campus-identity-url-aliases.json';
import type { CampusIdentities } from './campus-identities';
import { catalogConvenersArtifact, compileCampusIdentities, explicitCatalogConveners, explicitCatalogProgramFaculty, facultyRecordKey, type IdentitySnapshot } from './compile-campus-identities';

const personId = '97d9efbf-6c8e-4549-8ec6-98c61e49e375';
const venueId = 'c3c6968f-407d-43f3-bab5-e06c37945991';
const programId = '4d39b206-5c1f-44be-950b-ec54dd67ca29';
const faculty = { name: 'Test Professor', school: 'School', email: 'prof@ramapo.edu', profileUrl: 'https://www.ramapo.edu/tas/faculty/test/', courses: ['CMPS 147 - Computer Science I', 'Some title with no code'], phone: '201-684-1111' };
const seed: CampusIdentities = { schema_version: 1, entities: [
  { id: personId, kind: 'person', name: 'Test Professor', aliases: [], links: [
    { collection: 'contacts', source_key: 'faculty', source_record_keys: [], selector: { field: 'faculty_identity', values: ['email:prof@ramapo.edu', 'url:https://www.ramapo.edu/tas/faculty/test'], evidence: 'Original profile and derived contact' } },
    { collection: 'faculty', source_key: 'faculty', source_record_keys: [], selector: { field: 'faculty_identity', values: ['email:prof@ramapo.edu', 'url:https://www.ramapo.edu/tas/faculty/test'], evidence: 'Original profile and unique institutional email' } },
  ] },
  { id: venueId, kind: 'venue', name: 'Birch Tree Inn', aliases: [], links: [
    { collection: 'dining_hours', source_key: 'dining', source_record_keys: [], selector: { field: 'name', values: ['Birch Tree Inn'], evidence: 'Reviewed official venue' } },
    { collection: 'menu', source_key: 'dining', source_record_keys: [], selector: { field: 'menu_venue', values: ['Birch Tree Inn'], evidence: 'Collector explicitly serves this venue' } },
  ] },
  { id: programId, kind: 'program', name: 'Computer Science BS', aliases: [], links: [
    { collection: 'programs', source_key: 'academic-programs', source_record_keys: [], selector: { field: 'catalog_code', values: ['TS-BS-CMPS'], evidence: 'Original catalog code' } },
  ] },
] };
function snapshot(): IdentitySnapshot { return {
  campus_contacts: [{ source_key: 'faculty', source_record_key: 'faculty:test-professor:school', name: 'Test Professor', email: faculty.email, phone: '201-684-9999' }],
  campus_hours: [], dining_hours: [{ source_key: 'dining', source_record_key: 'Birch Tree Inn:Monday', name: 'Birch Tree Inn', day: 'Monday', schedule: 'Lunch: 11:00am - 2:00pm' }],
  menu_items: [{ source_key: 'dining', source_record_key: '2026-09-21:Lunch:Station:Food', meal: 'Lunch', valid_from: '2026-09-21' }],
  programs: [{ source_key: 'academic-programs', source_record_key: 'School:Computer Science BS', name: 'Computer Science BS' }],
  artifacts: { faculty: [structuredClone(faculty)], courses: { 'CMPS 147': { code: 'CMPS 147', name: 'COMPUTER SCIENCE I' } }, programs: { schools: [{ school: 'School', majors: [{ name: 'Computer Science BS', catalogCode: 'TS-BS-CMPS', convener: { name: 'Wrong fallback' } }] }] } },
}; }
const raw = { scrapedAt: '2026-09-20T01:02:03Z', programs: [{ code: 'TS-BS-CMPS', customFields: { rJQmj: `<p><a href="${faculty.profileUrl}">Test Professor</a></p>`, xiQxl: '<p>Wrong fallback</p>' } }] };

test('compiled source links and evidence retain originals and preserve field conflicts', () => {
  const input = snapshot(); const before = structuredClone(input);
  const result = compileCampusIdentities(seed, input, raw);
  assert.deepEqual(input, before);
  assert.equal(result.registry.entities[0].id, personId);
  assert.equal(result.report.linked_records.contacts, 1);
  assert.equal(result.report.relationships.convener, 1);
  assert.equal(result.report.relationships.profile_course, 1);
  assert.equal(result.registry.entities[0].relationships?.[0].type, 'profile_course');
  assert.equal('selector' in result.registry.entities[0].links[0], false);
  assert.ok(result.report.unresolved.some(r => r.reason.includes('no explicit catalog code')));
  // Both reviewed person fields are kept verbatim so every relationship can be rechecked.
  assert.deepEqual(catalogConvenersArtifact(raw), { collected_at: raw.scrapedAt, source_url: 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos/programs/search/%24filters', programs: [{ catalogCode: 'TS-BS-CMPS', catalogUrl: 'https://catalog.ramapo.edu/programs/TS-BS-CMPS', customFields: { rJQmj: raw.programs[0].customFields.rJQmj, xiQxl: raw.programs[0].customFields.xiQxl } }] });
  assert.deepEqual(catalogConvenersArtifact({ programs: [{ code: 'X', customFields: { other: '<p>x</p>' } }] }).programs, []);
});

test('refresh resolves renamed contacts/profiles and newly ingested meals/exceptions without changing identity', () => {
  const input = snapshot();
  const renamed = input.artifacts.faculty as typeof faculty[];
  renamed[0].name = 'Renamed Professor'; renamed[0].profileUrl = 'https://www.ramapo.edu/new/faculty/renamed/';
  input.campus_contacts[0].name = 'Renamed Professor'; input.campus_contacts[0].source_record_key = 'faculty:renamed-professor:school';
  input.menu_items = [{ source_key: 'dining', source_record_key: '2026-09-22:Dinner:Station:New Food' }];
  input.dining_hours.push({ source_key: 'dining', source_record_key: 'Birch Tree Inn:Monday:2026-09-21:2026-09-22', name: 'Birch Tree Inn', schedule: 'Closed', valid_from: '2026-09-21', valid_until: '2026-09-22' });
  const result = compileCampusIdentities(seed, input);
  assert.equal(result.registry.entities[0].id, personId);
  assert.ok(result.registry.entities[0].aliases.includes('Renamed Professor'));
  assert.equal(result.registry.entities[0].links[0].source_record_keys[0], 'faculty:renamed-professor:school');
  assert.deepEqual(result.registry.entities[1].links.find(l => l.collection === 'menu')?.source_record_keys, ['2026-09-22:Dinner:Station:New Food']);
  assert.equal(result.registry.entities[1].links[0].source_record_keys.length, 2);
});

test('unknown/missing sections and broken keys are reported without discarding available sections', () => {
  const input = snapshot(); input.dining_hours = [];
  const map = structuredClone(seed);
  map.entities[0].links.push({ collection: 'campus_hours', source_key: 'campus-hours', source_record_keys: ['Missing Office:Monday'] });
  const result = compileCampusIdentities(map, input);
  assert.equal(result.registry.entities[0].links.length, 2);
  assert.equal(result.registry.entities[1].links[0].collection, 'menu');
  assert.ok(result.report.unresolved.some(r => r.entity === 'Birch Tree Inn' && r.collection === 'dining_hours'));
});

test('shared aliases are not merged; reused email or shared faculty directory URL does not cross-link people', () => {
  const input = snapshot();
  (input.artifacts.faculty as typeof faculty[]).push({ ...faculty, name: 'Different Person' });
  input.campus_contacts.push({ ...input.campus_contacts[0], name: 'Different Person', source_record_key: 'faculty:different-person:school' });
  const result = compileCampusIdentities(seed, input, raw);
  assert.equal(result.registry.entities.some(e => e.id === personId), false);
  assert.equal(result.report.relationships.convener, undefined);
  assert.notEqual(facultyRecordKey({ ...faculty, email: 'one@ramapo.edu' }), facultyRecordKey({ ...faculty, email: 'two@ramapo.edu' }));
});

test('repeated compilation is deterministic and does not append duplicate links', () => {
  const first = compileCampusIdentities(seed, snapshot(), raw);
  const second = compileCampusIdentities(seed, snapshot(), raw);
  assert.deepEqual(second, first);
});

test('convener is only established by the reviewed explicit field, never first faculty or lone link elsewhere', () => {
  assert.equal(explicitCatalogConveners({ programs: [{ code: 'P', customFields: { xiQxl: raw.programs[0].customFields.rJQmj } }] }).size, 0);
  const result = compileCampusIdentities(seed, snapshot(), { programs: [] });
  assert.equal(result.report.relationships.convener, undefined);
  assert.ok(result.report.unresolved.some(r => r.reason.includes('first-faculty fallback')));
});

test('listed faculty come only from the explicit Program Faculty field, through reviewed redirects', () => {
  const [redirect] = profileUrlAliases.aliases;
  const input = snapshot();
  (input.artifacts.faculty as typeof faculty[])[0].profileUrl = `${redirect.to}/`;
  const listing = { programs: [{ code: 'TS-BS-CMPS', customFields: { xiQxl: [
    `<p><a href="${redirect.from}">Old profile URL</a></p>`, `<p><a href="${redirect.to}/">Current profile URL</a></p>`,
    '<p><a href="https://www.ramapo.edu/tas/faculty/nobody">Nobody</a></p>', '<p><a href="https://www.ramapo.edu/majors/">Not a profile</a></p>',
  ].join('') } }] };
  const result = compileCampusIdentities(seed, input, listing);
  // Two URLs for one person are one listing, and a listing never makes a convener.
  assert.deepEqual(result.registry.entities.find(e => e.id === programId)?.relationships, [{ type: 'listed_faculty', target_entity_id: personId, evidence: [
    { collection: 'programs', source_key: 'academic-programs', source_record_key: 'School:Computer Science BS', field: 'customFields.xiQxl', source_url: 'https://catalog.ramapo.edu/programs/TS-BS-CMPS' },
  ] }]);
  assert.equal(result.report.relationships.convener, undefined);
  assert.ok(result.report.unresolved.some(r => r.reason === 'Explicit Program Faculty profile URL https://www.ramapo.edu/tas/faculty/nobody resolves to 0 person identities.'));
});

test('a convener field or the published faculty array never creates a listing', () => {
  const input = snapshot();
  const program = (input.artifacts.programs as { schools: { majors: Record<string, unknown>[] }[] }).schools[0].majors[0];
  program.faculty = [{ name: faculty.name, email: faculty.email, profileUrl: faculty.profileUrl }];
  const result = compileCampusIdentities(seed, input, raw);
  assert.equal(result.report.relationships.convener, 1);
  assert.equal(result.report.relationships.listed_faculty, undefined);
  assert.ok(result.report.unresolved.some(r => r.reason === 'No explicit catalog Program Faculty-field profile link.'));
  assert.equal(explicitCatalogProgramFaculty({ programs: [{ code: 'P', customFields: { rJQmj: raw.programs[0].customFields.rJQmj } }] }).size, 0);
});

test('the committed campus map adds room-prefix buildings and office locations to the registry', () => {
  const input = snapshot();
  input.campus_contacts[0].office = 'ASB-409';
  const campusMap = { source: 'https://api.concept3d.com/locations?map=2292', generatedAt: '2026-08-27T16:58:11.587Z', buildings: [
    { name: 'Anisfield School of Business (ASB)', category: 'Academic Buildings', mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1133424?sbc/', aliases: ['asb'], roomPrefixes: ['ASB'] },
  ] };
  const result = compileCampusIdentities(seed, input, raw, { campusMap });
  const building = result.registry.entities.find(e => e.kind === 'building');
  assert.equal(building?.name, 'Anisfield School of Business (ASB)');
  assert.deepEqual(result.registry.entities.find(e => e.id === personId)?.relationships?.filter(r => r.type === 'office_at'), [
    { type: 'office_at', target_entity_id: building?.id, evidence: [{ collection: 'contacts', source_key: 'faculty', source_record_key: 'faculty:test-professor:school', field: 'office' }] },
  ]);
  assert.equal(result.report.identities_by_kind.building, 1);
  assert.equal(result.report.relationships.office_at, 1);
  assert.equal(result.campusBuildings.buildings[0].concept3d_id, '1133424');
  // Without the map there are no buildings, and nothing else changes.
  const without = compileCampusIdentities(seed, snapshot(), raw);
  assert.equal(without.registry.entities.some(e => e.kind === 'building'), false);
  assert.deepEqual(without.campusBuildings.buildings, []);
});

test('the coverage report traces every alias to the rule and evidence that put it there', () => {
  const reviewed = structuredClone(seed);
  reviewed.entities[2].aliases = ['CS'];
  const input = snapshot();
  input.campus_contacts[0].name = 'Dr. Test Professor';
  const campusMap = { source: 'https://api.concept3d.com/locations?map=2292', generatedAt: '2026-08-27T16:58:11.587Z', buildings: [
    { name: 'Student Center (SC)', category: 'Buildings', mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1133351?sbc/', roomPrefixes: ['SC'] },
  ] };
  const identityReviews = { aliases: [{ entity_id: venueId, entity: 'Birch Tree Inn', alias: 'Birch', reviewed_at: '2026-09-23', note: 'Approved.' }] };
  const { registry, report } = compileCampusIdentities(reviewed, input, raw, { campusMap, identityReviews });
  assert.equal(report.alias_sources.length, registry.entities.reduce((total, entity) => total + entity.aliases.length, 0));
  assert.deepEqual(report.alias_sources.map(r => [r.kind, r.entity, r.alias, r.sources]), [
    ['person', 'Test Professor', 'Dr. Test Professor', [{ basis: 'record_name', evidence: { collection: 'contacts', source_key: 'faculty', source_record_key: 'faculty:test-professor:school', field: 'name' } }]],
    ['venue', 'Birch Tree Inn', 'Birch', [{ basis: 'human_reviewed', reviewed_at: '2026-09-23', note: 'Approved.' }]],
    ['program', 'Computer Science BS', 'CS', [{ basis: 'identity_map' }]],
    ['program', 'Computer Science BS', 'Computer Science', [{ basis: 'program_family' }]],
    ['building', 'Student Center (SC)', 'SC', [{ basis: 'abbreviation' }]],
    ['building', 'Student Center (SC)', 'Student Center', [{ basis: 'abbreviation' }]],
  ]);
});

test('distinct catalog programs with colliding original record keys remain unresolved', () => {
  const input = snapshot();
  (input.artifacts.programs as { schools: { majors: Record<string, unknown>[] }[] }).schools[0].majors.push({ name: 'Computer Science BS', catalogCode: 'OTHER' });
  const result = compileCampusIdentities(seed, input, raw);
  assert.equal(result.registry.entities.some(e => e.id === programId), false);
  assert.ok(result.report.unresolved.some(r => r.collection === 'programs'));
});

test('disagreeing independent anchors cannot silently merge a reassigned email with its previous owner', () => {
  const input = snapshot();
  const people = input.artifacts.faculty as typeof faculty[];
  people[0].email = 'changed@ramapo.edu';
  people.push({ ...faculty, name: 'New Account Owner', profileUrl: 'https://www.ramapo.edu/new/faculty/different/' });
  input.campus_contacts[0].email = 'changed@ramapo.edu';
  input.campus_contacts.push({ source_key: 'faculty', source_record_key: 'faculty:new-account-owner:school', email: faculty.email, name: 'New Account Owner' });
  const result = compileCampusIdentities(seed, input);
  assert.equal(result.registry.entities.some(e => e.id === personId), false);
  assert.ok(result.report.unresolved.some(r => r.reason.includes('multiple distinct subjects')));
});

test('a program links every graduation plan the plan index names by its catalog code', () => {
  const graduationPlans = { plans: [
    { id: 'plan-2026', programCodes: ['TS-BS-CMPS'], limitations: [] },
    { id: 'plan-2025', programCodes: ['TS-BS-CMPS'], limitations: [] },
    { id: 'retired-major', programCodes: ['TS-BS-GONE'], limitations: [] },
    { id: 'no-code', programCodes: [], limitations: ['The index gives this plan no program code, so it is not linked to a catalog program.'] },
  ] };
  const result = compileCampusIdentities(seed, snapshot(), raw, { graduationPlans });
  const program = result.registry.entities.find(entity => entity.id === programId)!;
  assert.deepEqual(program.links.find(link => link.collection === 'graduation_plans'),
    { collection: 'graduation_plans', source_key: 'graduation-plans', source_record_keys: ['plan-2025', 'plan-2026'] });
  const unlinked = new Map(result.report.unresolved.filter(issue => issue.collection === 'graduation_plans').map(issue => [issue.record, issue.reason]));
  assert.deepEqual([...unlinked.keys()].sort(), ['no-code', 'retired-major']);
  assert.match(unlinked.get('retired-major')!, /TS-BS-GONE/);
  assert.match(unlinked.get('no-code')!, /no program code/);
  // Without plans, and for the release's own plans artifact, nothing else changes.
  assert.equal(compileCampusIdentities(seed, snapshot(), raw).registry.entities.find(entity => entity.id === programId)!
    .links.some(link => link.collection === 'graduation_plans'), false);
  const own = snapshot(); own.artifacts['graduation-plans'] = graduationPlans;
  assert.ok(compileCampusIdentities(seed, own, raw).registry.entities.find(entity => entity.id === programId)!
    .links.some(link => link.collection === 'graduation_plans'));
  assert.throws(() => compileCampusIdentities(seed, snapshot(), raw, { graduationPlans: { plans: [{ programCodes: [] }] } }), /no ID or program links/);
});
