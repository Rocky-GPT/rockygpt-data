import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentities } from './campus-identities';
import { compileCourseIdentities, courseIdentityId } from './course-identities';
import { chooseFor, compileRequirementGroups, type RequirementGroup } from './requirement-groups';

const code = (value: string) => ({ code: value, name: `${value} name` });
const genEd = { section: 'General Education: Quantitative Reasoning', note: 'Choose one.', selectCount: 1, courses: [code('CMPS 147'), code('MATH 121')] };
const programs = {
  schools: [{
    school: 'Science',
    majors: [
      {
        name: 'Computer Science BS', catalogCode: 'TS-BS-CMPS',
        requirements: [
          genEd,
          { section: 'Major Requirements', rule: { condition: 'allOf', subRules: [
            { condition: 'completedAllOf', items: [{ logic: 'and', codes: [code('CMPS 147')] }, { logic: 'and', codes: [code('CMPS 148')] }] },
            { condition: 'completedAnyOf', items: [{ logic: 'or', codes: [code('MATH 205'), code('MATH 237')] }] },
          ] } },
          { section: 'Electives: Select Seven (7)', rule: { condition: 'completedAtLeastXOf', count: 7, items: [{ logic: 'and', codes: [code('CMPS 331')] }, { logic: 'and', codes: [code('NOPE 999')] }] } },
          { section: '300-Level Course', rule: { condition: 'completedAnyOf', count: 2, items: [{ logic: 'and', codes: [code('CMPS  311')] }] } },
          { section: 'Catalog Requirements', note: '- Two 200-level courses' },
        ],
      },
      { name: 'Mathematics BS', catalogCode: 'TS-BS-MATH', requirements: [genEd] },
      { name: 'Unlinked BS', catalogCode: 'TS-BS-NONE', requirements: [genEd] },
    ],
  }],
};
const courses = compileCourseIdentities(Object.fromEntries(
  ['CMPS 147', 'CMPS 148', 'CMPS 311', 'CMPS 331', 'MATH 121', 'MATH 205', 'MATH 237'].map(c => [c, { code: c, name: `${c} name` }]),
));
const programId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const registry: CampusIdentities = { schema_version: 1, entities: [
  { id: programId(1), kind: 'program', name: 'Computer Science BS', aliases: [], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: ['Science:Computer Science BS'] }] },
  { id: programId(2), kind: 'program', name: 'Mathematics BS', aliases: [], links: [{ collection: 'programs', source_key: 'academic-programs', source_record_keys: ['Science:Mathematics BS'] }] },
] };
const compiled = () => compileRequirementGroups(programs, registry, courses);
const group = (label: string): RequirementGroup => compiled().groups.find(g => g.label === label)!;

test('identical sections are one shared record with every program link and provenance', () => {
  const artifact = compiled();
  assert.equal(artifact.groups.length, 5);
  const shared = group('General Education: Quantitative Reasoning');
  assert.equal(shared.program_sections, 3);
  assert.deepEqual(shared.provenance.map(p => p.catalog_code), ['TS-BS-CMPS', 'TS-BS-MATH', 'TS-BS-NONE']);
  assert.deepEqual(shared.provenance[1].path, ['schools', 0, 'majors', 1, 'requirements', 0]);
  const links = artifact.edges.filter(e => e.type === 'requirement_group' && 'record_id' in e.target && e.target.record_id === shared.id);
  assert.deepEqual(links.map(e => e.source), [{ entity_id: programId(1) }, { entity_id: programId(2) }]);
  assert.deepEqual(links.map(e => [e.order, e.path]), [
    [0, ['schools', 0, 'majors', 0, 'requirements', 0]],
    [0, ['schools', 0, 'majors', 1, 'requirements', 0]],
  ]);
  assert.deepEqual(shared.course_list?.choose, { at_least: 1 });
  assert.ok(artifact.unresolved.some(i => i.record === 'catalog:TS-BS-NONE' && i.reason.includes('no identity')));
  assert.deepEqual(compiled(), artifact);
});

