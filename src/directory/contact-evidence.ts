/**
 * @module directory/contact-evidence
 * Holds each reviewed contact value to the captured page section it came from.
 *
 * A reviewed contact names, for every phone, email and office it publishes, the
 * ramapo.edu page and section heading that state it. At publication the value is
 * looked up in that section of the page as this run captured it. A value the
 * section doesn't state (the page changed, the section moved, the page wasn't
 * captured) is withheld and recorded with its reason, never published on the
 * reviewer's word alone.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ContactField = 'phone' | 'email' | 'office';
export const CONTACT_FIELDS: readonly ContactField[] = ['phone', 'email', 'office'];

/** What an office's pages can be confirmed not to publish: its contact fields and its opening hours. */
export type AbsenceField = ContactField | 'hours';
export const ABSENCE_FIELDS: readonly AbsenceField[] = [...CONTACT_FIELDS, 'hours'];

/** Where a reviewed contact value is stated: a page, one section heading on it, and optionally the text it follows. */
export interface ContactEvidence {
  url: string;
  section: string;
  /**
   * For a section that lists many offices or people: the value must be the first of
   * its kind after this phrase, so a neighbour's number can't stand in for it.
   */
  near?: string;
  fields: ContactField[];
}

export interface CapturedSection { heading: string; text: string }
export interface CapturedPage { url: string; fetchedAt: string; sections: CapturedSection[] }

export type ContactValues = Partial<Record<ContactField, string>>;

export interface WithheldContactValue { field: ContactField; value: string; reason: string }

export interface CheckedContactValues {
  values: ContactValues;
  withheld: WithheldContactValue[];
  /** The pages that state at least one published value. */
  sourceUrls: string[];
}

/** How far past a `near` phrase its entry's first value may be. */
const NEAR_WINDOW = 400;

