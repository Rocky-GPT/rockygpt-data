import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, courseCatalogUrl, pythonJsonStrings, uuid5 } from './course-identities';
import { catalogCourses } from './course-requisites';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';
import { noteAlias, type AliasLedger } from './identity-aliases';

/**
 * @module data-v2/course-attributes
 * The attributes the catalog prints on its courses, each a node its courses are filed under.
 *
 * A catalog course record lists its attributes as the catalog prints them, each ending in its
 * code in parentheses: "WRITING INTENSIVE (WRIT)", "Gen Ed 18-Global Awareness (GEGA)",
 * "Capstone Course (CPST)".
 *
 * - Each code is a `course_attribute` node, its ID derived from the code, named by the printed
 *   text exactly ("GE18 Syst,Sust&Soc/SocSys&Soct (GESS)"): no source spells an abbreviation
 *   out, so none is expanded. Its `course_attributes` record gives its name and course count.
 * - A course is `in_category` each attribute its own record prints; the evidence is that record's
 *   `attributes` field and the course's catalog page.
 * - The graduate fee assessment flags ("MBA COURSE FOR GRAD FEE ASSESS (MBA)") are internal
 *   billing flags, not something a course is about: each is reported once as a note, not linked.
 * - An attribute printed without a code in parentheses is reported; no code is guessed for it.
 * - A node also answers to its code, unless the code is a word of another node's name or alias,
 *   which a lookup by the code would find too: WRIT is the Writing subject's code and DNP ends the
 *   program name "Nursing Practice DNP", so those two keep only their printed names, with a note.
 * - A code printed two ways is one node, named the way most of its courses print it, with a note.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);
const CODE = /\(([A-Z0-9]{2,8})\)$/;
// "MBA COURSE FOR GRAD FEE ASSESS (MBA)", "DATA COURSE FOR GRAD FEE ASSES (MDAT)", "MSAC COURSE FOR GRAD FEE ASMNT (MSAC)".
const GRAD_FEE = /GRAD FEE AS/i;
// A name's words, case and punctuation aside.
const fold = (value: string): string => (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ');
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The catalog's course search, which the catalog capture reads every course from (ingestion/scrape-catalog-api.ts). */
export const COURSE_SEARCH_URL = 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos/courses/search/%24filters';

export const courseAttributeId = (code: string): string =>
  uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'course_attribute', COURSE_SOURCE_KEY, code]));

/** The code in the parentheses that end a printed attribute ("WRITING INTENSIVE (WRIT)" gives WRIT), or null. */
export function attributeCode(printed: string): string | null {
  return CODE.exec(printed)?.[1] ?? null;
}

/**
 * `course_attribute` nodes and their records, and `in_category` from each catalog course to the
 * attributes its record prints. `courses` is the release's `courses` artifact; a course identity is
 * found by the code its `courses` record link names. A code becomes an alias only when no name or
 * alias in `entities` has it as a word, so run this once the rest of the registry has its aliases.
 */
