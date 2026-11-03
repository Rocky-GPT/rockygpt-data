import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities, type CampusIdentity, type IdentityEvidence } from './campus-identities';
import { buildingIdentityId, campusBuildingsArtifact, compileBuildingIdentities } from './campus-buildings';
import { staffSpansInSection } from './office-staff';
import { convenedFields, linkPeople, roomAfterAddress, roomsBesideName, titleFields, type ReviewedPersonRooms } from './person-links';

const building = (name: string, id: string, roomPrefixes: string[]) => ({
  key: `building_${name}`, name, category: 'Academic Buildings', aliases: [], roomPrefixes, mapUrl: `https://map.ramapo.edu/?id=2292#!m/${id}?sbc/`,
});
const buildings = campusBuildingsArtifact({ buildings: [
  building('Academic Building C', '1133370', ['C']), building('Academic Building D', '1133371', ['D']),
  building('Academic Building E', '1133372', ['E']), building('Anisfield School of Business (ASB)', '1133424', ['ASB']),
  building('Adler Center for Nursing Excellence', '1133400', ['AC']),
] });
const C = buildingIdentityId('1133370'); const D = buildingIdentityId('1133371'); const E = buildingIdentityId('1133372');
const ASB = buildingIdentityId('1133424'); const AC = buildingIdentityId('1133400');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = (n: number, name: string, code: string): CampusIdentity => ({ id: id(n), kind: 'subject', name: `${name} (${code})`, aliases: [],
  links: [{ collection: 'subjects', source_key: 'course-subjects', source_record_keys: [code] }] });
const office = (n: number, name: string, keys: string[]): CampusIdentity => ({ id: id(n), kind: 'office', name, aliases: [],
  links: [{ collection: 'office_sections', source_key: 'office-pages', source_record_keys: keys }] });
const professor = (n: number, name: string, profile: Record<string, unknown>) => {
  const key = `${profile.profileUrl}#email=${profile.email}`;
  const person: CampusIdentity = { id: id(n), kind: 'person', name, aliases: [], links: [{ collection: 'faculty', source_key: 'faculty', source_record_keys: [key] }] };
  return { person, record: [`faculty:faculty:${key}`, { name, office: '', bio: '', ...profile }] as [string, Record<string, unknown>] };
};
/** A person an office's pages list, as the office-staff step leaves them: listed_by, with each page as evidence. */
const listed = (n: number, name: string, email: string, by: string, pages: string[], rest: Partial<CampusIdentity> = {}): CampusIdentity => ({
  id: id(n), kind: 'person', name, aliases: [], links: [{ collection: 'staff', source_key: 'office-pages', source_record_keys: [email] }],
  ...rest,
  relationships: [...rest.relationships ?? [], { type: 'listed_by', target_entity_id: by, evidence: pages.map(page => (
    { collection: 'office_sections', source_key: 'office-pages', source_record_key: page, field: 'sections', source_url: `https://${page}` })) }],
});
const page = (key: string, sections: Array<[string, string]>) => ({ source_key: 'office-pages', source_record_key: key, url: `https://${key}`,
  sections: sections.map(([heading, text]) => ({ heading, text })) });
const targets = (person: CampusIdentity, type: string) => (person.relationships ?? [])
  .filter(r => r.type === type).map(r => 'target_entity_id' in r ? r.target_entity_id : null);
const noReviews: ReviewedPersonRooms = { schema_version: 1, rooms: [] };

test('a title names a department after its rank; a convening list names one per line while each is one', () => {
  assert.deepEqual(titleFields('Associate Professor of Chemistry'), ['Chemistry']);
  assert.deepEqual(titleFields('Lecturer, Finance'), ['Finance']);
  assert.deepEqual(titleFields('Chemistry Lecturer'), ['Chemistry']);
  // One field per role; a fellowship after a comma, a specialty after a dash or in parentheses is dropped.
  assert.deepEqual(titleFields('Dean of SNH / Professor of Chemistry'), ['Chemistry']);
  assert.deepEqual(titleFields('Assistant Professor of Economics , GLO Research Fellow'), ['Economics']);
  assert.deepEqual(titleFields('Professor of Biology - Ecology'), ['Biology']);
  assert.deepEqual(titleFields('Lecturer, Nursing (Adult Health)'), ['Nursing']);
  assert.deepEqual(titleFields('Director of Grants'), []);
  assert.deepEqual(convenedFields('Research interests.\nConvening Group\nBiology (primary)\nWomen, Gender & Sexuality Studies\n'), ['Biology', 'Women, Gender & Sexuality Studies']);
  assert.deepEqual(convenedFields('Convening Group: Nursing'), ['Nursing']);
  assert.deepEqual(convenedFields('No list here'), []);
});