export function pageKey(url: string): string {
  try {
    const parsed = new URL(url.trim());
    let pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (!pathname.endsWith('/') && !/\.[a-z0-9]{2,5}$/i.test(pathname)) pathname += '/';
    return `${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

/**
 * Every page the raw collectors captured, by page key. When two collectors kept the
 * same page, the later capture wins. Pages that didn't load (non-200) state nothing.
 */
export function loadCapturedPages(rawDir = path.join(process.cwd(), 'data', 'raw')): Map<string, CapturedPage> {
  const pages = new Map<string, CapturedPage>();
  if (!fs.existsSync(rawDir)) return pages;
  for (const file of fs.readdirSync(rawDir).sort()) {
    // The *-sources files hold the same pages as HTML; their parsed twins hold the sections.
    if (!file.endsWith('.raw.json') || file.endsWith('-sources.raw.json')) continue;
    let dataset: unknown;
    try {
      dataset = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    } catch {
      continue;
    }
    const list = (dataset as { pages?: unknown })?.pages;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const page = raw as Partial<CapturedPage> & { statusCode?: unknown };
      if (typeof page?.url !== 'string' || page.statusCode !== 200 || !Array.isArray(page.sections)) continue;
      const captured: CapturedPage = {
        url: page.url,
        fetchedAt: typeof page.fetchedAt === 'string' ? page.fetchedAt : '',
        sections: page.sections.filter((s): s is CapturedSection =>
          typeof s?.heading === 'string' && typeof s?.text === 'string'),
      };
      const key = pageKey(page.url);
      const existing = pages.get(key);
      if (!existing || captured.fetchedAt > existing.fetchedAt) pages.set(key, captured);
    }
  }
  return pages;
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
const sameHeading = (left: string, right: string) => collapse(left).toLowerCase() === collapse(right).toLowerCase();

/** Ten-digit North American numbers, however the page spaces or dashes them. */
const PHONE = /(?<!\d)(?:\+?1[\s.\-–—]*)?\(?(\d{3})\)?[\s.\-–—]*(\d{3})[\s.\-–—]*(\d{4})(?!\d)/g;
/** A campus extension written on its own; every Ramapo extension is (201) 684-XXXX. */
const EXTENSION = /\b(?:ext\.?|extension|x)\s*:?\s*(\d{4})\b/gi;
/** A room code such as D-224, D – 224, D 104 or ASB422. */
const ROOM = /\b([A-Z]{1,3})\s*[-–]?\s*(\d{2,3}[A-Z]?)\b/g;

function phoneValueDigits(value: string): string | null {
  const numbers = [...value.matchAll(PHONE)].map(match => `${match[1]}${match[2]}${match[3]}`);
  if (numbers.length) return numbers[0];
  const extension = [...value.matchAll(EXTENSION)][0]?.[1] ?? value.replace(/\D/g, '');
  return /^\d{4}$/.test(extension) ? `201684${extension}` : null;
}

export function roomKey(value: string): string | null {
  const match = /^\s*([A-Za-z]{1,3})\s*[-–]?\s*(\d{2,3}[A-Za-z]?)\s*$/.exec(value);
  return match ? `${match[1]}${match[2]}`.toUpperCase() : null;
}

const alphanumeric = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;
/** A flattened sidebar runs the address into the next line's label: "e: …@ramapo.eduf: (201) …". */
const RUN_ON_LABEL = /^(.+\.(?:edu|com|org|gov|net))[a-z]$/;

/** Every email address in the text, in order. */
function emailsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return [...lower.matchAll(EMAIL)].map(match => {
    const runOn = RUN_ON_LABEL.exec(match[0]);
    return runOn && lower[(match.index ?? 0) + match[0].length] === ':' ? runOn[1] : match[0];
  });
}

function roomsIn(text: string): string[] {
  return [...text.matchAll(ROOM)].map(match => `${match[1]}${match[2]}`.toUpperCase());
}

function phonesIn(text: string): string[] {
  const found: Array<{ index: number; digits: string }> = [];
  for (const match of text.matchAll(PHONE)) found.push({ index: match.index ?? 0, digits: `${match[1]}${match[2]}${match[3]}` });
  for (const match of text.matchAll(EXTENSION)) found.push({ index: match.index ?? 0, digits: `201684${match[1]}` });
  return found.sort((left, right) => left.index - right.index).map(entry => entry.digits);
}

/**
 * Whether one reviewed value is stated in the text: every number of a phone value, the
 * address, the room code, or a place name as written. With `first`, the value must be
 * the first of its kind in the text.
 */
export function statesValue(field: ContactField, value: string, text: string, first = false): boolean {
  const pick = (found: string[]) => (first ? found.slice(0, 1) : found);
  if (field === 'phone') {
    const numbers = [...value.matchAll(PHONE)].map(match => `${match[1]}${match[2]}${match[3]}`);
    const wanted = numbers.length ? numbers : [phoneValueDigits(value)].filter((digits): digits is string => digits !== null);
    const stated = phonesIn(text);
    return wanted.length > 0 && (first ? wanted[0] === stated[0] : wanted.every(number => stated.includes(number)));
  }
  if (field === 'email') {
    const email = value.trim().toLowerCase();
    return email.length > 0 && pick(emailsIn(text)).includes(email);
  }
  const room = roomKey(value);
  if (room) return pick(roomsIn(text)).includes(room);
  const place = alphanumeric(value);
  return place.length > 0 && alphanumeric(text).includes(place);
}

/** The text an evidence entry points at, or why there is none in this capture. */
export function evidenceText(evidence: ContactEvidence, pages: ReadonlyMap<string, CapturedPage>): { text: string } | { reason: string } {
  const page = pages.get(pageKey(evidence.url));
  if (!page) return { reason: `${evidence.url} was not captured in this run.` };
  const sections = page.sections.filter(section => sameHeading(section.heading, evidence.section));
  if (!sections.length) return { reason: `${evidence.url} has no section "${evidence.section}".` };
  const text = sections.map(section => `${section.heading}\n${section.text}`).join('\n');
  if (!evidence.near) return { text };
  const start = text.toLowerCase().indexOf(evidence.near.toLowerCase());
  if (start < 0) return { reason: `Section "${evidence.section}" of ${evidence.url} doesn't mention "${evidence.near}".` };
  return { text: text.slice(start, start + evidence.near.length + NEAR_WINDOW) };
}

/**
 * Publishes each reviewed value only when a section it cites states it in this capture.
 * A value no evidence entry covers is withheld too: a reviewer's word isn't a source.
 */
export function checkContactValues(values: ContactValues, evidence: readonly ContactEvidence[],
  pages: ReadonlyMap<string, CapturedPage>): CheckedContactValues {
  const published: ContactValues = {};
  const withheld: WithheldContactValue[] = [];
  const sourceUrls = new Set<string>();
  for (const field of CONTACT_FIELDS) {
    const value = values[field]?.trim();
    if (!value) continue;
    const cited = evidence.filter(entry => entry.fields.includes(field));
    if (!cited.length) {
      withheld.push({ field, value, reason: 'No page is cited for this value.' });
      continue;
    }
    const reasons: string[] = [];
    const supporting = cited.find(entry => {
      const found = evidenceText(entry, pages);
      if ('reason' in found) { reasons.push(found.reason); return false; }
      if (statesValue(field, value, found.text, Boolean(entry.near))) return true;
      reasons.push(`Section "${entry.section}" of ${entry.url} doesn't state it.`);
      return false;
    });
    if (supporting) {
      published[field] = value;
      sourceUrls.add(supporting.url);
    } else {
      withheld.push({ field, value, reason: reasons.join(' ') });
    }
  }
  return { values: published, withheld, sourceUrls: [...sourceUrls] };
}

/** A value a cited section states for a field the reviewed entry leaves empty. */
export interface UnrecordedValue { field: ContactField; found: string[]; url: string; section: string }

/**
 * The values each cited section states for a field the entry has no value for. An entry
 * that cites a section and omits what the section plainly lists is a likely mistake: the
 * graph then says "not published" about something the office's own page publishes. These
 * are for a person to review (a staff list can name other people's addresses). They are
 * never published on their own, and publication does not withhold anything for them.
 */
export function findUnrecordedValues(values: ContactValues, evidence: readonly ContactEvidence[],
  pages: ReadonlyMap<string, CapturedPage>): UnrecordedValue[] {
  const unrecorded: UnrecordedValue[] = [];
  const unique = (found: string[]) => [...new Set(found)];
  for (const entry of evidence) {
    const found = evidenceText(entry, pages);
    if ('reason' in found) continue;
    const stated: Record<ContactField, string[]> = {
      phone: unique(phonesIn(found.text)),
      email: unique(emailsIn(found.text)),
      office: unique(roomsIn(found.text)),
    };
    for (const field of CONTACT_FIELDS) {
      if (values[field]?.trim() || !stated[field].length) continue;
      unrecorded.push({ field, found: stated[field], url: entry.url, section: entry.section });
    }
  }
  return unrecorded;
}

/** A time range ("8:30 a.m. - 4:30 p.m.", "10 AM to 8 PM") or an every-hour statement ("24 hours"). */
const TIME_RANGE = /\b\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?\s*(?:-|\u2013|\u2014|to|until)\s*(?:\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?|noon|midnight)|\b24\s*(?:hours|hrs|\/\s*7)/gi;

function timeRangesIn(text: string): string[] {
  return [...text.matchAll(TIME_RANGE)].map(match => match[0].replace(/\s+/g, ' ').trim());
}

/** Every value of this kind the text states (room codes only for an office: a place name can't be searched for). */
function statedValues(field: AbsenceField, text: string): string[] {
  const found = field === 'phone' ? phonesIn(text) : field === 'email' ? emailsIn(text)
    : field === 'office' ? roomsIn(text) : timeRangesIn(text);
  return [...new Set(found)];
}

/**
 * A reviewed statement that an office's own pages do not publish a field, with the page
 * sections that would state it (the office's contact, location or hours block). It is a
 * claim to check, never a reason to leave a value out: an entry that has a value for the field
 * cannot also say the field is not published.
 */
export interface AbsenceClaim {
  field: AbsenceField;
  evidence: Array<Pick<ContactEvidence, 'url' | 'section' | 'near'>>;
}

export interface ConfirmedAbsence {
  field: AbsenceField;
  /** The sections read, and when this run captured each page. */
  checks: Array<{ url: string; section: string; checked_at: string }>;
}

export interface AbsenceIssue {
  field: AbsenceField;
  /** `contradicted`: a section states a value after all. `unconfirmed`: the sections could not be read. */
  kind: 'contradicted' | 'unconfirmed';
  reason: string;
}

export interface CheckedAbsences { confirmed: ConfirmedAbsence[]; issues: AbsenceIssue[] }

/**
 * Confirms each claim against this run's capture: every cited section must be present and
 * state no value of the field. A section that states one contradicts the claim (the page
 * started publishing it, or the claim was wrong); a page or section that was not captured
 * leaves the claim unconfirmed. Only a confirmed absence is published, so a field nobody
 * confirmed stays unknown, never "not published".
 */
export function checkAbsences(claims: readonly AbsenceClaim[], values: ContactValues,
  pages: ReadonlyMap<string, CapturedPage>): CheckedAbsences {
  const confirmed: ConfirmedAbsence[] = [];
  const issues: AbsenceIssue[] = [];
  for (const claim of claims) {
    const own = claim.field === 'hours' ? undefined : values[claim.field]?.trim();
    if (own) {
      issues.push({ field: claim.field, kind: 'contradicted', reason: `The entry itself has the ${claim.field} "${own}".` });
      continue;
    }
    if (!claim.evidence.length) {
      issues.push({ field: claim.field, kind: 'unconfirmed', reason: 'No page section is cited.' });
      continue;
    }
    const checks: ConfirmedAbsence['checks'] = [];
    let ok = true;
    for (const entry of claim.evidence) {
      const found = evidenceText({ ...entry, fields: [] }, pages);
      if ('reason' in found) { issues.push({ field: claim.field, kind: 'unconfirmed', reason: found.reason }); ok = false; continue; }
      const stated = statedValues(claim.field, found.text);
      if (stated.length) {
        issues.push({ field: claim.field, kind: 'contradicted',
          reason: `Section "${entry.section}" of ${entry.url} states ${stated.join(', ')}.` });
        ok = false;
        continue;
      }
      checks.push({ url: entry.url, section: entry.section, checked_at: pages.get(pageKey(entry.url))!.fetchedAt });
    }
    if (ok) confirmed.push({ field: claim.field, checks });
  }
  return { confirmed, issues };
}
