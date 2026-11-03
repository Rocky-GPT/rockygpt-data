import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, courseCatalogUrl } from './course-identities';
import { convenedBy, courseSubjectCode } from './course-subjects';

/**
 * @module data-v2/subject-departments
 * A course subject is `part_of` the department that convenes all of its courses.
 *
 * The catalog names each course's Convening Group, the department that runs it (the course
 * record's `conveningGroups`): the LITR courses that name one all name English and Literary
 * Studies (ENLS), THEA and FILM courses Theater and Film (THFL), ARAB and CHIN courses Language
 * (LANG). A subject that is no catalog department of its own (no department has its code, so it is
 * named by its code: "LITR") is placed in the subject named exactly like the one group all of its
 * courses name, with those course records as evidence. A course with no group says nothing.
 *
 * Reported and not placed: a subject whose courses name two groups (PATHCA), and a group no subject
 * is named like. A subject that is itself a catalog department ("Geology (GEOL)") is never placed
 * in a second one; when its courses also name other groups, the report notes them.
 */

type Row = Record<string, unknown>;
/** Evidence is capped per relationship; the first course records in code order stand for the rest. */
const MAX_EVIDENCE = 32;

export function linkSubjectDepartments(entities: CampusIdentity[], courses: unknown): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const subjects = entities.filter(e => e.kind === 'subject');
  const named = new Map<string, string[]>();
  for (const subject of subjects) named.set(subject.name, [...named.get(subject.name) ?? [], subject.id]);
  const ids = new Set(subjects.map(subject => subject.id));
  const catalog = courses && typeof courses === 'object' && !Array.isArray(courses) ? courses as Row : {};
  const codes = Object.keys(catalog).sort();
  let linked = 0;
  for (const subject of subjects) {
    const code = subject.links.find(l => l.collection === 'subjects')?.source_record_keys[0];
    if (!code) continue;
    // The courses under the subject's code, by the convening group each names.
    const groups = new Map<string, string[]>();
    for (const key of codes.filter(key => courseSubjectCode(key) === code)) {
      for (const group of convenedBy(catalog[key])) groups.set(group, [...groups.get(group) ?? [], key]);
    }
    // No group, or only its own department's: nothing to place.
    if (!groups.size || (groups.size === 1 && groups.has(subject.name))) continue;
    const listed = [...groups].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
      .map(([group, keys]) => `"${group}" (${keys.length})`).join(', ');
    const report = (kind: IdentityCoverageIssue['kind'], reason: string) =>
      unresolved.push({ entity: subject.name, collection: 'subjects', record: code, kind, reason });
    if (subject.name !== code) {
      report('note', `Its courses name ${listed}, but it is itself the catalog department ${subject.name}; it is not placed in a second department.`);
      continue;
    }
    if (groups.size > 1) {
      report('missing_connection', `Its courses name ${groups.size} convening groups, ${listed}; the subject is not placed in a department.`);
      continue;
    }
    const [[group, keys]] = groups;
    const found = named.get(group) ?? [];
    if (found.length !== 1) {
      report('missing_connection', found.length ? `Its courses all name "${group}", which names ${found.length} subjects; the subject is not placed in one.`
        : `Its courses all name "${group}", which is not a subject in this release; the subject is not placed in a department.`);
      continue;
    }
    const [department] = found;
    if (department === subject.id) continue;
    subject.relationships ||= [];
    // One department per subject: a subject already placed in one gets no other.
    if (subject.relationships.some(r => r.type === 'part_of' && 'target_entity_id' in r && ids.has(r.target_entity_id))) continue;
    const evidence: IdentityEvidence[] = keys.slice(0, MAX_EVIDENCE)
      .map(key => ({ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: key, field: 'conveningGroups', source_url: courseCatalogUrl(key) }));
    subject.relationships.push({ type: 'part_of', target_entity_id: department, evidence });
    linked++;
  }
  return { linked, unresolved };
}
