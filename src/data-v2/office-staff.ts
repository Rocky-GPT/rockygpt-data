import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';

/**
 * @module data-v2/office-staff
 * Office staff: a person is `listed_by` each office whose own site lists them, with the title that
 * page gives them. "Listed by" says only what the page says: a dean named on the advising site is
 * listed by it, not employed in it; the person's `staff` record keeps each page's title.
 *
 * A person is read from an office's captured page only where the page prints a name right before
 * that person's own ramapo.edu address, and the address is that name's: the first initial and the
 * start of the last name ("David C. Nast" and dnast@, "Gina Mayer-Costa" and gmayerco@), or the
 * last name alone ("Ashwani Vasishth" and vasishth@). A shared mailbox (admissions@, oss@) names
 * nobody, so nobody is read from it. The words between the name and the address are the person's
 * title on that page when they read as one ("Director", "Specialized Services Coordinator").
 *
 * A person the graph already has (a faculty member whose record carries the same address, or a
 * person with the same name) gets the link; anyone else is a `person` node of their own, keyed by
 * address, with a `staff` record of the names, addresses and titles their offices' pages print.
 * A page two offices share names no office, so it adds nobody.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const fold = (value: string): string => value.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');

export const staffIdentityId = (email: string): string => uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'person', 'office-staff', email]));

const EMAIL = /\b([a-z][a-z0-9]{1,15})@ramapo\.edu\b/gi;
/** Words a name never holds: labels, titles and the places the pages print near a name. */
const NOT_NAME = new Set(['the', 'contact', 'email', 'e-mail', 'mail', 'phone', 'call', 'text', 'office', 'center', 'college', 'ramapo',
  'hall', 'program', 'programs', 'club', 'desk', 'director', 'dean', 'coordinator', 'assistant', 'associate', 'senior', 'co-chair',
  'chair', 'professor', 'advisor', 'counselor', 'manager', 'headshot', 'head', 'shot', 'of', 'and', 'for', 'new', 'jersey', 'school',
  'services', 'student', 'students', 'admissions', 'ext', 'fax', 'room', 'building', 'liaison', 'staff', 'team', 'meet', 'about',
  // Words the pages print in a title or a mailbox's label, right next to a name.
  'instagram', 'facebook', 'twitter', 'logo', 'join', 'annual', 'its', 'budget', 'graduate', 'young', 'analyst', 'president', 'vice',
  'treasurer', 'vp', 'avp', 'data', 'assoc', 'dir', 'campus', 'minister', 'event', 'events', 'graphic', 'artist', 'gifts', 'processor',
  'web', 'telecom', 'service', 'accounts', 'payable', 'generalist', 'poer', 'hr', 'operations', 'benefits', 'talent', 'fire', 'safety',
  'science', 'nursing', 'arts', 'humanities', 'social', 'ms', 'lms', 'graduation', 'scholarship', 'specialist', 'financial', 'aid',
  'advancement', 'executive', 'deputy', 'strategic', 'first-year', 'experience', 'employer', 'engagement', 'procurement', 'serials',
  'psychological', 'oss', 'athletics', 'secretarial', 'tutoring', 'controller', 'interim', 'sr', 'jr', 'contact:', 'help', 'helpdesk',
  'academic', 'chief', 'assessment', 'associate', 'communications', 'marketing', 'foundation', 'business']);
