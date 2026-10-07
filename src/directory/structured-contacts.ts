import type { ContactRecord } from '../data-v2/schemas';
import { V2_SOURCES } from '../data-v2/sources';
import {
  OFFICE_DIRECTORY_CONTACTS,
  OTHER_DIRECTORY_CONTACTS,
} from './static-contacts';
import { parseAndNormalizePhone } from './phone-normalizer';
import { formatOffices, normalizeContactFields, reviewContacts } from './contact-normalizer';
import { reviewContactCoverage, type ContactCoverageReport } from './contact-coverage';
import {
  checkAbsences,
  checkContactValues,
  checkContactAdditions,
  checkContactNotes,
  checkWebsite,
  type AbsenceClaim,
  type AbsenceIssue,
  type CapturedPage,
  type ConfirmedAbsence,
  type ConfirmedWebsite,
  type ContactEvidence,
  type ContactValues,
  type ConfirmedContactAddition,
  type ConfirmedContactNote,
  type AbsenceValues,
  type ReviewedContactAddition,
  type ReviewedContactNote,
  type ReviewedContactExclusion,
  type WebsiteIssue,
  type WithheldContactValue,
} from './contact-evidence';

type JsonRecord = Record<string, unknown>;

export type DirectoryPublicationSourceKey = 'campus-directory' | 'faculty';

/**
 * One contact shared by file-mode search and structured publication.
 *
 * `searchable` contains file-mode enrichment that is not part of the wire
 * record. The publication fields keep PostgreSQL population and provenance in
 * sync with the same normalized contact set.
 */
export interface StructuredDirectoryContact extends ContactRecord {
  searchable: string;
  publicationSourceKey: DirectoryPublicationSourceKey;
  sourceRecordKey: string;
  /** Alternative names explicitly present in the published directory. */
  aliases: string[];
  /**
   * For a reviewed contact checked against this run's captures: the pages that state
   * its published values, and the reviewed values no cited section stated.
   */
  evidence?: {
    source_urls: string[];
    withheld: WithheldContactValue[];
    /** Fields the office's pages were confirmed, in this run's capture, not to publish. */
    not_published: ConfirmedAbsence[];
    /** Claims of absence this run could not confirm (a page now states the value, or was not captured). */
    absence_issues: AbsenceIssue[];
    /** The office's own ramapo.edu page, when this run's capture loaded it. */
    website?: ConfirmedWebsite;
    /** A reviewed website this run could not keep (not a ramapo.edu page, or not captured). */
    website_issue?: WebsiteIssue;
    additional_contacts?: ConfirmedContactAddition[];
    contact_notes?: ConfirmedContactNote[];
    contact_note_issues?: Array<{ text: string; reason: string }>;
    /** Unreviewed discoveries are diagnostic metadata, never attribute evidence. */
    contact_review?: ContactCoverageReport;
    contact_conflicts?: ConfirmedContactAddition[];
  };
}

interface FacultyContactSeed {
  name: string;
  title: string;
  school: string;
  phone?: string;
  email?: string;
  office?: string;
  bio: string;
  profileUrl: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function keyPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function facultySeed(value: unknown): FacultyContactSeed | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as JsonRecord;
  const name = text(row.name);
  if (!name) return null;
  return {
    name,
    title: text(row.title),
    school: text(row.school),
    phone: text(row.phone) || undefined,
    email: text(row.email) || undefined,
    office: text(row.office) || undefined,
    bio: text(row.bio),
    profileUrl: text(row.profileUrl) || 'https://www.ramapo.edu/directory/',
  };
}

function mergeFaculty(left: FacultyContactSeed, right: FacultyContactSeed): FacultyContactSeed {
  const title = (() => {
    if (!left.title) return right.title;
    if (!right.title) return left.title;
    return right.title.length < left.title.length ? right.title : left.title;
  })();
  const bios = [...new Set([left.bio, right.bio].filter(Boolean))];
  return {
    name: left.name,
    title,
    school: left.school || right.school,
    phone: left.phone || right.phone,
    email: left.email || right.email,
    office: left.office || right.office,
    bio: bios.join(' '),
    profileUrl: left.profileUrl || right.profileUrl,
  };
}

