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

const layout = {
  program: { labels: {}, tabs: [
    { title: 'Requirements', fields: [{ key: 'requisites', label: 'Program Requirements' }] },
    { title: 'Description and Outcomes', fields: [{ key: 'catalogFullDescription', label: 'Program Description' }, { key: 'o01gn', label: 'Learning Goals and Outcomes' }] },
    { title: 'Details and Faculty', fields: [{ key: 'ezwRM', label: 'Concentrations' }, { key: 'college', label: 'School' }, { key: 'career', label: 'Program Level' },
      { key: 'degreeDesignations', label: 'Degree Designation' }, { key: 'YdbEO', label: 'Convening Group' }] },
    { title: 'Sample Graduation Plan', fields: [{ key: 'gtuqg', label: 'Sample Graduation Plan' }] },
    { title: '', fields: [{ key: 'tiLLp', label: 'tiLLp' }] },
  ] },
  course: { labels: {}, tabs: [{ title: 'Description and Details', fields: [{ key: 'description', label: 'Course Description' }] }] },
};

test('catalog rich text keeps its lines, and linked programs and courses show their catalog names', () => {
  const capture = {
    scrapedAt: '2026-09-24T12:00:00Z', settings: layout, departments: [{ id: 'dept-cmps', name: 'Computer Science (CMPS)' }],
    courses: [
      { code: 'CMPS147', name: 'COMPUTER SCIENCE I', status: 'Active', courseGroupId: 'group-147' },
      { code: 'CMPS337', name: 'COMPUTER VISION', status: 'Active', courseGroupId: 'group-337' },
    ],
    programs: [
      { id: 'bs-2026', programGroupId: 'bs', code: 'SN-BS-CMPS', name: 'Computer Science BS', status: 'Active', college: 'Science, Nursing and Health',
        career: 'UG - Undergraduate', degreeDesignations: ['BS - Bachelor of Science'], departments: ['dept-other'],
        catalogFullDescription: '<p>Study computing.</p><p>A <a data-program-id="minor">program</a> is also offered.</p>',
        customFields: {
          o01gn: '<p>Graduates will:</p><ul><li><p>Program well.</p></li><li>Design systems.</li></ul><ol><li>Outcome one.</li><li>Outcome two.</li></ol>',
          ezwRM: 'Data Science, Robotics', YdbEO: ['dept-cmps'], gtuqg: '<p>See the <a href="https://www.ramapo.edu/mygraduationplan/">My Graduation Plan</a> page.</p>',
          hCUrJ: 'Program Goals: not displayed.', tiLLp: 'Unlabelled.',
        },
        requisites: { requisitesSimple: [{ name: 'Electives', rules: [{ condition: 'completedAtLeastXOf', restriction: 1,
          value: { condition: 'courses', values: [{ logic: 'and', value: ['CMPS147'] }, { logic: 'and', value: ['group-337'] }] } }] }] } },
      { id: 'minor-2026', programGroupId: 'minor', code: 'SN-MN-CMPS', name: 'Computer Science Minor', status: 'Active', college: 'Science, Nursing and Health',
        catalogFullDescription: '<p>A <a href="/programs/SN-BS-CMPS" data-program-id="SN-BS-CMPS">program</a> is also offered.</p>' },
    ],
  };
  const normalized = normalizeCatalogCapture(capture);
  const [bs, minor] = normalized.programs.schools[0].majors;
  assert.equal(bs.description, 'Study computing. A Computer Science Minor is also offered.');
  assert.equal(minor.description, 'A Computer Science BS is also offered.');
  // A requirement that cites a course's group ID names the course like any other option.
  const options = bs.requirements![0].rule!.items!.map(item => item.codes[0]);
  assert.deepEqual(options, [{ code: 'CMPS 147', name: 'COMPUTER SCIENCE I' }, { code: 'CMPS 337', name: 'COMPUTER VISION' }]);
  assert.equal(bs.learningGoalsAndOutcomes, 'Graduates will:\n- Program well.\n- Design systems.\n1. Outcome one.\n2. Outcome two.');
  assert.equal(bs.sampleGraduationPlan, 'See the My Graduation Plan page.');
  assert.equal(bs.catalogConcentrations, 'Data Science, Robotics');
  assert.equal(bs.programLevel, 'UG - Undergraduate');
  assert.deepEqual(bs.degreeDesignations, ['BS - Bachelor of Science']);
  assert.deepEqual(bs.conveningGroups, ['Computer Science (CMPS)']);
  // Every displayed field appears once, in page order, under its catalog label; hidden and
  // unlabelled fields, and the separately structured requirements, do not.
  assert.deepEqual(bs.catalogSections!.map(section => [section.title, section.fields.map(field => field.label)]), [
    ['Description and Outcomes', ['Program Description', 'Learning Goals and Outcomes']],
    ['Details and Faculty', ['Concentrations', 'School', 'Program Level', 'Degree Designation', 'Convening Group']],
    ['Sample Graduation Plan', ['Sample Graduation Plan']],
  ]);
  assert.equal(bs.catalogSections![0].fields[0].text, 'Study computing.\nA Computer Science Minor is also offered.');
  assert.deepEqual(minor.catalogSections!.map(section => section.title), ['Description and Outcomes', 'Details and Faculty']);
  // A capture made before layouts were recorded still normalizes, without displayed sections.
  const legacy = normalizeCatalogCapture({ ...capture, settings: undefined, departments: undefined });
  assert.equal(legacy.programs.schools[0].majors[0].catalogSections, undefined);
  assert.equal(legacy.programs.schools[0].majors[0].description, bs.description);
});