test('a room is read beside a name, or labeled right after the person\'s own address', () => {
  assert.deepEqual(roomsBesideName('(C207) Director Phone: (201) 684-7513 E-mail:'), ['C-207']);
  assert.deepEqual(roomsBesideName('Coordinator of Student Activities Office: SC-202D Phone: (201) 684-7223 E-mail:'), ['SC-202D']);
  assert.deepEqual(roomsBesideName('Counselor 505 Ramapo Valley Road, D-216'), ['D-216']);
  // A suite named in a sentence is no one's room.
  assert.deepEqual(roomsBesideName('Come and see us in Suite ASB 513'), []);
  const [tancy, chrisanne] = staffSpansInSection('Financial Aid Office Contacts', 'Tancy NunezAssistant Director Financial AidE-mail: tnunez@ramapo.edu (mailto:tnunez@ramapo.edu)'
    + 'Phone: (201) 684-7242Office: E-207 Chrisanne McGarveyAssistant Director / Systems ManagerE-mail: cmcgarve@ramapo.edu (mailto:cmcgarve@ramapo.edu)Phone: (201) 684-7548Office: E208');
  assert.equal(roomAfterAddress(tancy.after, tancy.email), 'E-207');
  assert.equal(roomAfterAddress(chrisanne.after, chrisanne.email), 'E-208');
  // Another office's room after the address is past the end of the entry.
  assert.equal(roomAfterAddress('  kmcgee@ramapo.edu  The Public Safety Department Phone: (201) 684-6666 Office Location: C-102', 'kmcgee@ramapo.edu'), null);
  assert.equal(roomAfterAddress(' ; Office: D-216; Phone: (201) 684-7522', 'tyonai@ramapo.edu'), 'D-216');
});

