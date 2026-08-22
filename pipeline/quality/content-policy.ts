import fs from 'fs';
import path from 'path';

type UnknownRecord = Record<string, unknown>;

const PUBLISHABLE_ARTIFACT_ROOTS = [
  { relativePath: 'data/normalized', extensions: new Set(['.json']) },
  { relativePath: 'data/context', extensions: new Set(['.md']) },
  { relativePath: 'public/data', extensions: new Set(['.json']) },
] as const;

const CHALLENGE_SIGNATURES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'AWS WAF challenge', pattern: /\bAwsWafIntegration\b/i },
  { label: 'CAPTCHA container', pattern: /\bcaptcha-container\b/i },
  { label: 'CAPTCHA challenge script', pattern: /\b(?:CaptchaScript|ChallengeScript)\b/i },
  { label: 'Cloudflare challenge', pattern: /\bcf-chl-[a-z0-9_-]+\b/i },
  { label: 'Cloudflare challenge', pattern: /\bCloudflare Ray ID\b/i },
  {
    label: 'Cloudflare challenge',
    pattern: /Attention Required!\s*\|\s*Cloudflare/i,
  },
];

const GENERIC_CHALLENGE_MARKERS = [
  /\bHuman Verification\b/i,
  /verify that you(?:'|’)?re not a robot/i,
  /\bCAPTCHA puzzle\b/i,
  /\bJavaScript is disabled\b/i,
  /enable JavaScript and then reload/i,
] as const;

const FACULTY_RESEARCH_BOILERPLATE: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'site publishing disclaimer',
    pattern: /recognizes the value of publishing on the internet/i,
  },
  {
    label: 'site editorial disclaimer',
    pattern: /does not preview,\s*review,\s*censor,\s*or control/i,
  },
  {
    label: 'unofficial-content disclaimer',
    pattern: /do not in any way constitute official .* content/i,
  },
  {
    label: 'profile navigation heading',
    pattern: /^more about\s+/i,
  },
];

const INTERNAL_EVENT_METADATA_MARKERS = [
  'Organization:',
  'Event Name:',
  'Event Locator:',
  'Categories:',
  'Expected Headcount:',
  'Is this event is a fundraiser?',
] as const;

export const MIN_EVENT_DESCRIPTION_COVERAGE = 0.25;
export const MIN_EVENT_DETAIL_COVERAGE = 0.75;
export const MIN_FACULTY_CONTACT_COVERAGE = 0.95;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(value: unknown): string {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}@.+:/?=&_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function facultyRoleIdentity(value: unknown): string {
  const role = text(value)
    .replace(/[A-Z]{1,8}-\d+[A-Z]?\s*Ext(?:ension)?\s*:.*$/i, '')
    .replace(/\b(?:Ext(?:ension)?|E-?mail)\s*:.*$/i, '')
    .trim();
  return normalizeIdentity(role);
}

function canonicalUrl(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key === 'rel' || key.startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return normalizeIdentity(raw);
  }
}

function walkFiles(root: string, extensions: ReadonlySet<string>): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

export function challengeContentLabel(content: string): string | null {
  const infrastructureSignature = CHALLENGE_SIGNATURES.find(({ pattern }) =>
    pattern.test(content)
  );
  if (infrastructureSignature) return infrastructureSignature.label;
  const genericMarkerCount = GENERIC_CHALLENGE_MARKERS.filter((pattern) =>
    pattern.test(content)
  ).length;
  return genericMarkerCount >= 2 ? 'browser verification challenge' : null;
}

/**
 * Scans every artifact directory that can feed file-backed retrieval or a
 * release. High-confidence challenge signatures are used so ordinary course
 * material discussing JavaScript, access control, or CAPTCHA research does
 * not fail the gate.
 */
