import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, uuid5 } from './course-identities';
import { noteAlias, type AliasLedger } from './identity-aliases';
import { SOURCES } from './source-seeds';

/**
 * @module data-v2/course-subjects
 * Course subjects: the code at the front of every catalog course (CMPS in CMPS 147).
 *
 * Every course code starts with exactly one subject code, so a subject becomes an
 * identity when this release's catalog has a course under it. Its ID derives
 * from the code, so a renamed department keeps it. Each course is linked by an
 * `includes_course` relationship whose evidence is the course's own published code.
 *
 * The catalog's department list (`src/reference/course-subjects.json`, captured
 * from the catalog's departments API on the date in `course-subjects.source.json`)
 * names a subject when a department with the same code exists. The subject then
 * takes the catalog's own display form, "Computer Science (CMPS)". A code no
 * department names keeps the code as its name; no name is guessed from titles.
 *
 * Lookup (reviewed September 23, 2026): a subject answers to its code only. Its
 * catalog name ("Computer Science") and the curated short forms ("CS", "Psych")
 * still find programs in lookup; they mean courses only in course search, so the
 * artifact publishes them as search terms, not identity aliases.
 */

// Fixed namespace for subject IDs; a persistence contract, do not change.
const SUBJECT_NAMESPACE = Buffer.from('2482ef09f28749379fda96a1885d3530', 'hex');
export const COURSE_SUBJECTS_SOURCE_KEY = 'course-subjects';
const COURSE_CODE = /^([A-Z]{2,6}) \S+$/;

/** An entry of `src/reference/course-subjects.json`: a catalog department, or a curated code. */
export interface SubjectReference { code: string; name: string; aliases: string[] }
/** The reviewed subject list and where it was captured. */
export interface CourseSubjectsInput { source_url: string; captured_at: string; subjects: SubjectReference[] }
export interface CourseSubject {
  code: string;
  /** The catalog department's name for this code, or null when no department names it. */
  name: string | null;
  display_name: string;
  /** Curated short forms that mean this subject in course search; not lookup aliases. */
  search_terms: string[];
  course_count: number;
}
export interface CourseSubjectsArtifact {
  schema_version: 1;
  source: { source_key: string; title: string; canonical_url: string; trust_tier: string; freshness_sla_hours: number; domain: string };
  source_url: string | null;
  captured_at: string | null;
  subjects: CourseSubject[];
}

export const subjectIdentityId = (code: string): string => uuid5(SUBJECT_NAMESPACE, `catalog:subject:${code}`);

/** The committed subject list with its capture record, checked before it names anything. */
export function courseSubjectsInput(source: unknown, subjects: unknown): CourseSubjectsInput {
  const record = source as Record<string, unknown> | null;
  if (!record || typeof record.source_url !== 'string' || typeof record.captured_at !== 'string' || !Array.isArray(subjects)
    || !subjects.every(s => s && typeof s.code === 'string' && typeof s.name === 'string' && Array.isArray(s.aliases) && s.aliases.every((a: unknown) => typeof a === 'string'))) {
    throw new Error('Expected the course subject list and its capture record.');
  }
  return { source_url: record.source_url, captured_at: record.captured_at, subjects: subjects as SubjectReference[] };
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** The subject code of a catalog course key such as "CMPS 147", or null. */
export function courseSubjectCode(courseKey: string): string | null {
  return COURSE_CODE.exec(courseKey)?.[1] ?? null;
}

/** Subjects of this release's catalog, named by the reviewed department list. */
export function courseSubjectsArtifact(courses: unknown, input?: CourseSubjectsInput): { artifact: CourseSubjectsArtifact; unresolved: IdentityCoverageIssue[] } {
  const seed = SOURCES.find(source => source.key === COURSE_SUBJECTS_SOURCE_KEY);
  if (!seed) throw new Error('The course-subjects source seed is missing.');
  const source = { source_key: seed.key, title: seed.title, canonical_url: seed.url, trust_tier: seed.trustTier, freshness_sla_hours: seed.freshnessHours, domain: seed.domain };
  // Without the reviewed subject list there are no subjects, as with schools.
  if (!input) return { artifact: { schema_version: 1, source, source_url: null, captured_at: null, subjects: [] }, unresolved: [] };
  const unresolved: IdentityCoverageIssue[] = [];
  const counts = new Map<string, number>();
  for (const key of Object.keys(courses && typeof courses === 'object' ? courses : {})) {
    const code = courseSubjectCode(key);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    else unresolved.push({ collection: 'courses', record: key, reason: 'The course code has no leading subject code; it is not placed in a subject.' });
  }
  const reference = new Map(input.subjects.map(subject => [text(subject.code), subject]));
  const subjects: CourseSubject[] = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, count]) => {
    const name = text(reference.get(code)?.name) || null;
    if (!name) unresolved.push({ entity: code, collection: 'subjects', record: code, reason: 'The catalog department list publishes no name for this subject code; the subject is named by its code.' });
    return { code, name, display_name: name ? `${name} (${code})` : code, search_terms: [...new Set((reference.get(code)?.aliases ?? []).map(text).filter(Boolean))], course_count: count };
  });
  for (const [code, subject] of reference) {
    if (!counts.has(code)) unresolved.push({ entity: text(subject.name) || code, collection: 'subjects', record: code, reason: 'No course in this release\'s catalog carries this subject code; no subject identity is created.' });
  }
  return {
    artifact: { schema_version: 1, source, source_url: input.source_url, captured_at: input.captured_at, subjects },
    unresolved,
  };
}

/** Subject identities answering to their code, each including its courses. */
export function compileSubjectIdentities(artifact: CourseSubjectsArtifact, courses: unknown, ledger: AliasLedger = new Map()): CampusIdentity[] {
  const keys = Object.keys(courses && typeof courses === 'object' ? courses : {}).sort();
  return artifact.subjects.map(subject => {
    const id = subjectIdentityId(subject.code);
    const aliases = subject.display_name === subject.code ? [] : [subject.code];
    for (const alias of aliases) noteAlias(ledger, id, alias, { basis: 'subject_code' });
    return {
      id, kind: 'subject', name: subject.display_name, aliases,
      links: [{ collection: 'subjects', source_key: artifact.source.source_key, source_record_keys: [subject.code] }],
      relationships: keys.filter(key => courseSubjectCode(key) === subject.code).map(key => ({
        type: 'includes_course' as const,
        target_record: { collection: 'courses' as const, source_key: COURSE_SOURCE_KEY, source_record_key: key },
        evidence: [{ collection: 'courses' as const, source_key: COURSE_SOURCE_KEY, source_record_key: key, field: 'code' }],
      })),
    };
  });
}
