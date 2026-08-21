import type { ProgramRecord } from '../schemas';

export type ProgramKind = NonNullable<ProgramRecord['programKind']>;

export interface ProgramSearchCriteria {
  subject: string;
  subjectTokens: string[];
  requestedKind?: ProgramKind;
  requestedDegree?: string;
}

const QUESTION_AND_PROGRAM_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'at',
  'available',
  'can',
  'certificate',
  'certificates',
  'college',
  'degree',
  'degrees',
  'do',
  'does',
  'for',
  'have',
  'i',
  'in',
  'is',
  'major',
  'majors',
  'me',
  'minor',
  'minors',
  'of',
  'offer',
  'offered',
  'program',
  'programs',
  'ramapo',
  'school',
  'tell',
  'the',
  'there',
  'to',
  'what',
  'which',
  'with',
]);

const PROGRAM_ALIASES: Record<string, string[]> = {
  bio: ['biology'],
  cs: ['computer', 'science'],
};

const DEGREE_PATTERNS: Array<{ pattern: RegExp; degree: string }> = [
  { pattern: /\b(?:bachelor of science in nursing|bsn)\b/i, degree: 'Bachelor of Science in Nursing' },
  { pattern: /\b(?:master of science in nursing|msn)\b/i, degree: 'Master of Science in Nursing' },
  { pattern: /\b(?:doctor of nursing practice|dnp)\b/i, degree: 'Doctor of Nursing Practice' },
  { pattern: /\b(?:master of business administration|mba)\b/i, degree: 'Master of Business Administration' },
  { pattern: /\b(?:master of public policy|mpp)\b/i, degree: 'Master of Public Policy' },
  { pattern: /\b(?:master of social work|msw)\b/i, degree: 'Master of Social Work' },
  { pattern: /\b(?:bachelor of social work|bsw)\b/i, degree: 'Bachelor of Social Work' },
  { pattern: /\b(?:master of fine arts|mfa)\b/i, degree: 'Master of Fine Arts' },
  { pattern: /\b(?:graduate certificate)\b/i, degree: 'Graduate Certificate' },
  { pattern: /\b(?:bachelor of science|bs)\b/i, degree: 'Bachelor of Science' },
  { pattern: /\b(?:bachelor of arts|ba)\b/i, degree: 'Bachelor of Arts' },
  { pattern: /\b(?:master of science|ms)\b/i, degree: 'Master of Science' },
  { pattern: /\b(?:master of arts|ma)\b/i, degree: 'Master of Arts' },
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function requestedKind(query: string): ProgramKind | undefined {
  if (/\b(?:minor|minor program)s?\b/i.test(query)) return 'minor';
  if (/\b(?:certificate|certificate program)s?\b/i.test(query)) return 'certificate';
  if (/\b(?:4\s*\+\s*1|five[ -]year|combined degree)\b/i.test(query)) return 'special';
  if (/\b(?:major|major program)s?\b/i.test(query)) return 'major';
  return undefined;
}

function requestedDegree(query: string): string | undefined {
  return DEGREE_PATTERNS.find(({ pattern }) => pattern.test(query))?.degree;
}

export function parseProgramSearch(query: string): ProgramSearchCriteria {
  let subjectText = query.replace(/\b(?:4\s*\+\s*1|five[ -]year|combined degree)\b/gi, ' ');
  for (const { pattern } of DEGREE_PATTERNS) {
    subjectText = subjectText.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), ' ');
  }

  let subjectTokens = normalize(subjectText)
    .split(' ')
    .filter(Boolean)
    .flatMap((token) => PROGRAM_ALIASES[token] || [token])
    .filter((token) => token.length >= 3 && !QUESTION_AND_PROGRAM_WORDS.has(token));

  // A bare "art major" conventionally refers to visual arts. Restrict this
  // expansion to the lone subject so "art history minor" stays art history.
  if (subjectTokens.length === 1 && subjectTokens[0] === 'art') {
    subjectTokens = ['visual', 'arts'];
  }

  subjectTokens = Array.from(new Set(subjectTokens));
  return {
    subject: subjectTokens.join(' '),
    subjectTokens,
    requestedKind: requestedKind(query),
    requestedDegree: requestedDegree(query),
  };
}

export function inferProgramKind(record: Pick<ProgramRecord, 'name' | 'degree' | 'programKind'>): ProgramKind {
  if (record.programKind) return record.programKind;
  if (/\b4\s*\+\s*1\b/i.test(record.name)) return 'special';
  const label = `${record.degree || ''} ${record.name}`;
  if (/certificate/i.test(label)) return 'certificate';
  if (/\bminor\b/i.test(label)) return 'minor';
  if (/undeclared|non-degree/i.test(record.name)) return 'undeclared';
  return 'major';
}

export function programMatchesCriteria(record: ProgramRecord, criteria: ProgramSearchCriteria): boolean {
  if (criteria.requestedKind && inferProgramKind(record) !== criteria.requestedKind) return false;
  if (criteria.requestedDegree && normalize(record.degree || '') !== normalize(criteria.requestedDegree)) return false;
  return true;
}

function tokensMatch(queryToken: string, nameToken: string): boolean {
  if (queryToken === nameToken) return true;

  const shorter = queryToken.length < nameToken.length ? queryToken : nameToken;
  const longer = queryToken.length < nameToken.length ? nameToken : queryToken;
  if (shorter.length >= 3 && `${shorter}s` === longer) return true;

  // Only permit broader prefix matching for at least four characters. Known
  // short aliases are expanded above, so fragments such as "art" cannot match
  // arbitrary words.
  return shorter.length >= 4 && longer.startsWith(shorter);
}

export function programNameScore(record: ProgramRecord, criteria: ProgramSearchCriteria): number {
  if (criteria.subjectTokens.length === 0) return 1;
  const nameTokens = normalize(record.name).split(' ').filter((token) => token.length >= 2);
  const matched = criteria.subjectTokens.filter((queryToken) =>
    nameTokens.some((nameToken) => tokensMatch(queryToken, nameToken))
  ).length;
  if (matched === 0) return 0;
  return matched / criteria.subjectTokens.length;
}

export function defaultProgramKindRank(record: ProgramRecord, criteria: ProgramSearchCriteria): number {
  if (criteria.requestedKind) return 0;
  const kind = inferProgramKind(record);
  if (kind === 'major') return 0;
  if (kind === 'minor') return 1;
  if (kind === 'certificate') return 2;
  if (kind === 'special') return 3;
  return 4;
}