test('nested all-of, any-of and choose-N survive, and options never become requirements', () => {
  const major = group('Major Requirements');
  assert.deepEqual(major.rule?.choose, { all: true });
  assert.deepEqual(major.rule?.sub_rules.map(r => [r.condition, r.choose]), [['completedAllOf', { all: true }], ['completedAnyOf', { at_least: 1 }]]);
  const artifact = compiled();
  assert.ok(artifact.edges.every(e => e.type === 'requirement_group' || e.type === 'requirement_option'));
  const either = artifact.edges.filter(e => e.type === 'requirement_option' && 'record_id' in e.source && e.source.record_id === major.id && e.logic === 'or');
  assert.deepEqual(either.map(e => [e.code, e.path]), [
    ['MATH 205', ['rule', 'sub_rules', 1, 'items', 0, 'courses', 0]],
    ['MATH 237', ['rule', 'sub_rules', 1, 'items', 0, 'courses', 1]],
  ]);
  // Seven of two bundled items is not a defensible derived interpretation.
  assert.equal(group('Electives: Select Seven (7)').rule?.choose, null);
});

test('codes resolve only by exact catalog key; ambiguous forms and text stay as published', () => {
  const artifact = compiled();
  const electives = group('Electives: Select Seven (7)');
  assert.deepEqual(electives.rule?.items.map(i => i.courses[0].course_id), [courseIdentityId('academic-programs', 'CMPS 331'), null]);
  assert.ok(artifact.unresolved.some(i => i.record === 'NOPE 999' && i.reason.includes('not a key in this release catalog')));
  const ambiguous = group('300-Level Course');
  assert.equal(ambiguous.rule?.choose, null);
  assert.equal(ambiguous.rule?.items[0].courses[0].course_id, null);  // "CMPS  311" is not "CMPS 311".
  assert.ok(artifact.unresolved.some(i => i.record === '300-Level Course' && i.reason.includes('not interpreted')));
  const text = group('Catalog Requirements');
  assert.equal(text.shape, 'text');
  assert.equal(text.note, '- Two 200-level courses');
  assert.equal(artifact.edges.filter(e => 'record_id' in e.source && e.source.record_id === text.id).length, 0);
});

test('derived choices exist only for unambiguous published forms', () => {
  assert.deepEqual(chooseFor('completedAllOf', null, null, true, false), { all: true });
  assert.equal(chooseFor('completedAllOf', 4, null, true, false), null);
  assert.deepEqual(chooseFor('minimumCredits', null, 20, true, false), { minimum_credits: 20 });
  assert.equal(chooseFor('minimumCredits', 3, 12, true, false), null);
  assert.equal(chooseFor('freeformText', null, null, false, false), null);
  assert.equal(chooseFor('completedAtLeastXOf', 0, null, true, false), null);
  assert.equal(chooseFor('completedAtLeastXOf', 6, null, true, false, 1), null);
  assert.deepEqual(chooseFor('completedAtLeastXOf', 2, null, true, false, 3), { at_least: 2 });
});

test('rule names, notes, free text and unknown restrictions survive the graph artifact', () => {
  const original = structuredClone(programs);
  const rule = { condition: 'catalogBlock', name: 'Published rules', subRules: [
    { condition: 'completedAtLeastXOf', count: 6, note: 'At least one 300-level course.', items: [{ logic: 'or', codes: [code('CMPS 147'), code('CMPS 148')] }] },
    { condition: 'freeformText', name: 'Extra requirement', text: 'Consult an advisor.' },
    { condition: 'completedAnyOf', constraints: { minCourses: 2 }, items: [{ logic: 'or', codes: [code('MATH 121')] }] },
  ] };
  const source = { schools: [{ school: 'Science', majors: [{ name: 'Computer Science BS', requirements: [{ section: 'Rules', rule }] }] }] };
  const compiled = compileRequirementGroups(source, registry, courses).groups[0];
  assert.equal(compiled.rule?.choose, null);
  assert.equal(compiled.rule?.name, 'Published rules');
  assert.equal(compiled.rule?.sub_rules[0].note, 'At least one 300-level course.');
  assert.equal(compiled.rule?.sub_rules[0].choose, null);
  assert.equal(compiled.rule?.sub_rules[1].text, 'Consult an advisor.');
  assert.deepEqual(compiled.rule?.sub_rules[2].constraints, { minCourses: 2 });
  assert.equal(compiled.rule?.sub_rules[2].choose, null);
  source.schools[0].majors[0].requirements[0].rule.subRules[0].note = 'Different restriction';
  assert.notEqual(compileRequirementGroups(source, registry, courses).groups[0].id, compiled.id);
  assert.deepEqual(programs, original);
});