function facultyContacts(input: unknown): StructuredDirectoryContact[] {
  if (!Array.isArray(input)) return [];
  const byNameAndSchool = new Map<string, FacultyContactSeed>();
  for (const value of input) {
    const contact = facultySeed(value);
    if (!contact) continue;
    // This matches the full directory endpoint's identity rule: the same
    // person may legitimately appear in two schools, but duplicate crawls of
    // one school are merged into one contact.
    const identity = `${contact.name.toLowerCase()}|${contact.school.toLowerCase()}`;
    const existing = byNameAndSchool.get(identity);
    byNameAndSchool.set(identity, existing ? mergeFaculty(existing, contact) : contact);
  }

  return [...byNameAndSchool.values()]
    .sort((left, right) =>
      left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
      left.school.localeCompare(right.school, 'en', { sensitivity: 'base' })
    )
    .map((contact) => {
      const normalizedPhone = parseAndNormalizePhone(contact.phone);
      return {
        name: contact.name,
        type: 'person' as const,
        title: contact.title || undefined,
        department: contact.school || undefined,
        phone: normalizedPhone.phone || undefined,
        phones: normalizedPhone.phones,
        preferred_contact: normalizedPhone.preferred_contact || undefined,
        contact_note: normalizedPhone.contact_note || undefined,
        prefers_email: normalizedPhone.prefers_email,
        raw_phone: normalizedPhone.raw_phone || undefined,
        phone_normalization_status: normalizedPhone.phone_normalization_status,
        email: contact.email,
        office: contact.office,
        source: {
          sourceId: 'faculty-directory',
          title: `${contact.name} - Directory Profile`,
          url: contact.profileUrl,
        },
        searchable: [
          contact.name,
          contact.title,
          contact.school,
          contact.office,
          contact.email,
          contact.bio,
        ]
          .filter(Boolean)
          .join(' '),
        publicationSourceKey: 'faculty',
        sourceRecordKey: `faculty:${keyPart(contact.name)}:${keyPart(contact.school) || 'unknown-school'}`,
        aliases: [],
      };
    });
}

export function normalizePhoneNumber(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;
  return parseAndNormalizePhone(phone).phone || undefined;
}

/**
 * A reviewed contact's phone, email and office. With this run's captured pages, only
 * the values a cited page section states; without them (file mode), the reviewed values.
 */
function reviewedValues(entry: ContactValues & { evidence: ContactEvidence[]; notPublished?: AbsenceClaim[]; website?: string;
  websiteEvidence?: Pick<ContactEvidence, 'url' | 'section'>; additionalContacts?: ReviewedContactAddition[]; contactNotes?: ReviewedContactNote[];
  contactConflicts?: ReviewedContactAddition[]; contactReviewExclusions?: ReviewedContactExclusion[]; department?: string },
  capturedPages: ReadonlyMap<string, CapturedPage> | undefined): {
  values: ContactValues; evidence?: StructuredDirectoryContact['evidence'];
  additions: Array<Pick<ConfirmedContactAddition, 'field' | 'value' | 'label'>>; notes: string[];
} {
  const values = { phone: entry.phone, email: entry.email, office: entry.office };
  if (!capturedPages) return { values, additions: entry.additionalContacts ?? [], notes: (entry.contactNotes ?? []).map(note => note.text) };
  const checked = checkContactValues(values, entry.evidence, capturedPages);
  // Against the reviewed values, not the published ones: a value withheld this run is still a value.
  const site = checkWebsite(entry.website, capturedPages, entry.websiteEvidence);
  const additions = checkContactAdditions(entry.additionalContacts ?? [], capturedPages);
  const conflicts = checkContactAdditions(entry.contactConflicts ?? [], capturedPages);
  const notes = checkContactNotes(entry.contactNotes ?? [], capturedPages);
  const allReviewedValues: AbsenceValues = { ...values, department: entry.department };
  // A named staff/service address is not a shared office mailbox. Phones and rooms are
  // arrays, so their additional values do contradict a claim that no value is published.
  for (const item of entry.additionalContacts ?? []) if (item.field !== 'email') allReviewedValues[item.field] ||= item.value;
  const normalized = parseAndNormalizePhone(values.phone);
  allReviewedValues.prefers_email = normalized.prefers_email;
  allReviewedValues.preferred_contact = normalized.preferred_contact;
  allReviewedValues.contact_note = [normalized.contact_note, ...notes.confirmed.map(note => note.text),
    ...additions.confirmed.filter(item => item.field === 'email').map(item => `${item.label}: ${item.value}`)].filter(Boolean).join('\n');
  const absences = checkAbsences(entry.notPublished ?? [], allReviewedValues, capturedPages, site.confirmed, additions.confirmed);
  return {
    values: checked.values,
    additions: additions.confirmed, notes: notes.confirmed.map(note => note.text),
    evidence: { source_urls: [...new Set([...checked.sourceUrls, ...additions.confirmed.map(item => item.url), ...conflicts.confirmed.map(item => item.url), ...notes.confirmed.map(item => item.url)])],
      withheld: [...checked.withheld, ...additions.withheld, ...conflicts.withheld],
      not_published: absences.confirmed, absence_issues: absences.issues,
      additional_contacts: additions.confirmed, contact_notes: notes.confirmed, contact_note_issues: notes.issues,
      contact_review: reviewContactCoverage(entry, capturedPages),
      contact_conflicts: conflicts.confirmed,
      ...(site.confirmed ? { website: site.confirmed } : {}),
      ...(site.issue ? { website_issue: site.issue } : {}) },
  };
}

