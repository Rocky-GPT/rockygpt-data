import { createHash } from 'node:crypto';

/**
 * @module data-v2/course-identities
 * Canonical catalog course IDs. The data repository owns them; the Brain reads
 * the published artifact instead of deriving its own.
 *
 * The derivation is the Brain's original one, reproduced byte for byte so every
 * course keeps its published ID: a UUIDv5 in the RFC 4122 URL namespace over
 * Python's `json.dumps(["rockygpt", "course", source_key, code])`, whose default
 * separators are ", " and whose `ensure_ascii` escapes every character outside
 * space..tilde as lowercase \uXXXX. Do not change it.
 */

type Row = Record<string, unknown>;

const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
export const COURSE_SOURCE_KEY = 'academic-programs';
export const COURSE_ID_DERIVATION = 'uuid5(NAMESPACE_URL, python json.dumps(["rockygpt", "course", source_key, source_record_key]))';

export function uuid5(namespace: Buffer, name: string): string {
  const bytes = createHash('sha1').update(namespace).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Python `json.dumps(list_of_strings)` with default arguments. */
export function pythonJsonStrings(values: string[]): string {
  // JSON.stringify already matches Python for quotes, backslashes and control
  // characters; ensure_ascii additionally escapes each UTF-16 unit above 0x7e.
  const encode = (value: string): string => JSON.stringify(value)
    .replace(/[\u007f-￿]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `[${values.map(encode).join(', ')}]`;
}

export function courseIdentityId(sourceKey: string, code: string): string {
  return uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'course', sourceKey, code]));
}

export interface CourseIdentity { id: string; source_key: string; source_record_key: string; name: string | null }
export interface CourseIdentitiesArtifact { schema_version: 1; derivation: string; courses: CourseIdentity[] }

/** One identity per published catalog course, keyed exactly as the `courses` artifact keys it. */
export function compileCourseIdentities(courses: unknown): CourseIdentitiesArtifact {
  const entries = courses && typeof courses === 'object' && !Array.isArray(courses) ? Object.entries(courses as Row) : [];
  return {
    schema_version: 1,
    derivation: COURSE_ID_DERIVATION,
    courses: entries.map(([code, value]) => {
      const name = value && typeof value === 'object' ? (value as Row).name : undefined;
      return { id: courseIdentityId(COURSE_SOURCE_KEY, code), source_key: COURSE_SOURCE_KEY, source_record_key: code, name: typeof name === 'string' ? name : null };
    }).sort((a, b) => (a.source_record_key < b.source_record_key ? -1 : a.source_record_key > b.source_record_key ? 1 : 0)),
  };
}