test('a professor is part_of the department their own title or convening list names, and listed_by the office whose site has their profile', () => {
  const chemistry = subject(1, 'Chemistry', 'CHEM'); const biology = subject(2, 'Biology', 'BIOL'); const nursing = subject(3, 'Nursing', 'NURS');
  // The catalog names two departments "Business Administration", and two "Data Science" though only
  // DATA has courses (a subject) in this release: neither name links a department.
  const badm = subject(4, 'Business Administration', 'BADM'); const mbad = subject(5, 'Business Administration', 'MBAD');
  const data = subject(6, 'Data Science', 'DATA');
  const catalog = [{ code: 'CHEM', name: 'Chemistry' }, { code: 'DATA', name: 'Data Science' }, { code: 'DSCI', name: 'Data Science' }];
  const library = office(10, 'Library', ['www.ramapo.edu/library/', 'www.ramapo.edu/library/staff/']);
  const both = office(11, 'Provost', ['www.ramapo.edu/shared/']); const other = office(12, 'Grants', ['www.ramapo.edu/shared/grants/']);
  const chem = professor(20, 'Pat Chemist', { title: 'Associate Professor of Chemistry', school: 'School of Science, Nursing, and Health', email: 'pchem@ramapo.edu',
    profileUrl: 'https://www.ramapo.edu/snh/faculty/pat-chemist', bio: 'Research.\nConvening Group\nBiology (primary)\nWomen, Gender & Sexuality Studies\nChemistry' });
  const twin = professor(21, 'Dana Data', { title: 'Assistant Professor of Chemistry and Data Science / Lecturer, Business Administration', school: 'Anisfield School of Business', email: 'ddata@ramapo.edu', profileUrl: 'https://www.ramapo.edu/asb/faculty/dana-data' });
  const retired = professor(22, 'Ret Nurse', { title: 'Professor of Nursing', school: 'School of Science, Nursing, and Health (Retired)', email: 'rnurse@ramapo.edu', profileUrl: 'https://www.ramapo.edu/snh/faculty/ret-nurse' });
  const lecturer = professor(23, 'Lee Lecturer', { title: 'Lecturer, Nursing (Adult Health)', school: 'School of Science, Nursing, and Health', email: 'llect@ramapo.edu', profileUrl: 'https://www.ramapo.edu/snh/faculty/lee' });
  const librarian = professor(24, 'Libby Rarian', { title: 'Librarian', school: 'Library', email: 'lrarian@ramapo.edu', profileUrl: 'https://www.ramapo.edu/library/staff/' });
  const shared = professor(25, 'Sam Shared', { title: 'Coordinator', school: 'Library', email: 'sshared@ramapo.edu', profileUrl: 'https://www.ramapo.edu/shared/sam' });
  // "Criticism" is no department's name, so "Biology and Criticism" names no department.
  const critic = professor(26, 'Cris Critic', { title: 'Professor of Biology and Criticism', school: 'School of Science, Nursing, and Health', email: 'ccritic@ramapo.edu', profileUrl: 'https://www.ramapo.edu/snh/faculty/cris' });
  const people = [chem, twin, retired, lecturer, librarian, shared, critic];
  const entities = [chemistry, biology, nursing, badm, mbad, data, library, both, other, ...people.map(p => p.person), ...compileBuildingIdentities(buildings, [], new Map()).buildings];
  const result = linkPeople(entities, new Map(people.map(p => p.record)), [], buildings, catalog, noReviews);

  const [pat, dana, ret, lee, libby, sam, cris] = people.map(p => p.person);
  // The title's department, then each convening line while it is one department.
  assert.deepEqual(pat.relationships, [
    { type: 'part_of', target_entity_id: chemistry.id, evidence: [
      { collection: 'faculty', source_key: 'faculty', source_record_key: 'https://www.ramapo.edu/snh/faculty/pat-chemist#email=pchem@ramapo.edu', field: 'title', source_url: 'https://www.ramapo.edu/snh/faculty/pat-chemist' }] },
    { type: 'part_of', target_entity_id: biology.id, evidence: [
      { collection: 'faculty', source_key: 'faculty', source_record_key: 'https://www.ramapo.edu/snh/faculty/pat-chemist#email=pchem@ramapo.edu', field: 'bio', source_url: 'https://www.ramapo.edu/snh/faculty/pat-chemist' }] },
  ]);
  // "Chemistry and Data Science" is two department names: Chemistry links, and Data Science, two departments' name, does not.
  assert.deepEqual(targets(dana, 'part_of'), [chemistry.id]);
  assert.deepEqual(result.unresolved.filter(u => u.entity === 'Dana Data').map(u => u.reason), [
    'The profile\'s title names "Data Science", the catalog\'s name of more than one department; no department is linked by it.',
    'The profile\'s title names "Business Administration", the catalog\'s name of more than one department; no department is linked by it.']);
  assert.equal(ret.relationships, undefined);
  assert.deepEqual(targets(lee, 'part_of'), [nursing.id]);
  assert.deepEqual(libby.relationships, [{ type: 'listed_by', target_entity_id: library.id, evidence: [
    { collection: 'faculty', source_key: 'faculty', source_record_key: 'https://www.ramapo.edu/library/staff/#email=lrarian@ramapo.edu', field: 'profileUrl', source_url: 'https://www.ramapo.edu/library/staff/' }] }]);
  // A site two offices link is neither's.
  assert.equal(sam.relationships, undefined);
  assert.equal(cris.relationships, undefined);
  assert.deepEqual(result.linked, { part_of: 4, listed_by: 1, office_at: 0 });
  validateCampusIdentities({ schema_version: 1, entities });

  // A second run adds nothing.
  const again = linkPeople(entities, new Map(people.map(p => p.record)), [], buildings, catalog, noReviews);
  assert.deepEqual(again.linked, { part_of: 0, listed_by: 0, office_at: 0 });
  assert.equal(pat.relationships?.length, 2);
});