/**
 * Builds the authoritative structured contact population for both repositories.
 * Publication passes the captured pages, so a reviewed value reaches the graph only
 * when the page section it cites states it in this run's capture.
 */
export function buildStructuredDirectoryContacts(
  facultyInput: unknown,
  capturedPages?: ReadonlyMap<string, CapturedPage>
): StructuredDirectoryContact[] {
  const offices: StructuredDirectoryContact[] = OFFICE_DIRECTORY_CONTACTS.map((entry) => {
    const { values, evidence, additions, notes } = reviewedValues(entry, capturedPages);
    const normalized = parseAndNormalizePhone(values.phone);
    const phones = [...normalized.phones];
    const locations: NonNullable<ContactRecord['offices']> = values.office ? [values.office] : [];
    for (const item of additions) {
      if (item.field === 'phone') {
        for (const phone of parseAndNormalizePhone(item.value).phones) {
          const existing = phones.findIndex(value => value.number === phone.number && value.extension === phone.extension);
          const scoped = { ...phone, type: item.label };
          if (existing < 0) phones.push(scoped); else phones[existing] = scoped;
        }
      } else if (item.field === 'office') {
        const existing = locations.findIndex(value => typeof value === 'string' && value === item.value);
        const scoped = { location: item.value, label: item.label };
        if (existing < 0) locations.push(scoped); else locations[existing] = scoped;
      } else {
        notes.push(`${item.label}: ${item.value}`);
      }
    }
    return {
      name: entry.name,
      type: 'office',
      department: entry.department,
      phone: normalized.phone || undefined,
      phones,
      preferred_contact: normalized.preferred_contact || undefined,
      contact_note: [normalized.contact_note, ...notes].filter(Boolean).join('\n') || undefined,
      prefers_email: normalized.prefers_email,
      raw_phone: normalized.raw_phone || undefined,
      phone_normalization_status: phones.length > 1 ? 'multi_phone' : normalized.phone_normalization_status,
      email: values.email,
      office: values.office,
      offices: locations,
      source: V2_SOURCES.directory,
      searchable: [entry.name, entry.department, values.office, ...entry.helpsWith]
        .filter(Boolean)
        .join(' '),
      publicationSourceKey: 'campus-directory',
      sourceRecordKey: `office:${keyPart(entry.name)}`,
      aliases: entry.department && entry.department !== entry.name ? [entry.department] : [],
      evidence,
    };
  });
  const others: StructuredDirectoryContact[] = OTHER_DIRECTORY_CONTACTS.map((entry) => {
    const { values, evidence } = reviewedValues(entry, capturedPages);
    const normalized = parseAndNormalizePhone(values.phone);
    return {
      name: entry.name,
      type: 'person',
      title: entry.title,
      department: entry.unit,
      phone: normalized.phone || undefined,
      phones: normalized.phones,
      preferred_contact: normalized.preferred_contact || undefined,
      contact_note: normalized.contact_note || undefined,
      prefers_email: normalized.prefers_email,
      raw_phone: normalized.raw_phone || undefined,
      phone_normalization_status: normalized.phone_normalization_status,
      email: values.email,
      office: values.office,
      source: V2_SOURCES.directory,
      searchable: [entry.name, entry.title, entry.unit, values.office].filter(Boolean).join(' '),
      publicationSourceKey: 'campus-directory',
      sourceRecordKey: `other:${keyPart(entry.name)}`,
      aliases: [],
      evidence,
    };
  });
  const contacts = [...offices, ...others, ...facultyContacts(facultyInput)].map(contact => {
    const fields = normalizeContactFields(contact);
    return {
      ...contact,
      ...fields,
      title: fields.title,
      department: fields.department,
      office: formatOffices(fields.offices),
      normalization_metadata: {
        version: 1,
        raw_fields: { name: contact.name, title: contact.title, department: contact.department, office: contact.office },
        review_flags: [],
        ...(contact.evidence ? { evidence: contact.evidence } : {}),
      },
    };
  });
  const reviews = reviewContacts(contacts.map(contact => ({ ...contact, id: contact.sourceRecordKey })));
  return contacts.map(contact => ({
    ...contact,
    normalization_metadata: { ...contact.normalization_metadata, review_flags: reviews[contact.sourceRecordKey] },
  }));
}
