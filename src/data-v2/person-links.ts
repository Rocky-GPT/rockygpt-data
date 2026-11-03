import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { normalizeName } from './archway-identities';
import { campusBuildingId, roomBuildings, type CampusBuildingsArtifact } from './campus-buildings';
import { siteFolder } from './office-sections';
import { staffSpansInSection, type StaffSpan } from './office-staff';
import { normalizeOffice } from '../directory/contact-normalizer';
import type { SubjectReference } from './course-subjects';
import reviewedPersonRooms from '../reference/reviewed-person-rooms.json';

/**
 * @module data-v2/person-links
 * Where a person belongs and sits, from what their own records and the pages that list them say.
 * Run once schools, subjects, buildings, office pages and office staff are in the registry.
 *
 * - `part_of` a subject (the catalog department): the department a current professor's own
 *   profile names, in its title ("Associate Professor of Chemistry", "Lecturer, Finance", "Chemistry
 *   Lecturer"; a specialty in parentheses after it is dropped) or in its "Convening Group" lines
 *   ("Psychology (primary)"). The words must be the catalog's own name of exactly one department
 *   that has a subject in this release ("Chemistry" for Chemistry (CHEM)); "X and Y" names each
 *   only when both are department names. A name two subjects, or two codes of the catalog's
 *   department list, share names neither ("Data Science": DATA and DSCI). A retired profile names none.
 * - `listed_by` an office: a person whose faculty record was read from that office's own site (the
 *   Library's staff, from its staff page), when exactly one node links that site's captured pages.
 * - `office_at` a building, for a person no room places yet: the room their profile's own text gives
 *   when its office field is empty ("Office: AC-210B"); else a room an office page that lists them
 *   prints between their name and their own address ("Abbe Benowitz (C208) ... abenowit@"), or under
 *   an "Office:" label right after their address and phone in a section whose entries each end that
 *   way (its last one does, so the label closes an entry and never opens the next); else a reviewed
 *   room (reviewed-person-rooms.json) while this run's capture still says it. A room places someone
 *   only by a reviewed building prefix, and every room read for one person must name one building.
 */

type Row = Record<string, unknown>;
type Relation = 'part_of' | 'listed_by' | 'office_at';
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** One room an office's page gives one person, with the section and words that say so. */
export interface ReviewedPersonRoom { person_id: string; person: string; room: string; url: string; section: string; quote: string; reviewed_at: string; note: string }
export interface ReviewedPersonRooms { schema_version: 1; rooms: ReviewedPersonRoom[] }
export interface PeopleLinks { linked: Record<Relation, number>; unresolved: IdentityCoverageIssue[] }

/** Nodes whose own captured pages can list a person. */
const OWNER_KINDS = ['office', 'venue', 'facility', 'organization', 'club'];
/** "Assistant Professor of Economics", "Lecturer, Finance", "Associate Professor Management". */
const RANK_FIRST = /^(?:(?:Assistant|Associate|Adjunct|Visiting|Distinguished|Clinical)\s+)*(?:Professor|Lecturer|Instructor)(?:\s+of\s+|\s*,\s*|\s+)(.+)$/i;
/** "Chemistry Lecturer". */
const RANK_LAST = /^(.+?)\s+(?:Professor|Lecturer|Instructor)$/i;
/** The faculty directory's status suffix on the school, as campus-schools.ts reads it. */
const RETIRED = /\(Retired\)$/;
/** A room code as pages print it: "C208", "D 104", "SC-202C", "LC-406B". */
const ROOM = String.raw`([A-Z]{1,4})[ -]?(\d{3})([A-Z])?`;
/** A room a page prints between a name and its address: under a label ("Office: SC-214", "Office
 * Location: D-104"), in parentheses ("(C208)") or in the college's address ("505 Ramapo Valley Road, D-216"). */
const BESIDE_NAME = new RegExp(String.raw`\b(?:Office|Location)\s*:\s*${ROOM}\b|\(${ROOM}\)|Ramapo Valley Road,?\s+${ROOM}\b`, 'g');
/** What may stand between an address and a room labeled after it: punctuation and a phone number. */
const BEFORE_LABEL = /^(?:[\s;,.|]+|(?:Phone|Telephone|Tel)\.?\s*:?|\(?\d{3}\)?[\s.-]*\d{3}\s*[-–.]\s*\d{4})/i;
const LABELED = new RegExp(String.raw`^(?:Office(?: Location)?|Location)\s*:\s*${ROOM}\b`);
const roomCode = (parts: Array<string | undefined>): string => `${parts[0]}-${parts[1]}${parts[2] ?? ''}`;

/** Rooms a page prints between a name and its address. */
export function roomsBesideName(between: string): string[] {
  return [...between.matchAll(BESIDE_NAME)].map(match => roomCode(match.slice(1).filter(Boolean)));
}