test('a person no room places yet is office_at the building their profile or listing prints a room in', () => {
  const finaid = office(10, 'Financial Aid', ['www.ramapo.edu/finaid/']); const counsel = office(11, 'General Counsel', ['www.ramapo.edu/general-counsel/']);
  const oss = office(12, 'Specialized Services', ['www.ramapo.edu/oss/']); const grants = office(13, 'Grants', ['www.ramapo.edu/grants/', 'www.ramapo.edu/provost/grants/']);
  const audit = office(14, 'Internal Audit', ['www.ramapo.edu/internal-audit/']);
  const nurse = professor(20, 'Natasha Nurse', { title: 'Instructor', school: 'School of Science, Nursing, and Health', email: 'nnurse@ramapo.edu',
    profileUrl: 'https://www.ramapo.edu/snh/faculty/natasha', bio: 'Teaches nursing.\nOffice: AC-210B\nPhone: (201) 684-7000' });
  const away = professor(21, 'Morgan Away', { title: 'Instructor', school: 'School of Science, Nursing, and Health', email: 'maway@ramapo.edu',
    profileUrl: 'https://www.ramapo.edu/snh/faculty/morgan', bio: 'Office Location: M-208' });
  const tancy = listed(30, 'Tancy Nunez', 'tnunez@ramapo.edu', finaid.id, ['www.ramapo.edu/finaid/']);
  const chrisanne = listed(31, 'Chrisanne McGarvey', 'cmcgarve@ramapo.edu', finaid.id, ['www.ramapo.edu/finaid/']);
  const kat = listed(32, 'Kat McGee', 'kmcgee@ramapo.edu', counsel.id, ['www.ramapo.edu/general-counsel/']);
  const david = listed(33, 'David C. Nast', 'dnast@ramapo.edu', oss.id, ['www.ramapo.edu/oss/']);
  const bernadette = listed(34, 'Bernadette Connors', 'bconnors@ramapo.edu', grants.id, ['www.ramapo.edu/grants/', 'www.ramapo.edu/provost/grants/']);
  const patricia = listed(35, 'Patricia Chavez', 'pchavez@ramapo.edu', audit.id, ['www.ramapo.edu/internal-audit/']);
  // Placed already by their own contact room: a listing never moves them.
  const placed = listed(36, 'Gina Toriello', 'gtoriell@ramapo.edu', finaid.id, ['www.ramapo.edu/finaid/'], { relationships: [{ type: 'office_at', target_entity_id: D,
    evidence: [{ collection: 'contacts', source_key: 'campus-directory', source_record_key: 'gtoriell', field: 'office' }] }] });
  const pages = [
    page('www.ramapo.edu/finaid/', [['Financial Aid Office Contacts', 'Tancy NunezAssistant Director Financial AidE-mail: tnunez@ramapo.edu (mailto:tnunez@ramapo.edu)Phone: (201) 684-7242Office: E-207 '
      + 'Chrisanne McGarveyAssistant Director / Systems ManagerE-mail: cmcgarve@ramapo.edu (mailto:cmcgarve@ramapo.edu)Phone: (201) 684-7548Office: E208 '
      + 'Gina TorielloFinancial Aid CounselorE-mail: gtoriell@ramapo.edu (mailto:gtoriell@ramapo.edu)Phone: (201) 684-7252Office: E-209']]),
    // Only one entry has a room and the last has none: the room may open the next entry, so it is no one's.
    page('www.ramapo.edu/general-counsel/', [['Contact', 'Stacy Storms Paralegal Email: sstorms@ramapo.edu (mailto:sstorms@ramapo.edu) Phone: (201) 684-7865 '
      + 'Kat McGee, J.D. Director of Title IX Email: kmcgee@ramapo.edu (mailto:kmcgee@ramapo.edu) Phone: (201) 684-7220 Office: D-104A '
      + 'Samuel Antoshak Fire and Safety Specialist E-mail: santosha@ramapo.edu (mailto:santosha@ramapo.edu) Phone: (201) 684-7614']]),
    page('www.ramapo.edu/oss/', [['OSS Staff', 'Dr. David C. Nast (C207) Director Phone: (201) 684-7513 E-mail: dnast@ramapo.edu (mailto:dnast@ramapo.edu)']]),
    page('www.ramapo.edu/grants/', [['Contact Information', 'Bernadette ConnorsDirector of GrantsE-mail: bconnors@ramapo.edu (mailto:bconnors@ramapo.edu)Phone: (201) 684-7616Office: C105']]),
    page('www.ramapo.edu/provost/grants/', [['Grants', 'Bernadette Connors Director of Grants bconnors@ramapo.edu Phone: 201-684-7616 Office: D211L']]),
    page('www.ramapo.edu/internal-audit/', [['Internal Audit', 'Patricia Chavez Director of Internal Audit Office: M-208 Phone: (201) 684-7000 E-mail: pchavez@ramapo.edu (mailto:pchavez@ramapo.edu)']]),
  ];
  const people = [nurse.person, away.person, tancy, chrisanne, kat, david, bernadette, patricia, placed];
  const entities = [finaid, counsel, oss, grants, audit, ...people, ...compileBuildingIdentities(buildings, [], new Map()).buildings];
  const result = linkPeople(entities, new Map([nurse.record, away.record]), pages, buildings, [], noReviews);

  assert.deepEqual(nurse.person.relationships, [{ type: 'office_at', target_entity_id: AC, evidence: [
    { collection: 'faculty', source_key: 'faculty', source_record_key: 'https://www.ramapo.edu/snh/faculty/natasha#email=nnurse@ramapo.edu', field: 'bio', source_url: 'https://www.ramapo.edu/snh/faculty/natasha' }] }]);
  assert.equal(away.person.relationships, undefined);
  const page_ = (key: string): IdentityEvidence => ({ collection: 'office_sections', source_key: 'office-pages', source_record_key: key, field: 'sections', source_url: `https://${key}` });
  assert.deepEqual(tancy.relationships?.find(r => r.type === 'office_at'), { type: 'office_at', target_entity_id: E, evidence: [page_('www.ramapo.edu/finaid/')] });
  assert.deepEqual(targets(chrisanne, 'office_at'), [E]);
  assert.deepEqual(targets(david, 'office_at'), [C]);
  assert.deepEqual(targets(kat, 'office_at'), []);
  assert.deepEqual(targets(bernadette, 'office_at'), []);
  assert.deepEqual(targets(patricia, 'office_at'), []);
  assert.deepEqual(targets(placed, 'office_at'), [D]);
  assert.deepEqual(result.linked, { part_of: 0, listed_by: 0, office_at: 4 });
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.reason]), [
    ['Morgan Away', 'The profile\'s own text gives the room "M-208", which has no reviewed building prefix; no building is inferred.'],
    ['Bernadette Connors', 'The pages that list Bernadette Connors give rooms in 2 buildings; none is chosen.'],
    ['Patricia Chavez', 'The page gives Patricia Chavez the room M-208, which does not name one building by a reviewed prefix; no building is inferred.'],
  ]);
  validateCampusIdentities({ schema_version: 1, entities });
});