test('course prerequisites keep their rules, options and placement-test notes', () => {
  const normalized = normalizeCatalogCapture({ scrapedAt: '2026-09-24T12:00:00Z', programs: [], departments: [{ id: 'dept-cmps', name: 'Computer Science (CMPS)' }], courses: [
    { code: 'MATH110', name: 'PRECALCULUS', status: 'Active' },
    { code: 'CMPS147', name: 'COMPUTER SCIENCE I', status: 'Active', college: 'Science, Nursing and Health', departments: ['dept-cmps', 'dept-unknown', { id: 'dept-math', displayName: 'Mathematics (MATH)', chair: [{ email: 'internal@example.edu' }] }],
      requisites: { requisitesSimple: [{ name: 'Prerequisite', type: 'Prerequisite', rules: [{ condition: 'anyOf', name: 'Prerequisite Course or Placement Test', subRules: [
        { condition: 'completedAnyOf', name: 'Select 1 Course', value: { condition: 'courses', values: [{ logic: 'and', value: ['MATH110'] }] } },
        { condition: 'freeformText', name: 'Take 1 Test', value: 'Complete one Placement Test with the required minimum score:',
          notes: '<ul><li><p>ACCUPLACER Quantitative Reasoning (minimum score 258)</p></li><li><p>SAT MATH (minimum score 580)</p></li></ul>' },
      ] }] }] } },
  ] });
  const course = normalized.courses['CMPS 147'] as Record<string, unknown>;
  assert.equal(course.school, 'Science, Nursing and Health');
  // An embedded department contributes only its displayed name.
  assert.deepEqual(course.conveningGroups, ['Computer Science (CMPS)', 'Mathematics (MATH)']);
  assert.equal(course.requisitesText, [
    'Prerequisite',
    '  Prerequisite Course or Placement Test: any of',
    '    Select 1 Course: complete any of',
    '      MATH 110 PRECALCULUS',
    '    Take 1 Test: Complete one Placement Test with the required minimum score:',
    '      - ACCUPLACER Quantitative Reasoning (minimum score 258)',
    '      - SAT MATH (minimum score 580)',
  ].join('\n'));
  assert.equal((course.requisites as Array<{ section: string }>)[0].section, 'Prerequisite');
  assert.equal((normalized.courses['MATH 110'] as Record<string, unknown>).requisites, undefined);
});
