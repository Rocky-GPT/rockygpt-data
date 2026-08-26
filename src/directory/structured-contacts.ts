import type { ContactRecord } from '../data-v2/schemas';
import { V2_SOURCES } from '../data-v2/sources';
import {
  OFFICE_DIRECTORY_CONTACTS,
  OTHER_DIRECTORY_CONTACTS,
} from './static-contacts';

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
      const department = contact.title
        ? contact.school
          ? `${contact.title} (${contact.school})`
          : contact.title
        : contact.school || undefined;
      return {
        name: contact.name,
        department,
        phone: contact.phone,
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
      };
    });
}

/** Builds the authoritative structured contact population for both repositories. */
export function buildStructuredDirectoryContacts(
  facultyInput: unknown
): StructuredDirectoryContact[] {
  const offices: StructuredDirectoryContact[] = OFFICE_DIRECTORY_CONTACTS.map((entry) => ({
    name: entry.name,
    department: entry.department,
    phone: entry.phone,
    email: entry.email,
    office: entry.office,
    source: V2_SOURCES.directory,
    searchable: [entry.name, entry.department, entry.office, ...entry.helpsWith]
      .filter(Boolean)
      .join(' '),
    publicationSourceKey: 'campus-directory',
    sourceRecordKey: `office:${keyPart(entry.name)}`,
  }));
  const others: StructuredDirectoryContact[] = OTHER_DIRECTORY_CONTACTS.map((entry) => ({
    name: entry.name,
    department: entry.unit,
    phone: entry.phone,
    email: entry.email,
    office: entry.office,
    source: V2_SOURCES.directory,
    searchable: [entry.name, entry.title, entry.unit, entry.office].filter(Boolean).join(' '),
    publicationSourceKey: 'campus-directory',
    sourceRecordKey: `other:${keyPart(entry.name)}`,
  }));
  return [...offices, ...others, ...facultyContacts(facultyInput)];
}