export function collectPublishableArtifactErrors(cwd = process.cwd()): string[] {
  const errors: string[] = [];

  for (const root of PUBLISHABLE_ARTIFACT_ROOTS) {
    const absoluteRoot = path.join(cwd, root.relativePath);
    for (const filePath of walkFiles(absoluteRoot, root.extensions)) {
      const relativePath = path.relative(cwd, filePath);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        errors.push(
          `Unable to read publishable artifact ${relativePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }

      const challenge = challengeContentLabel(content);
      if (challenge) {
        errors.push(`Browser challenge content found in ${relativePath} (${challenge})`);
      }

      if (path.extname(filePath).toLowerCase() === '.json') {
        try {
          JSON.parse(content);
        } catch (error) {
          errors.push(
            `Invalid JSON in publishable artifact ${relativePath}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  }

  return errors;
}

export function facultyQualityErrors(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const profiles = input.filter(isRecord);
  const errors: string[] = [];
  const reportedDuplicates = new Set<string>();
  const emailOwners = new Map<string, { index: number; name: string }>();
  const nameGroups = new Map<string, Array<{ index: number; profile: UnknownRecord }>>();
  const titleBleedProfiles = new Set<string>();
  const boilerplateProfiles = new Set<string>();
  const boilerplateLabels = new Set<string>();
  let boilerplateEntries = 0;

  profiles.forEach((profile, index) => {
    const name = text(profile.name) || `record ${index + 1}`;
    const title = text(profile.title);
    const email = normalizeIdentity(profile.email);
    const normalizedName = normalizeIdentity(profile.name);

    if (/\b(?:Ext(?:ension)?|E-?mail)\s*:/i.test(title)) {
      titleBleedProfiles.add(name);
    }

    const publications = Array.isArray(profile.publishedResearch)
      ? profile.publishedResearch
      : [];
    publications.forEach((publication) => {
      const publicationText = text(publication);
      const boilerplate = FACULTY_RESEARCH_BOILERPLATE.find(({ pattern }) =>
        pattern.test(publicationText)
      );
      if (boilerplate) {
        boilerplateProfiles.add(name);
        boilerplateLabels.add(boilerplate.label);
        boilerplateEntries += 1;
      }
    });

    if (email) {
      const previous = emailOwners.get(email);
      if (previous) {
        const key = `email:${email}`;
        if (!reportedDuplicates.has(key)) {
          errors.push(
            `Duplicate faculty identity: "${previous.name}" and "${name}" share email ${text(
              profile.email
            )}`
          );
          reportedDuplicates.add(key);
        }
      } else {
        emailOwners.set(email, { index, name });
      }
    }

    if (normalizedName) {
      const group = nameGroups.get(normalizedName) ?? [];
      group.push({ index, profile });
      nameGroups.set(normalizedName, group);
    }
  });

  if (boilerplateEntries > 0) {
    errors.push(
      `Faculty publishedResearch contains boilerplate/navigation content in ${
        boilerplateProfiles.size
      } profile(s) and ${boilerplateEntries} entr${
        boilerplateEntries === 1 ? 'y' : 'ies'
      } (${Array.from(boilerplateLabels).join(', ')}; examples: ${Array.from(
        boilerplateProfiles
      )
        .slice(0, 3)
        .join(', ')})`
    );
  }

  if (titleBleedProfiles.size > 0) {
    errors.push(
      `Faculty titles contain merged contact/office text in ${titleBleedProfiles.size} profile(s) ` +
        `(examples: ${Array.from(titleBleedProfiles).slice(0, 3).join(', ')})`
    );
  }

  for (const [normalizedName, group] of nameGroups) {
    if (group.length < 2) continue;
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const left = group[leftIndex];
        const right = group[rightIndex];
        const sameProfileUrl =
          canonicalUrl(left.profile.profileUrl) !== '' &&
          canonicalUrl(left.profile.profileUrl) === canonicalUrl(right.profile.profileUrl);
        const sameRole =
          facultyRoleIdentity(left.profile.title) !== '' &&
          facultyRoleIdentity(left.profile.title) === facultyRoleIdentity(right.profile.title) &&
          normalizeIdentity(left.profile.school) === normalizeIdentity(right.profile.school);
        if (!sameProfileUrl || !sameRole) continue;

        const key = `name:${normalizedName}:${left.index}:${right.index}`;
        if (!reportedDuplicates.has(key)) {
          errors.push(
            `Duplicate faculty profiles for "${text(left.profile.name)}" at records ${
              left.index + 1
            } and ${right.index + 1}`
          );
          reportedDuplicates.add(key);
        }
      }
    }
  }

  if (profiles.length >= 20) {
    const withContact = profiles.filter(
      (profile) => text(profile.email) !== '' || text(profile.phone) !== ''
    ).length;
    const coverage = withContact / profiles.length;
    if (coverage < MIN_FACULTY_CONTACT_COVERAGE) {
      errors.push(
        `Faculty contact coverage ${(coverage * 100).toFixed(1)}% is below ${(
          MIN_FACULTY_CONTACT_COVERAGE * 100
        ).toFixed(0)}% (${withContact}/${profiles.length} have email or phone)`
      );
    }
  }

  return errors;
}

