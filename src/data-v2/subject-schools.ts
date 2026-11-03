import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { ReviewedSchools } from './campus-schools';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, courseCatalogUrl } from './course-identities';
import { convenedBy, courseSubjectCode } from './course-subjects';

/**
 * @module data-v2/subject-schools
 * Each course subject is `part_of` the school its catalog courses are filed under.
 *
 * The catalog files every course under a college (the course record's `school`): a school's
 * current name, a reviewed former name, or the catalog's own short form of the name ("Vallario Sch
 * of Arts, Hum, Edu"). The reviewed schools file lists each school's short forms in
 * `catalog_colleges`, each with the evidence that it means that school. A subject whose courses
 * name exactly one school is placed in it, with those course records as evidence; a course with no
 * college says nothing. A subject whose courses name two schools, or a college that is not one of
 * the schools (Undergraduate Studies and Honors), is reported and not placed.
 *
 * A department with no course under its own code (Theater and Film (THFL), course-subjects.ts) is
 * placed the same way by the courses it convenes, those whose `conveningGroups` name it exactly
 * (THEA and FILM courses); one that convenes no course, by the programs that name it as their
 * convening group, each filed under its school (the program record's `school`), as evidence.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
/** Evidence is capped per relationship; the first records in key order stand for the rest. */
const MAX_EVIDENCE = 32;

/** `programs` are this release's program records joined with the catalog artifact's fields, as
 * program-departments.ts reads them; they place only departments that convene no course. */
export function linkSubjectSchools(entities: CampusIdentity[], courses: unknown, reference?: ReviewedSchools, programs: Row[] = []): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  if (!reference) return { linked: 0, unresolved };
  // Every name the catalog may file a course under, and the schools it means.
  const schoolsBy = new Map<string, Set<string>>();
  const add = (name: string, id: string) => { const key = text(name).toLowerCase(); if (key) schoolsBy.set(key, new Set([...schoolsBy.get(key) ?? [], id])); };
  for (const school of reference.schools) {
    add(school.name, school.id);
    for (const legacy of school.legacy_names) add(legacy.name, school.id);
    for (const college of school.catalog_colleges ?? []) add(college.name, school.id);
  }
  const placed = new Set(entities.filter(e => e.kind === 'school').map(e => e.id));
  const catalog = courses && typeof courses === 'object' && !Array.isArray(courses) ? courses as Row : {};
  const codes = Object.keys(catalog).sort();
  // Each record that files something under a college, with the evidence that it does.
  type Filed = { college: string; evidence: IdentityEvidence };
  const filedCourses = (keys: string[]): Filed[] => keys.map((key): Filed => ({ college: text((catalog[key] as Row | undefined)?.school),
    evidence: { collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: key, field: 'school', source_url: courseCatalogUrl(key) } }));
  const filedPrograms = (rows: Row[]): Filed[] => rows.filter(row => text(row.source_key) && text(row.source_record_key)).map((row): Filed => {
    const url = text(row.catalogUrl);
    return { college: text(row.school), evidence: { collection: 'programs', source_key: text(row.source_key), source_record_key: text(row.source_record_key), field: 'school', ...(/^https:\/\//.test(url) ? { source_url: url } : {}) } };
  });
  // The courses and programs that name each convening group, for departments with no course of their own code.
  const convened = new Map<string, string[]>();
  for (const key of codes) for (const group of convenedBy(catalog[key])) convened.set(group, [...convened.get(group) ?? [], key]);
  const naming = new Map<string, Row[]>();
  for (const row of programs) for (const group of convenedBy(row)) naming.set(group, [...naming.get(group) ?? [], row]);
  let linked = 0;
  for (const subject of entities.filter(e => e.kind === 'subject')) {
    const code = subject.links.find(l => l.collection === 'subjects')?.source_record_keys[0];
    if (!code) continue;
    const own = codes.filter(key => courseSubjectCode(key) === code);
    const [records, filing]: [Filed[], string] = own.length ? [filedCourses(own), 'Its courses are']
      : convened.has(subject.name) ? [filedCourses(convened.get(subject.name) ?? []), 'The courses it convenes are']
        : [filedPrograms(naming.get(subject.name) ?? []), 'The programs that name it as their convening group are'];
    const named = new Map<string, IdentityEvidence[]>();
    for (const { college, evidence } of records) if (college) named.set(college, [...named.get(college) ?? [], evidence]);
    if (!named.size) continue;
    const targets = new Set<string>();
    for (const college of named.keys()) for (const id of schoolsBy.get(college.toLowerCase()) ?? []) targets.add(id);
    const unknown = [...named.keys()].filter(college => !schoolsBy.has(college.toLowerCase()));
    if (unknown.length || targets.size !== 1) {
      unresolved.push({ entity: subject.name, collection: 'subjects', record: code, kind: 'missing_connection',
        reason: unknown.length ? `${filing} filed under ${unknown.map(c => `"${c}"`).join(', ')}, which is not one of the schools; the subject is not placed in a school.`
          : `${filing} filed under ${[...named.keys()].map(c => `"${c}"`).join(', ')}, which name ${targets.size} schools; the subject is not placed in one.` });
      continue;
    }
    const [school] = targets;
    if (!placed.has(school)) continue;
    const evidence = [...named.values()].flat()
      .sort((a, b) => (a.source_record_key < b.source_record_key ? -1 : a.source_record_key > b.source_record_key ? 1 : 0)).slice(0, MAX_EVIDENCE);
    subject.relationships ||= [];
    if (subject.relationships.some(r => r.type === 'part_of' && 'target_entity_id' in r && r.target_entity_id === school)) continue;
    subject.relationships.push({ type: 'part_of', target_entity_id: school, evidence });
    linked++;
  }
  return { linked, unresolved };
}