export function linkCourseAttributes(entities: CampusIdentity[], courses: unknown, collectedAt = '', ledger: AliasLedger = new Map()):
  { entities: CampusIdentity[]; records: GraphRecordCollectionData; linked: number; unresolved: IdentityCoverageIssue[] } {
  const byCode = catalogCourses(entities);
  const unresolved: IdentityCoverageIssue[] = [];
  const forms = new Map<string, Map<string, number>>(); // attribute code -> printed text -> courses
  const carriers = new Map<string, Set<string>>(); // attribute code -> course codes
  const fees = new Map<string, number>(); // printed fee flag -> courses
  const uncoded = new Map<string, string[]>(); // printed text with no code -> course codes
  const filed: Array<{ course: CampusIdentity; code: string; attribute: string }> = [];
  for (const [code, value] of Object.entries(record(courses)).sort(byKey)) {
    const course = byCode.get(code);
    if (!course) continue;
    const listed = record(value).attributes;
    for (const printed of new Set((Array.isArray(listed) ? listed : []).map(text).filter(Boolean))) {
      if (GRAD_FEE.test(printed)) { fees.set(printed, (fees.get(printed) ?? 0) + 1); continue; }
      const attribute = attributeCode(printed);
      if (!attribute) { uncoded.set(printed, [...uncoded.get(printed) ?? [], code]); continue; }
      const printedAs = forms.get(attribute) ?? new Map<string, number>();
      printedAs.set(printed, (printedAs.get(printed) ?? 0) + 1);
      forms.set(attribute, printedAs);
      const carrying = carriers.get(attribute) ?? new Set<string>();
      carrying.add(code);
      carriers.set(attribute, carrying);
      filed.push({ course, code, attribute });
    }
  }
  const nodes = new Map<string, CampusIdentity>();
  for (const [attribute, printedAs] of [...forms].sort(byKey)) {
    const ranked = [...printedAs].sort((a, b) => b[1] - a[1] || byKey(a, b));
    const name = ranked[0][0];
    if (ranked.length > 1) {
      unresolved.push({ entity: name, collection: 'course_attributes', record: attribute, kind: 'note',
        reason: `The catalog prints this code ${ranked.length} ways (${ranked.map(([form, count]) => `"${form}" on ${plural(count, 'course')}`).join(', ')}); its node is named the way most of its courses print it.` });
    }
    nodes.set(attribute, { id: courseAttributeId(attribute), kind: 'course_attribute', name, aliases: [],
      links: [{ collection: 'course_attributes', source_key: COURSE_SOURCE_KEY, source_record_keys: [attribute] }] });
  }
  // Every word of every name and alias, with the nodes whose name or alias has it. A code is an
  // alias only where no other node's name or alias has it as a word: a lookup by it would find
  // that node too (WRIT is the Writing subject's alias, DNP ends the program "Nursing Practice DNP").
  const words = new Map<string, CampusIdentity[]>();
  for (const entity of [...entities, ...nodes.values()]) {
    for (const word of new Set([entity.name, ...entity.aliases].flatMap(name => fold(name).split(' ')).filter(Boolean))) {
      const having = words.get(word) ?? [];
      having.push(entity);
      words.set(word, having);
    }
  }
  for (const [attribute, node] of nodes) {
    const key = fold(attribute);
    const exact = (other: CampusIdentity) => [other.name, ...other.aliases].some(name => fold(name) === key);
    const others = (words.get(key) ?? []).filter(other => other.id !== node.id).sort((a, b) => Number(exact(b)) - Number(exact(a)));
    if (others.length) {
      const named = others.slice(0, 3).map(other => `the ${other.kind.replace(/_/g, ' ')} "${other.name}"`).join(', ');
      unresolved.push({ entity: node.name, collection: 'course_attributes', record: attribute, kind: 'note',
        reason: `${attribute} is already in the name or an alias of ${named}${others.length > 3 ? ` and ${others.length - 3} more` : ''}, so it is not made an alias of this attribute; the attribute answers to its printed name only.` });
      continue;
    }
    if (key === fold(node.name)) continue;
    node.aliases = [attribute];
    noteAlias(ledger, node.id, attribute, { basis: 'abbreviation' });
  }
  let linked = 0;
  for (const { course, code, attribute } of filed) {
    const target = nodes.get(attribute);
    if (!target) continue;
    course.relationships ||= [];
    if (course.relationships.some(r => r.type === 'in_category' && 'target_entity_id' in r && r.target_entity_id === target.id)) continue;
    course.relationships.push({ type: 'in_category', target_entity_id: target.id, evidence: [
      { collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: code, field: 'attributes', source_url: courseCatalogUrl(code) }] });
    linked++;
  }
  for (const [printed, count] of [...fees].sort(byKey)) {
    const attribute = attributeCode(printed);
    unresolved.push({ entity: printed, collection: 'course_attributes', ...(attribute ? { record: attribute } : {}), kind: 'note',
      reason: `An internal billing flag (graduate fee assessment) the catalog prints on ${plural(count, 'course')}; it is not linked.` });
  }
  for (const [printed, codes] of [...uncoded].sort(byKey)) {
    unresolved.push({ entity: printed, collection: 'courses', kind: 'missing_connection',
      reason: `The catalog prints this attribute on ${plural(codes.length, 'course')} (${codes.slice(0, 5).join(', ')}${codes.length > 5 ? ` and ${codes.length - 5} more` : ''}) without a code in parentheses; no code is guessed for it, so no course is linked to it.` });
  }
  const rows: GraphRecordRow[] = [...nodes].map(([attribute, node]) => ({ source_record_key: attribute, name: node.name,
    course_count: carriers.get(attribute)?.size ?? 0, source_url: COURSE_SEARCH_URL }));
  return { entities: [...nodes.values()], records: { source_key: COURSE_SOURCE_KEY, collected_at: collectedAt, rows }, linked, unresolved };
}