export function eventQualityErrors(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const events = input.filter(isRecord);
  const errors: string[] = [];
  const urlOwners = new Map<string, number>();
  const summaryOwners = new Map<string, number>();

  events.forEach((event, index) => {
    const eventUrl = canonicalUrl(event.url);
    if (eventUrl) {
      const previous = urlOwners.get(eventUrl);
      if (previous !== undefined) {
        errors.push(
          `Duplicate events share the same URL at records ${previous + 1} and ${index + 1}`
        );
      } else {
        urlOwners.set(eventUrl, index);
      }
    }

    const summaryKey = [
      normalizeIdentity(event.title),
      normalizeIdentity(event.date),
      normalizeIdentity(event.time),
    ].join('|');
    if (summaryKey !== '||') {
      const previous = summaryOwners.get(summaryKey);
      if (previous !== undefined) {
        errors.push(
          `Duplicate event summaries at records ${previous + 1} and ${index + 1}`
        );
      } else {
        summaryOwners.set(summaryKey, index);
      }
    }

    const description = text(event.description);
    if (description) {
      const markerCount = INTERNAL_EVENT_METADATA_MARKERS.filter((marker) =>
        description.toLocaleLowerCase('en-US').includes(marker.toLocaleLowerCase('en-US'))
      ).length;
      if (markerCount >= 2) {
        errors.push(`Event "${text(event.title)}" contains internal form metadata`);
      }
    }
  });

  if (events.length >= 4) {
    const described = events.filter((event) => text(event.description) !== '').length;
    const coverage = described / events.length;
    if (coverage < MIN_EVENT_DESCRIPTION_COVERAGE) {
      errors.push(
        `Event description coverage ${(coverage * 100).toFixed(1)}% is below ${(
          MIN_EVENT_DESCRIPTION_COVERAGE * 100
        ).toFixed(0)}% (${described}/${events.length} summaries have descriptions)`
      );
    }
  }

  return errors;
}

export function eventDetailCoverageErrors(
  eventsInput: unknown,
  detailDatasetInput: unknown
): string[] {
  if (!Array.isArray(eventsInput) || !isRecord(detailDatasetInput)) return [];
  const pages = Array.isArray(detailDatasetInput.pages)
    ? detailDatasetInput.pages.filter(isRecord)
    : [];
  const eventUrls = new Set(
    eventsInput
      .filter(isRecord)
      .map((event) => canonicalUrl(event.url))
      .filter(Boolean)
  );
  if (eventUrls.size < 4) return [];

  const successfulDetailUrls = new Set(
    pages
      .filter(
        (page) =>
          page.sourceType === 'detail' &&
          typeof page.statusCode === 'number' &&
          page.statusCode >= 200 &&
          page.statusCode < 400
      )
      .map((page) => canonicalUrl(page.url))
      .filter(Boolean)
  );
  const matched = Array.from(eventUrls).filter((url) => successfulDetailUrls.has(url)).length;
  const coverage = matched / eventUrls.size;
  if (coverage >= MIN_EVENT_DETAIL_COVERAGE) return [];

  return [
    `Event detail coverage ${(coverage * 100).toFixed(1)}% is below ${(
      MIN_EVENT_DETAIL_COVERAGE * 100
    ).toFixed(0)}% (${matched}/${eventUrls.size} current event URLs have successful detail pages)`,
  ];
}
