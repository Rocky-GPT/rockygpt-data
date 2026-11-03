import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { ReviewedSchools } from './campus-schools';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, courseCatalogUrl } from './course-identities';
import { courseSubjectCode } from './course-subjects';

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
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
/** Evidence is capped per relationship; the first course records in code order stand for the rest. */
const MAX_EVIDENCE = 32;

export function linkSubjectSchools(entities: CampusIdentity[], courses: unknown, reference?: ReviewedSchools): { linked: number; unresolved: IdentityCoverageIssue[] } {
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
  let linked = 0;
  for (const subject of entities.filter(e => e.kind === 'subject')) {
    const code = subject.links.find(l => l.collection === 'subjects')?.source_record_keys[0];
    if (!code) continue;
    const named = new Map<string, string[]>();
    for (const key of codes.filter(key => courseSubjectCode(key) === code)) {
      const college = text((catalog[key] as Row | undefined)?.school);
      if (college) named.set(college, [...named.get(college) ?? [], key]);
    }
    if (!named.size) continue;
    const targets = new Set<string>();
    for (const college of named.keys()) for (const id of schoolsBy.get(college.toLowerCase()) ?? []) targets.add(id);
    const unknown = [...named.keys()].filter(college => !schoolsBy.has(college.toLowerCase()));
    if (unknown.length || targets.size !== 1) {
      unresolved.push({ entity: subject.name, collection: 'subjects', record: code, kind: 'missing_connection',
        reason: unknown.length ? `Its courses are filed under ${unknown.map(c => `"${c}"`).join(', ')}, which is not one of the schools; the subject is not placed in a school.`
          : `Its courses are filed under ${[...named.keys()].map(c => `"${c}"`).join(', ')}, which name ${targets.size} schools; the subject is not placed in one.` });
      continue;
    }
    const [school] = targets;
    if (!placed.has(school)) continue;
    const evidence: IdentityEvidence[] = [...named.values()].flat().sort().slice(0, MAX_EVIDENCE)
      .map(key => ({ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: key, field: 'school', source_url: courseCatalogUrl(key) }));
    subject.relationships ||= [];
    if (subject.relationships.some(r => r.type === 'part_of' && 'target_entity_id' in r && r.target_entity_id === school)) continue;
    subject.relationships.push({ type: 'part_of', target_entity_id: school, evidence });
    linked++;
  }
  return { linked, unresolved };
}
