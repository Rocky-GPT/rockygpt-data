/**
 * The closed set of course subjects, with the names and short forms a student
 * would actually say.
 *
 * A subject reaches the brain as a mention — "CS", "Comp Sci", "computer
 * science" — and something has to turn that into `CMPS` deterministically.
 * That belongs to the data: a rename or a new short form is known here, and a
 * capability guessing at it is how "show me CS classes" returned nothing over
 * sixty-three courses filed under a prefix nobody types.
 *
 * `name` comes from the upstream department record. `aliases` are curated in
 * `src/reference/course-subject-aliases.json` and merged here, because an
 * abbreviation two subjects both claim cannot be derived from either name.
 */

import path from 'path';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import curatedAliases from '../src/reference/course-subject-aliases.json';

const URL = 'https://app.coursedog.com/api/v1/ramapo_banner_ethos/departments';
const HEADERS = {
  'x-requested-with': 'catalog',
  referer: 'https://catalog.ramapo.edu/',
  origin: 'https://catalog.ramapo.edu',
  accept: 'application/json',
};
const RAW_OUT = path.join(process.cwd(), 'data', 'raw', 'course-subjects.raw.json');
const OUT = path.join(process.cwd(), 'src', 'reference', 'course-subjects.json');

interface Department {
  name?: unknown;
  displayName?: unknown;
  status?: unknown;
  customFields?: { code?: unknown } | null;
  subjectCodes?: unknown;
}

export interface CourseSubject {
  code: string;
  name: string;
  aliases: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Every subject code this department owns, upper-cased. */
function codesFor(record: Department): string[] {
  const codes = new Set<string>();
  const declared = text(record.customFields?.code).toUpperCase();
  if (declared) codes.add(declared);
  if (Array.isArray(record.subjectCodes)) {
    for (const entry of record.subjectCodes) {
      const code = text(entry).toUpperCase();
      if (code) codes.add(code);
    }
  }
  // "Accounting (ACCT)" carries the code when the field does not.
  if (codes.size === 0) {
    const match = /\(([A-Z]{2,6})\)\s*$/.exec(text(record.displayName));
    if (match) codes.add(match[1]);
  }
  return [...codes];
}

export function subjectsFrom(
  departments: Record<string, Department>,
  aliases: Record<string, string[]>
): CourseSubject[] {
  const byCode = new Map<string, CourseSubject>();
  for (const record of Object.values(departments)) {
    if (text(record.status).toLowerCase() !== 'active') continue;
    const name = text(record.name);
    if (!name) continue;
    for (const code of codesFor(record)) {
      if (byCode.has(code)) continue;
      byCode.set(code, { code, name, aliases: aliases[code] ?? [] });
    }
  }
  // A curated alias for a subject upstream does not name is still a real short
  // form; keep it rather than dropping the only handle the data has on it.
  for (const [code, list] of Object.entries(aliases)) {
    if (!byCode.has(code)) byCode.set(code, { code, name: '', aliases: list });
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

async function main(): Promise<void> {
  const response = await fetchWithPolicy(
    URL,
    { headers: HEADERS },
    { expectedContentTypes: ['application/json'], maxResponseBytes: 32 * 1024 * 1024 }
  );
  if (!response.ok) throw new Error(`Departments returned HTTP ${response.status}.`);
  const raw = response.json() as Record<string, Department>;
  writeJsonFile(RAW_OUT, raw);
  writeRawProvenance('course-subjects', { sourceUrl: URL, payload: raw });

  const subjects = subjectsFrom(raw, curatedAliases as Record<string, string[]>);
  if (subjects.length < 50) {
    throw new Error(`Only ${subjects.length} subjects resolved; refusing to publish a short set.`);
  }
  writeJsonFile(OUT, subjects);
  const named = subjects.filter((subject) => subject.name).length;
  console.log(`Wrote ${subjects.length} course subjects (${named} named) to ${OUT}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