test('a reviewed room places its person only while this run\'s capture still says it', () => {
  const quote = 'Dean Benny Chan, School of Science, Nursing, and Health, Room ASB-422';
  const reviewed: ReviewedPersonRooms = { schema_version: 1, rooms: [{ person_id: id(40), person: 'Benny Chan', room: 'ASB-422',
    url: 'https://www.ramapo.edu/registrar/graduation-commencement/', section: 'School Deans', quote, reviewed_at: '2026-11-03', note: 'The registrar lists each dean\'s room.' }] };
  const run = (text: string, extra: Partial<CampusIdentity> = {}, name = 'Benny Chan') => {
    const dean: CampusIdentity = { id: id(40), kind: 'person', name, aliases: [], links: [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['bchan'] }], ...extra };
    const entities = [dean, ...compileBuildingIdentities(buildings, [], new Map()).buildings];
    const result = linkPeople(entities, new Map(), [page('www.ramapo.edu/registrar/graduation-commencement/', [['School Deans', text]])], buildings, [], reviewed);
    validateCampusIdentities({ schema_version: 1, entities });
    return { dean, result };
  };
  const said = run(`Dean Ed Petkus, Anisfield School of Business, Room ASB-333 ${quote} Interim Dean Michael Unger, ASB 123`);
  assert.deepEqual(said.dean.relationships, [{ type: 'office_at', target_entity_id: ASB, evidence: [{ collection: 'office_sections', source_key: 'office-pages',
    source_record_key: 'www.ramapo.edu/registrar/graduation-commencement/', field: 'sections', source_url: 'https://www.ramapo.edu/registrar/graduation-commencement/' }] }]);
  assert.deepEqual(said.result.unresolved, []);
  // The page now gives another room: withheld, and said why.
  const moved = run('Dean Benny Chan, School of Science, Nursing, and Health, Room ASB-430');
  assert.equal(moved.dean.relationships, undefined);
  assert.match(moved.result.unresolved[0].reason, /no longer gives Benny Chan the room ASB-422; the room is withheld/);
  // The ID must still be that person.
  const renamed = run(quote, {}, 'Benjamin Chan');
  assert.equal(renamed.dean.relationships, undefined);
  assert.match(renamed.result.unresolved[0].reason, /exactly one person node with that ID and name/);
  // Their own records place them elsewhere: the reviewed room never moves them.
  const elsewhere = run(quote, { relationships: [{ type: 'office_at', target_entity_id: C, evidence: [{ collection: 'contacts', source_key: 'campus-directory', source_record_key: 'bchan', field: 'office' }] }] });
  assert.deepEqual(targets(elsewhere.dean, 'office_at'), [C]);
  assert.match(elsewhere.result.unresolved[0].reason, /place them in another building than ASB-422; the reviewed room is withheld/);
});
