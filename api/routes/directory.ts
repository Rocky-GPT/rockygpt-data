/**
 * @module api/directory/route
 * Campus directory endpoint merging offices, faculty/staff, and other contacts.
 *
 * Reads the scraped `faculty.json` dataset, de-duplicates and normalises
 * entries (phone, email, office extraction), merges them with the
 * hand-curated static office and staff lists, and returns a unified
 * search index for the directory modal.
 */

import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../../src/directory/static-contacts';
import { loadReleaseArtifact } from '../../src/data-v2/release-artifacts';

import type { ApiHandler, ApiResponse } from '../http';

/**
 * Mirrors the response helper these handlers were written against, so the
 * logic below is the same code that ran inside the web app.
 */
const json = (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): ApiResponse => ({ status: init?.status ?? 200, body, headers: init?.headers });

import type {
  DirectoryApiResponse,
  FacultyStaffContact,
  NormalizedDirectoryContact,
  OfficeDirectoryContact,
  OtherDirectoryContact,
} from '../../src/directory/types';

/**
 * Forces directory responses to be assembled from current data at request time.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrl(value: unknown): string | undefined {
  const url = asTrimmedString(value);
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return url;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeEmail(value: string | undefined, title: string | undefined): string | undefined {
  const fromField = asTrimmedString(value);
  if (fromField && !/^email us$/i.test(fromField)) {
    if (fromField.includes('@')) return fromField.toLowerCase();
    return `${fromField.toLowerCase()}@ramapo.edu`;
  }

  if (!title) return undefined;

  const match = title.match(/\bE-?mail:\s*([A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?)\b/i);
  const fromTitle = asTrimmedString(match?.[1]);
  if (!fromTitle || /^email us$/i.test(fromTitle)) return undefined;
  if (fromTitle.includes('@')) return fromTitle.toLowerCase();
  return `${fromTitle.toLowerCase()}@ramapo.edu`;
}

function extractExtension(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = title.match(/Ext[:.\s]*([0-9]{4})/i);
  return asTrimmedString(match?.[1]);
}

function normalizePhone(value: string | undefined, title: string | undefined): string | undefined {
  const fromField = asTrimmedString(value);
  if (fromField) {
    const digits = fromField.replace(/\D/g, '');
    if (digits.length === 4) return `(201) 684-${digits}`;
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits.startsWith('1')) {
      const ten = digits.slice(1);
      return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
    }
    return fromField;
  }

  const ext = extractExtension(title);
  if (!ext) return undefined;
  return `(201) 684-${ext}`;
}

function extractOffice(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = title.match(/([A-Z]{1,4}-\d{2,4}[A-Z]?|[A-Z]\d{3}[A-Z]?)(?=Ext|$|[^A-Za-z0-9])/);
  return asTrimmedString(match?.[1]);
}

function cleanTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let cleaned = value;
  cleaned = cleaned.replace(/Liaison:[^|]+/gi, ' ');
  cleaned = cleaned.replace(/Ext[:.\s]*\d{3,5}/gi, ' ');
  cleaned = cleaned.replace(/\|?\s*E-?mail:\s*[^|]+/gi, ' ');
  cleaned = cleaned.replace(/([A-Z]{1,4}-\d{2,4}[A-Z]?|[A-Z]\d{3}[A-Z]?)(?=Ext|$|[^A-Za-z0-9])/g, ' ');
  cleaned = normalizeWhitespace(cleaned)
    .replace(/[|,:\-]\s*$/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function toFacultyStaffContact(raw: Record<string, unknown>): FacultyStaffContact | null {
  const name = asTrimmedString(raw.name);
  if (!name) return null;

  const rawTitle = asTrimmedString(raw.title);
  const school = asTrimmedString(raw.school);
  const email = normalizeEmail(asTrimmedString(raw.email), rawTitle);
  const phone = normalizePhone(asTrimmedString(raw.phone), rawTitle);
  const office = asTrimmedString(raw.office) ?? extractOffice(rawTitle);
  const profileUrl = normalizeUrl(raw.profileUrl);
  const imageUrl = normalizeUrl(raw.imageUrl);
  const title = cleanTitle(rawTitle);

  return {
    name,
    ...(title ? { title } : {}),
    ...(school ? { school } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(office ? { office } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function mergeContacts(a: FacultyStaffContact, b: FacultyStaffContact): FacultyStaffContact {
  const chooseTitle = (() => {
    if (!a.title) return b.title;
    if (!b.title) return a.title;
    return b.title.length < a.title.length ? b.title : a.title;
  })();

  return {
    name: a.name,
    title: chooseTitle,
    school: a.school ?? b.school,
    email: a.email ?? b.email,
    phone: a.phone ?? b.phone,
    office: a.office ?? b.office,
    profileUrl: a.profileUrl ?? b.profileUrl,
    imageUrl: a.imageUrl ?? b.imageUrl,
  };
}

function toSearchText(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildNormalizedContacts(
  offices: OfficeDirectoryContact[],
  facultyStaff: FacultyStaffContact[],
  others: OtherDirectoryContact[]
): NormalizedDirectoryContact[] {
  const normalizedOffices = offices.map((entry, index) => ({
    id: `office-${index + 1}-${slugify(entry.name)}`,
    bucket: 'Offices',
    kind: 'office',
    source: 'office-static',
    name: entry.name,
    category: entry.category,
    department: entry.department,
    email: entry.email,
    phone: entry.phone,
    office: entry.office,
    helpsWith: entry.helpsWith,
    searchText: toSearchText([
      entry.name,
      entry.phone,
      entry.category,
      entry.email,
      entry.department,
      entry.office,
      entry.helpsWith.join(' '),
    ]),
  })) satisfies NormalizedDirectoryContact[];

  const normalizedFacultyStaff = facultyStaff.map((entry, index) => ({
    id: `faculty-${index + 1}-${slugify(entry.name)}`,
    bucket: 'Staff & Faculty',
    kind: 'person',
    source: 'faculty-dataset',
    name: entry.name,
    title: entry.title,
    school: entry.school,
    email: entry.email,
    phone: entry.phone,
    office: entry.office,
    profileUrl: entry.profileUrl,
    imageUrl: entry.imageUrl,
    searchText: toSearchText([
      entry.name,
      entry.title,
      entry.school,
      entry.email,
      entry.phone,
      entry.office,
    ]),
  })) satisfies NormalizedDirectoryContact[];

  const normalizedOthers = others.map((entry, index) => ({
    id: `other-${index + 1}-${slugify(entry.name)}`,
    bucket: 'Others',
    kind: 'person',
    source: 'other-static',
    name: entry.name,
    title: entry.title,
    unit: entry.unit,
    email: entry.email,
    phone: entry.phone,
    office: entry.office,
    profileUrl: entry.profileUrl,
    searchText: toSearchText([
      entry.name,
      entry.title,
      entry.unit,
      entry.email,
      entry.phone,
      entry.office,
    ]),
  })) satisfies NormalizedDirectoryContact[];

  return [...normalizedOffices, ...normalizedFacultyStaff, ...normalizedOthers];
}

/**
 * Returns the merged campus directory dataset and search index.
 */