/** The room labeled right after a person's own address, with only the address again, a phone and
 * punctuation between them ("jyao@ramapo.edu ; Office: D-207"); anything else ends the person's entry. */
export function roomAfterAddress(after: string, email: string): string | null {
  let rest = after;
  for (let previous = ''; previous !== rest;) {
    previous = rest;
    rest = rest.replace(BEFORE_LABEL, '');
    if (rest.toLowerCase().startsWith(email)) rest = rest.slice(email.length);
  }
  const match = LABELED.exec(rest);
  return match ? roomCode(match.slice(1)) : null;
}
const pageKeyOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
const httpsUrl = (url: string): { source_url?: string } => /^https:\/\/\S+$/.test(url) ? { source_url: url } : {};
const words = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
const evidenceKey = (e: IdentityEvidence): string => [e.collection, e.source_key, e.source_record_key, e.field].join('\n');

/** The part of a title after its rank that names a field: "Economics , GLO Research Fellow" is Economics. */
function field(value: string): string {
  return value.split(',')[0].split(/\s+[-–—]\s+/)[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** The fields a title names after a rank, one per role ("Dean of SNH / Professor of Chemistry"). */
export function titleFields(title: string): string[] {
  return title.split('/').map(part => part.trim()).flatMap(part => {
    const named = RANK_FIRST.exec(part)?.[1] ?? RANK_LAST.exec(part)?.[1];
    return named && field(named) ? [field(named)] : [];
  });
}

/** The lines of a profile's "Convening Group(s)" list, in order, the first on the label's own line. */
export function convenedFields(bio: string): string[] {
  const lines = bio.split('\n').map(line => line.trim());
  const at = lines.findIndex(line => /^Convening Groups?\b/i.test(line));
  if (at < 0) return [];
  const inline = lines[at].replace(/^Convening Groups?\s*:?\s*/i, '');
  return [...(inline ? [inline] : []), ...lines.slice(at + 1).filter(Boolean)].map(line => line.replace(/\s*\([^)]*\)\s*$/, '').trim());
}

/** office_at, listed_by and part_of links for people; see the module comment. */
export function linkPeople(entities: CampusIdentity[], records: Map<string, Row>, pages: Row[], buildings: CampusBuildingsArtifact,
  catalog: Array<Pick<SubjectReference, 'code' | 'name'>> = [], reviewed: ReviewedPersonRooms = reviewedPersonRooms as ReviewedPersonRooms): PeopleLinks {
  const unresolved: IdentityCoverageIssue[] = [];
  const linked: Record<Relation, number> = { part_of: 0, listed_by: 0, office_at: 0 };
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const relate = (entity: CampusIdentity, type: Relation, target: string, evidence: IdentityEvidence[]) => {
    entity.relationships ||= [];
    const held = entity.relationships.find(r => r.type === type && 'target_entity_id' in r && r.target_entity_id === target);
    if (!held) {
      entity.relationships.push({ type, target_entity_id: target, evidence: evidence.slice(0, 32) });
      linked[type]++;
      return;
    }
    for (const item of evidence) if (held.evidence.length < 32 && !held.evidence.some(e => evidenceKey(e) === evidenceKey(item))) held.evidence.push(item);
  };
  const placed = (person: CampusIdentity) => (person.relationships ?? []).some(r => r.type === 'office_at');

  // Departments: each subject by the catalog's own name, "Chemistry" in "Chemistry (CHEM)".
  const subjects = new Map<string, string[]>();
  for (const subject of entities.filter(e => e.kind === 'subject')) {
    const [, name, code] = /^(.+) \(([A-Z]{2,6})\)$/.exec(subject.name) ?? [];
    if (!name || !subject.links.some(link => link.collection === 'subjects' && link.source_record_keys.includes(code))) continue;
    subjects.set(normalizeName(name), [...subjects.get(normalizeName(name)) ?? [], subject.id]);
  }
  // A name the catalog's department list gives several codes ("Data Science": DATA and DSCI) is
  // shared even while only one of them has courses, and so a subject, in this release.
  const codes = new Map<string, Set<string>>();
  for (const department of catalog) {
    const name = normalizeName(text(department.name));
    if (name) codes.set(name, new Set([...codes.get(name) ?? [], text(department.code)]));
  }
  const subjectNamed = (value: string): { id?: string; shared?: true } => {
    const ids = subjects.get(normalizeName(value)) ?? [];
    if (ids.length > 1 || (codes.get(normalizeName(value))?.size ?? 0) > 1) return { shared: true };
    return ids.length ? { id: ids[0] } : {};
  };
  const departments = (value: string): { ids: string[]; shared: string[] } => {
    const whole = subjectNamed(value);
    if (whole.id || whole.shared) return whole.id ? { ids: [whole.id], shared: [] } : { ids: [], shared: [value] };
    // "X and Y" names two when each part is a department's name; a part several share links none.
    const parts = value.split(/\s+(?:and|&)\s+/i).map(part => part.trim());
    const found = parts.map(subjectNamed);
    if (parts.length < 2 || !found.every(part => part.id || part.shared)) return { ids: [], shared: [] };
    return { ids: found.flatMap(part => part.id ? [part.id] : []), shared: parts.filter((_, index) => found[index].shared) };
  };

  // Offices by the site folder of the pages they link; a folder two nodes link is no one's.
  const folderOwners = new Map<string, Set<string>>();
  for (const owner of entities.filter(e => OWNER_KINDS.includes(e.kind))) {
    for (const key of owner.links.filter(l => l.collection === 'office_sections').flatMap(l => l.source_record_keys)) {
      const folder = siteFolder(`https://${key}`);
      if (folder) folderOwners.set(folder, new Set([...folderOwners.get(folder) ?? [], owner.id]));
    }
  }

  // Rooms place people by the reviewed room prefixes and readings, as their contact rooms do.
  const byPrefix = new Map(buildings.buildings.flatMap(building => building.room_prefixes.map(prefix => [prefix, campusBuildingId(building)] as const)));
  const byReading = new Map(buildings.buildings.flatMap(building => (building.reviewed_rooms ?? []).map(room => [room, campusBuildingId(building)] as const)));
  const building = (room: string): string | null => {
    const found = roomBuildings(room, byPrefix, byReading);
    return found && 'buildings' in found && found.buildings.length === 1 ? found.buildings[0] : null;
  };

  const people = entities.filter(e => e.kind === 'person');
  for (const person of people) {
    const faculty = person.links.filter(l => l.collection === 'faculty')
      .flatMap(link => link.source_record_keys.flatMap(key => {
        const row = records.get(`faculty:${link.source_key}:${key}`);
        return row ? [{ source: link.source_key, key, row }] : [];
      }));
    for (const { source, key, row } of faculty) {
      const url = text(row.profileUrl);
      const evidence = (name: string): IdentityEvidence => ({ collection: 'faculty', source_key: source, source_record_key: key, field: name, ...httpsUrl(url) });
      const retired = RETIRED.test(text(row.school)) || person.status?.state === 'retired';
      if (!retired) {
        const found = new Map<string, IdentityEvidence[]>();
        const add = (ids: string[], name: string) => {
          for (const id of ids) if (!found.get(id)?.some(e => e.field === name)) found.set(id, [...found.get(id) ?? [], evidence(name)]);
        };
        const shared = (name: string, where: string) => unresolved.push({ entity: person.name, collection: 'faculty', record: key,
          reason: `The profile's ${where} names "${name}", the catalog's name of more than one department; no department is linked by it.`, kind: 'missing_connection' });
        for (const named of titleFields(text(row.title))) {
          const result = departments(named);
          add(result.ids, 'title');
          for (const name of result.shared) shared(name, 'title');
        }
        // The list runs while each line is one department; "Women, Gender & Sexuality Studies" or the next heading ends it.
        for (const named of convenedFields(typeof row.bio === 'string' ? row.bio : '')) {
          const result = departments(named);
          for (const name of result.shared) shared(name, 'convening list');
          if (!result.ids.length) break;
          add(result.ids, 'bio');
        }
        for (const [subject, references] of found) relate(person, 'part_of', subject, references);
        const owners = [...folderOwners.get(siteFolder(url) ?? '') ?? []];
        const office = owners.length === 1 ? byId.get(owners[0]) : undefined;
        if (office?.kind === 'office') relate(person, 'listed_by', office.id, [evidence('profileUrl')]);
      }
      // The profile's own words give its room when the office field is empty ("Office: AC-210B").
      const line = text(row.office) ? undefined : /^\s*Office(?: Location)?\s*:\s*(\S[^\n]*)$/im.exec(typeof row.bio === 'string' ? row.bio : '')?.[1];
      if (line && !placed(person)) {
        const target = building(normalizeOffice(line));
        if (target) relate(person, 'office_at', target, [evidence('bio')]);
        else unresolved.push({ entity: person.name, collection: 'faculty', record: key, reason: `The profile's own text gives the room "${text(line)}", which has no reviewed building prefix; no building is inferred.`, kind: 'missing_connection' });
      }
    }
  }

  const byKey = new Map(pages.map(page => [text(page.source_record_key), page]));
  const sectionsOf = (page: Row | undefined): Row[] => Array.isArray(page?.sections) ? (page.sections as unknown[]).filter((s): s is Row => Boolean(s) && typeof s === 'object') : [];

  // Rooms the pages that list a person print beside their name and own address.
  const spans = new Map<string, StaffSpan[][]>();
  const spansOf = (key: string): StaffSpan[][] => {
    if (!spans.has(key)) spans.set(key, sectionsOf(byKey.get(key)).map(section => staffSpansInSection(text(section.heading), text(section.text))));
    return spans.get(key)!;
  };
  for (const person of people.filter(candidate => !placed(candidate))) {
    const emails = new Set(person.links.flatMap(link => link.source_record_keys.flatMap(key => {
      const address = link.collection === 'staff' ? key : /#email=([^#&]+@ramapo\.edu)$/i.exec(key)?.[1] ?? text(records.get(`${link.collection}:${link.source_key}:${key}`)?.email);
      return /@ramapo\.edu$/i.test(address) ? [address.toLowerCase()] : [];
    })));
    const listing = [...new Set((person.relationships ?? []).filter(r => r.type === 'listed_by')
      .flatMap(r => r.evidence).filter(e => e.collection === 'office_sections').map(e => e.source_record_key))].sort();
    const found = new Map<string, IdentityEvidence[]>();
    for (const key of listing) {
      const page = byKey.get(key);
      for (const section of spansOf(key)) {
        // A room right after an address is that person's when each entry ends with its room, as the
        // section's last entry shows ("... E-mail: jyao@ Phone: ... Office: D-207"); in a section that
        // opens each entry with a room instead, it would be the next person's.
        const afters = section.map(span => roomAfterAddress(span.after, span.email));
        const endsWithRoom = afters[afters.length - 1] !== null;
        for (const [index, span] of section.entries()) {
          if (!emails.has(span.email)) continue;
          const after = endsWithRoom ? afters[index] : null;
          const rooms = [...new Set([...roomsBesideName(span.between), ...after ? [after] : []])];
          if (!rooms.length) continue;
          const targets = new Set(rooms.map(building));
          if (targets.has(null) || targets.size !== 1) {
            unresolved.push({ entity: person.name, collection: 'office_sections', record: key, reason: `The page gives ${person.name} the room ${rooms.join(', ')}, which does not name one building by a reviewed prefix; no building is inferred.`, kind: 'missing_connection' });
            continue;
          }
          const [target] = [...targets] as string[];
          const evidence: IdentityEvidence = { collection: 'office_sections', source_key: text(page?.source_key) || 'office-pages', source_record_key: key, field: 'sections', ...httpsUrl(text(page?.url)) };
          if (!(found.get(target) ?? []).some(e => e.source_record_key === key)) found.set(target, [...found.get(target) ?? [], evidence]);
        }
      }
    }
    if (found.size > 1) {
      unresolved.push({ entity: person.name, collection: 'office_sections', reason: `The pages that list ${person.name} give rooms in ${found.size} buildings; none is chosen.`, kind: 'missing_connection' });
      continue;
    }
    for (const [target, evidence] of found) relate(person, 'office_at', target, evidence);
  }

  // Reviewed rooms, while this run's capture of the section still says them.
  for (const entry of reviewed.rooms) {
    const key = pageKeyOf(entry.url);
    const issue = (reason: string) => unresolved.push({ entity: entry.person, collection: 'office_sections', record: key, reason, kind: 'missing_connection' });
    const person = byId.get(entry.person_id);
    if (!person || person.kind !== 'person' || person.name !== entry.person || entities.filter(e => e.name === entry.person).length !== 1) { issue(`The reviewed room names ${entry.person}, who must be exactly one person node with that ID and name; nothing is placed.`); continue; }
    const page = byKey.get(key);
    const said = sectionsOf(page).some(section => text(section.heading) === entry.section && words(text(section.text)).includes(words(entry.quote)));
    if (!said || !words(entry.quote).includes(words(entry.room))) { issue(`The section "${entry.section}" of ${entry.url} is not in this capture or no longer gives ${entry.person} the room ${entry.room}; the room is withheld.`); continue; }
    const target = building(entry.room);
    if (!target) { issue(`The reviewed room ${entry.room} has no reviewed building prefix; nothing is placed.`); continue; }
    const held = (person.relationships ?? []).filter(r => r.type === 'office_at' && 'target_entity_id' in r && r.target_entity_id !== target);
    if (held.length) { issue(`${entry.person}'s own records now place them in another building than ${entry.room}; the reviewed room is withheld.`); continue; }
    relate(person, 'office_at', target, [{ collection: 'office_sections', source_key: text(page?.source_key) || 'office-pages', source_record_key: key, field: 'sections', source_url: entry.url }]);
  }
  return { linked, unresolved };
}
