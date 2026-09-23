import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogRecords, extractRequirements, inferDegreeLabel, inferProgramType, normalizeCatalogCapture } from './scrape-catalog-api';

test('Creative Music Technology MFA is normalized as a graduate MFA degree', () => {
  const program = {
    id: 'creative-music-technology-mfa',
    code: 'CG-MFA-CRMT',
    name: 'Creative Music Technology MFA',
  };

  assert.equal(inferProgramType(program), 'graduate');
  assert.equal(inferDegreeLabel(program, 'graduate'), 'Master of Fine Arts');
});

test('all sibling requirements, free text and rule restrictions survive normalization', () => {
  const program = { id: 'arts', code: 'CA-BA-ARTS', requisites: { requisitesSimple: [
    { name: 'Art History Concentration', rules: [
      { condition: 'completedAllOf', name: 'Lower-level Required', value: { condition: 'courses', values: [{ logic: 'and', value: ['HIST201'] }] } },
      { condition: 'completedAtLeastXOf', restriction: 2, description: '<p>At least one 300-level course</p>', notes: '<p>Cannot double count.</p>', value: { condition: 'courses', values: [{ logic: 'or', value: ['ARHT204', 'ARHT245'] }] } },
      { condition: 'freeformText', name: 'Electives', value: '<p>Complete three 300/400-Level ARHT Courses</p>' },
      { condition: 'numberOf', number: 2, minCourses: 1, value: { condition: 'other', values: [] } },
    ] },
    { name: 'Not published', showInCatalog: false, rules: [{ condition: 'freeformText', value: 'hidden' }] },
    { name: 'Notes only', description: '<p>See an advisor.</p>' },
  ] } };
  const sections = extractRequirements(program, new Map([['HIST201', 'How to Make History']]))!;
  assert.equal(sections.length, 2);
  assert.equal(sections[0].rule?.condition, 'catalogBlock');
  const rules = sections[0].rule!.subRules!;
  assert.equal(rules.length, 4);
  assert.equal(rules[0].items?.[0].codes[0].name, 'How to Make History');
  assert.equal(rules[1].count, 2);
  assert.equal(rules[1].note, 'At least one 300-level course\nCannot double count.');
  assert.equal(rules[2].text, 'Complete three 300/400-Level ARHT Courses');
  assert.deepEqual(rules[3].constraints, { number: 2, minCourses: 1, value: { condition: 'other', values: [] } });
  assert.equal(sections[1].note, 'See an advisor.');
});

test('catalog rebuild uses current explicit fields without guessed faculty, convener or general education', () => {
  const base = { id: 'p', name: 'Computer Science BS', code: 'TS-BS-CMPS', status: 'Active', college: 'Science, Nursing and Health',
    catalogDescription: '<p>Current&#8217;s &amp; accurate description.</p>',
    requisites: { requisitesSimple: [{ name: 'Major', rules: [{ condition: 'freeformText', value: 'Published requirement.' }] }],
      requisitesFreeform: { showInCatalog: true, value: '<p>Mandatory preface.</p><ul><li>One choice.</li></ul><p>Additional restriction.</p>' } },
  };
  const profiles = [{ name: 'Person', profileUrl: 'https://www.ramapo.edu/snh/faculty/person/', email: 'person@example.edu', courses: ['Computer Science'] }];
  const raw = { scrapedAt: '2026-09-23T12:00:00Z', programs: [base], courses: [{ code: 'CMPS147', name: 'Programming', status: 'Active', credits: { creditHours: { min: 3.5, max: 4, operator: 'TO' } } }] };
  const normalized = normalizeCatalogCapture(raw, profiles);
  assert.deepEqual(normalizeCatalogCapture(raw, profiles), normalized);
  const program = normalized.programs.schools[0].majors[0];
  assert.equal(program.description, 'Current’s & accurate description.');
  assert.equal(program.school, 'School of Science, Nursing, and Health');
  assert.equal(program.faculty, undefined);
  assert.equal(program.convener, undefined);
  assert.equal(program.requirements?.length, 2);
  assert.equal(program.requirements?.[1].note, 'Mandatory preface. One choice. Additional restriction.');
  assert.equal(normalized.programs.generatedAt, raw.scrapedAt);
  assert.deepEqual(normalized.courses['CMPS 147'].credits, { min: 3.5, max: 4, operator: 'TO' });
  const faculty = '<a href="https://www.ramapo.edu/snh/faculty/person/">Person</a>';
  const listedOnly = normalizeCatalogCapture({ ...raw, programs: [{ ...base, customFields: { xiQxl: faculty, other: faculty } }] }, profiles).programs.schools[0].majors[0];
  assert.equal(listedOnly.faculty?.[0].email, 'person@example.edu');
  assert.equal(listedOnly.convener, undefined);
  const convenerOnly = normalizeCatalogCapture({ ...raw, programs: [{ ...base, customFields: { rJQmj: faculty } }] }, profiles).programs.schools[0].majors[0];
  assert.equal(convenerOnly.convener?.name, 'Person');
  assert.equal(convenerOnly.faculty, undefined);
  const ambiguous = normalizeCatalogCapture({ ...raw, programs: [{ ...base, customFields: { xiQxl: faculty } }] }, [...profiles, { ...profiles[0], name: 'Another person', email: 'other@example.edu' }]).programs.schools[0].majors[0];
  assert.equal(ambiguous.faculty?.[0].email, undefined);
});

test('current college names are not rewritten to predecessor schools', () => {
  for (const [college, expected] of [
    ['Arts, Humanities and Education', 'School of Arts, Humanities, and Education'],
    ['Social Sciences and Social Work', 'School of Social Sciences and Social Work'],
  ]) {
    const normalized = normalizeCatalogCapture({ scrapedAt: '2026-09-23T12:00:00Z', courses: [], programs: [{ id: '1', code: 'AH-BA-HIST', name: 'History BA', status: 'Active', college }] });
    assert.equal(normalized.programs.schools[0].school, expected);
  }
});

test('source response maps and conflicting duplicates are handled explicitly', () => {
  assert.deepEqual(catalogRecords({ one: { code: 'A' }, two: { code: 'B' } }), [{ code: 'A' }, { code: 'B' }]);
  assert.deepEqual(catalogRecords({ results: [{ code: 'A' }], total: 1 }), [{ code: 'A' }]);
  assert.throws(() => catalogRecords({ error: 'Forbidden' }), /Unrecognized/);
  assert.throws(() => normalizeCatalogCapture({ scrapedAt: '2026-09-23T12:00:00Z', programs: [], courses: [{ code: 'CMPS147', name: 'A' }, { code: 'CMPS 147', name: 'B' }] }), /Conflicting catalog course/);
});