/** Pages of student groups: their officers are students, not an office's staff. */
const STUDENT_PAGES = /\/(greek\/chapters-councils|ministries|clubs|sga)\//;
/** Name prefixes a capital follows inside one name (McGarvey, DeBenedetto, LaQuan). */
const NAME_PREFIX = /^(mc|mac|de|di|da|la|le|van|von|o['’])$/i;
const ROLE = /\b(director|coordinator|counselor|advisor|adviser|librarian|specialist|dean|provost|president|manager|secretary|officer|analyst|assistant|associate|liaison|psychiatrist|administrator|chair|controller|accountant|technician|architect|designer|artist|bursar|registrar|recruiter|nurse|chaplain|minister|supervisor|clerk|chief|head|lead|editor|developer|engineer|planner|trainer|consultant|ombuds\w*)\b/i;
const DEGREES = /,?\s*\b(Ph\.?\s?D|Psy\.?\s?D|Ed\.?\s?D|D\.?O|M\.?D|DSW|LCSW|LCADC|LPC|MSW|MIA|MBA|MFA|MPA|MA|MS|M\.S|M\.Ed|J\.?D|Esq|PHR|RN|APN|MSN|CPA)\b\.?/g;

/** "KashianDirector" → "Kashian Director"; "McGarvey" and "DeBenedetto" stay one word. */
function unglue(token: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i < token.length; i++) {
    if (/[a-z]/.test(token[i - 1]) && /[A-Z]/.test(token[i]) && /[a-z]/.test(token[i + 1] ?? '')) {
      const part = token.slice(start, i);
      if (part.length >= 3 && !NAME_PREFIX.test(part.split(/[-'’]/).pop() ?? part)) { parts.push(part); start = i; }
    }
  }
  return [...parts, token.slice(start)];
}

const nameWord = (word: string): boolean => /^[A-Z][a-zA-Z'’-]*[a-z'’-][a-zA-Z'’-]*$|^[A-Z][A-Z'’-]+$|^[A-Z]\.$/.test(word) && !NOT_NAME.has(word.toLowerCase());
const initial = (word: string): boolean => /^[A-Z]\.$/.test(word);

/** Whether this address is the name's own: first initial and the start of the last name. */
export function addressFits(name: string[], local: string): boolean {
  const stem = local.toLowerCase().replace(/\d+$/, '');
  const words = name.filter(word => !initial(word)).map(fold).filter(Boolean);
  if (words.length < 2 || stem.length < 4) return false;
  const [first] = words;
  // The last name is the last word, or the last two ("Hicks McGowan"); a hyphenated one folds whole.
  // The address reaches into the last word either way, so a title word after a name never fits.
  const last = words[words.length - 1];
  const pair = words.length >= 3 ? words.slice(-2).join('') : '';
  return (first[0] + last).startsWith(stem)
    || (Boolean(pair) && stem.length > 1 + words[words.length - 2].length && (first[0] + pair).startsWith(stem));
}

/** A display name: a name printed in capitals ("ANTHONY A. DOVI") reads in title case. */
const displayName = (words: string[]): string => words.map(word => /^[A-Z'’-]{2,}$/.test(word)
  ? word.split(/([-'’])/).map(part => part.charAt(0) + part.slice(1).toLowerCase()).join('') : word).join(' ');

export interface StaffMention { name: string; email: string; title: string | null }

/** The people one section names, each by the address that follows their name. */
export function staffInSection(heading: string, body: string): StaffMention[] {
  const raw = `${heading} :: ${body}`.replace(/([a-z])- ([A-Z])/g, '$1-$2').replace(/\(mailto:([^)\s]+)\)/gi, ' $1 ').replace(/\(https?:[^)\s]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const mentions: StaffMention[] = [];
  for (const match of raw.matchAll(EMAIL)) {
    const local = match[1].toLowerCase();
    // A link's address printed again beside it is one mention.
    if (mentions.some(m => m.email === `${local}@ramapo.edu`)) continue;
    const window = raw.slice(Math.max(0, match.index! - 240), match.index!);
    const words = window.split(/\s+/).filter(Boolean).flatMap(unglue);
    let best: { start: number; end: number } | null = null;
    // The name nearest the address wins; it may hold a middle initial.
    for (let end = words.length - 1; end >= 1 && !best; end--) {
      const last = words[end].replace(/[,;:]+$/, '');
      if (!nameWord(last) || initial(last)) continue;
      for (let start = Math.max(0, end - 3); start < end; start++) {
        const span = words.slice(start, end + 1).map(word => word.replace(/[,;:]+$/, ''));
        if (!span.every(nameWord) || initial(span[0]) || new Set(span).size < span.length) continue;
        if (addressFits(span, local)) { best = { start, end }; break; }
      }
    }
    if (!best) continue;
    const name = displayName(words.slice(best.start, best.end + 1).map(word => word.replace(/[,;:]+$/, '')));
    // The title: the words between the name and the address, without degrees, rooms and labels.
    const between = words.slice(best.end + 1).join(' ')
      .replace(DEGREES, ' ').replace(/\([^)]*\)/g, ' ')
      .replace(/(E-?mail|Phone|Call|Text|Office|Ext|Cell|Fax|TTY via NJ Relay|Pronouns)\s*:?/gi, ' ')
      .replace(/(\+1\s*)?(\(?\d{3}\)?[\s.]*)?\d{3}\s*[-–.]\s*\d{4}|\bx\d{4}\b/g, ' ')
      .replace(/\b[A-Z]{1,3}[- ]?\d{2,4}[A-Z]?\b/g, ' ').replace(/\b\d+\b|\s[a-z](?=\s|$)/g, ' ').replace(/^\s*(Jr\.|Sr\.)?,?/, ' ').replace(/[:|]+/g, ' ')
      .replace(/\s+/g, ' ').replace(/^[\s,;.–\/-]+|(\s(at|or|via|by))+\s*$|[\s,;.–\/(-]+$/g, '').replace(/(\s(at|or|via|by))+$/, '')
      // A room's building letter or a "Location:" label left at the end.
      .replace(/\s+(?:[A-Z]{1,3}|Location)$/, '').trim();
    const title = between && ROLE.test(between) && between.split(' ').length <= 12 && !/@/.test(between) ? between : null;
    mentions.push({ name, email: `${local}@ramapo.edu`, title });
  }
  return mentions;
}

/** listed_by links, and person nodes and `staff` records for the people no node holds yet. */
export function compileOfficeStaff(entities: CampusIdentity[], pages: Row[], collectedAt = ''): { entities: CampusIdentity[]; records: GraphRecordCollectionData; linked: number } {
  const owners = new Map<string, CampusIdentity[]>();
  for (const office of entities.filter(e => e.kind === 'office')) {
    for (const link of office.links.filter(l => l.collection === 'office_sections')) {
      for (const key of link.source_record_keys) owners.set(key, [...owners.get(key) ?? [], office]);
    }
  }
  const byEmail = new Map<string, CampusIdentity>();
  const byName = new Map<string, CampusIdentity[]>();
  for (const person of entities.filter(e => e.kind === 'person')) {
    for (const link of person.links) for (const key of link.source_record_keys) {
      const email = /#email=([^#&]+@ramapo\.edu)$/i.exec(key)?.[1]?.toLowerCase();
      if (email) byEmail.set(email, person);
    }
    for (const name of [person.name, ...person.aliases]) {
      const key = personKey(name);
      if (key) byName.set(key, [...byName.get(key) ?? [], person]);
    }
  }
  const otherNames = new Set(entities.filter(e => e.kind !== 'person').map(e => fold(e.name)));
  const created = new Map<string, CampusIdentity>();
  const createdByEmail = new Map<string, CampusIdentity>();
  const records = new Map<string, GraphRecordRow & { names: string[]; emails: string[]; roles: Array<{ office: string; title: string | null; source_url: string }> }>();
  const printed = new Map<string, number>();
  let linked = 0;
  for (const page of pages) {
    const key = text(page.source_record_key);
    const url = text(page.url);
    const offices = owners.get(key) ?? [];
    if (offices.length !== 1 || !/^https:\/\//.test(url) || STUDENT_PAGES.test(key)) continue;
    const [office] = offices;
    const sections = Array.isArray(page.sections) ? page.sections as Row[] : [];
    for (const section of sections) {
      for (const mention of staffInSection(text(section.heading), text(section.text))) {
        if (otherNames.has(fold(mention.name))) continue;
        const nameKey = personKey(mention.name);
        const known = byEmail.get(mention.email) ?? ((byName.get(nameKey) ?? []).length === 1 ? byName.get(nameKey)![0] : undefined);
        // One address is one person, whichever spelling of the name a page prints (Joe, Joseph).
        let person = known ?? createdByEmail.get(mention.email) ?? created.get(nameKey);
        if (!person) {
          person = { id: staffIdentityId(mention.email), kind: 'person', name: mention.name, aliases: [],
            links: [{ collection: 'staff', source_key: 'office-pages', source_record_keys: [mention.email] }] };
          created.set(nameKey, person);
          createdByEmail.set(mention.email, person);
          records.set(person.id, { source_record_key: mention.email, name: mention.name, names: [], emails: [], roles: [], source_url: url });
        }
        const record = records.get(person.id);
        if (record) {
          createdByEmail.set(mention.email, person);
          if (!record.names.includes(mention.name)) record.names.push(mention.name);
          printed.set(`${person.id}\n${mention.name}`, (printed.get(`${person.id}\n${mention.name}`) ?? 0) + 1);
          if (!record.emails.includes(mention.email)) record.emails.push(mention.email);
          if (!record.roles.some(role => role.office === office.name && role.title === mention.title && role.source_url === url)) {
            record.roles.push({ office: office.name, title: mention.title, source_url: url });
          }
        }
        const evidence: IdentityEvidence = { collection: 'office_sections', source_key: text(page.source_key) || 'office-pages', source_record_key: key, field: 'sections', source_url: url };
        person.relationships ||= [];
        const held = person.relationships.find(r => r.type === 'listed_by' && 'target_entity_id' in r && r.target_entity_id === office.id);
        if (held) {
          if (held.evidence.length < 32 && !held.evidence.some(e => e.source_record_key === key)) held.evidence.push(evidence);
        } else {
          person.relationships.push({ type: 'listed_by', target_entity_id: office.id, evidence: [evidence] });
          linked++;
        }
      }
    }
  }
  // A person's name is their most-printed spelling; the others stay aliases.
  for (const person of new Set(created.values())) {
    const record = records.get(person.id)!;
    const count = (name: string) => printed.get(`${person.id}\n${name}`) ?? 0;
    person.name = record.names.reduce((best, name) => count(name) > count(best) ? name : best, record.names[0]);
    person.aliases = record.names.filter(name => name !== person.name).sort();
    record.name = person.name;
  }
  const rows = [...records.values()].map(row => ({ ...row, names: row.names.sort(), emails: row.emails.sort() }))
    .sort((a, b) => a.source_record_key.localeCompare(b.source_record_key));
  // With no source time given, the newest capture of the pages read.
  const captured = collectedAt || pages.map(page => text(page.collected_at)).filter(Boolean).sort().pop() || '';
  return { entities: [...new Set(created.values())].sort((a, b) => a.name.localeCompare(b.name)), records: { source_key: 'office-pages', collected_at: captured, rows }, linked };
}

/** First and last name, folded: "Dr. David C. Nast" and "David Nast" are one person. */
function personKey(name: string): string {
  const words = name.replace(/^Dr\.?\s+/i, '').replace(DEGREES, ' ').split(/[\s,]+/).filter(word => word && !/^[A-Z]\.?$/.test(word)).map(fold).filter(Boolean);
  return words.length >= 2 ? `${words[0]} ${words[words.length - 1]}` : '';
}