export const getDirectory: ApiHandler = async () => {
  try {
    const loaded = await loadReleaseArtifact('faculty');
    const parsed: unknown = loaded.payload;

    if (!Array.isArray(parsed)) {
      return json({ error: 'Invalid directory dataset shape' }, { status: 500 });
    }

    const byKey = new Map<string, FacultyStaffContact>();

    for (const row of parsed) {
      if (!isRecord(row)) continue;
      const contact = toFacultyStaffContact(row);
      if (!contact) continue;

      const key = `${contact.name.toLowerCase()}|${(contact.school ?? '').toLowerCase()}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, contact);
      } else {
        byKey.set(key, mergeContacts(existing, contact));
      }
    }

    const facultyStaff = [...byKey.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
    );

    const offices = [...OFFICE_DIRECTORY_CONTACTS];
    const others = [...OTHER_DIRECTORY_CONTACTS];
    const allContacts = buildNormalizedContacts(offices, facultyStaff, others);
    const counts = {
      offices: offices.length,
      staffFaculty: facultyStaff.length,
      others: others.length,
      total: allContacts.length,
    };

    const payload: DirectoryApiResponse = {
      offices,
      facultyStaff,
      others,
      allContacts,
      counts,
      total: counts.total,
      generatedAt: loaded.activatedAt || new Date().toISOString(),
      releaseVersion: loaded.releaseVersion,
    };

    return json(payload);
  } catch (error) {
    console.error('Error reading directory contacts:', error);
    return json(
      { error: 'Failed to load directory contacts' },
      { status: 500 }
    );
  }
}
