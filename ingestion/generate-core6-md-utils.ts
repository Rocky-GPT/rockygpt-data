import fs from 'fs';
import path from 'path';
import type { FrontmatterData } from './frontmatter';
import { getGeneratedTimestamp } from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';

export interface Core6MarkdownOptions {
  datasetName: string;
  title: string;
  description: string;
  inputFilePath: string;
  outputFilePath: string;
  frontmatter: FrontmatterData;
  maxPages?: number;
  maxSectionsPerPage?: number;
  maxContactsPerPage?: number;
  maxDocumentsPerPage?: number;
  derivedSections?: (page: RawPageV1) => readonly ContextSection[];
}

export interface ContextSection {
  heading: string;
  text: string;
}

const DEFAULT_MAX_PAGES = 30;
const DEFAULT_MAX_SECTIONS_PER_PAGE = 6;
const DEFAULT_MAX_CONTACTS_PER_PAGE = 6;
const DEFAULT_MAX_DOCUMENTS_PER_PAGE = 8;
const SECTION_MIN_LENGTH = 24;
const SECTION_MAX_LENGTH = 450;
// A contact repeated across most of a dataset is site template furniture, not a
// fact about any one page. Repeating it per page dilutes each chunk's relevance
// and lets near-identical chunks crowd out distinct results, so hoist it into a
// single shared block instead. Both bounds matter: the ratio catches templates
// in large datasets, the floor keeps small datasets (3-page health) intact.
const SHARED_CONTACT_MIN_PAGE_RATIO = 0.3;
const SHARED_CONTACT_MIN_PAGES = 3;
const NOISE_HEADING_PATTERNS = [
  /^related resources$/i,
  /^virtual tour$/i,
  /^follow ramapo$/i,
  /^search$/i,
  /^quick links$/i,
  /^main navigation$/i,
  /^intranet resources$/i,
  /^follow (?:public safety|ramapo)$/i,
  /^equity, diversity, inclusion/i,
  /^skip to/i,
  /^#\d+$/,
  /^\d+%$/,
];
const NOISE_TEXT_PATTERNS = [
  /apply\s+visit\s+give/i,
  /current students/i,
  /parents\s*&\s*families/i,
  /faculty\s*&\s*staff/i,
  /a-z index/i,
  /intranet/i,
  /search ramapo college website/i,
  /about ramapo/i,
  /visit ramapo/i,
  /news\s*&\s*media/i,
  /leadership/i,
  /additional resources/i,
  /careers/i,
  /consumer info/i,
];

interface ContextContact {
  name?: string;
  email?: string;
  phone?: string;
  office?: string;
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

function normalizeTitle(value: string | null, fallbackUrl: string): string {
  const normalized = normalizeText(value);
  if (normalized) {
    return normalized
      .replace(/\s+\|\|\s+Ramapo College of New Jersey$/i, '')
      .replace(/\s+-\s+Ramapo College of New Jersey$/i, '');
  }

  try {
    const url = new URL(fallbackUrl);
    const pathPart = url.pathname.replace(/\/$/, '').split('/').pop();
    if (pathPart) {
      return pathPart.replace(/[-_]/g, ' ');
    }
  } catch {
    return 'Untitled Page';
  }

  return 'Untitled Page';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function isNoiseHeading(value: string): boolean {
  return NOISE_HEADING_PATTERNS.some((pattern) => pattern.test(value));
}

function isNoiseText(value: string): boolean {
  // Preserve official care actions even when a shared navigation block also
  // contains otherwise noisy footer labels such as "Careers".
  if (/make an appointment|save your spot/i.test(value)) return false;
  return NOISE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function dedupeByKey<T>(items: T[], keyGetter: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  items.forEach((item) => {
    const key = keyGetter(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(item);
  });
  return output;
}

function pickSections(
  page: RawPageV1,
  maxSections: number,
  seenAcrossDataset: Set<string>,
  derivedSections: readonly ContextSection[] = []
): Array<{ heading: string; text: string }> {
  const candidates = [...derivedSections, ...page.sections]
    .map((section) => {
      const heading = normalizeText(section.heading) || 'Overview';
      const text = normalizeText(section.text);
      if (!text) return null;
      if (text.length < SECTION_MIN_LENGTH) return null;
      if (isNoiseHeading(heading)) return null;
      if (isNoiseText(text)) return null;

      return {
        heading,
        text: truncate(text, SECTION_MAX_LENGTH),
      };
    })
    .filter((section): section is { heading: string; text: string } => section !== null);

  return dedupeByKey(
    candidates,
    (section) => `${section.heading.toLowerCase()}|${section.text.toLowerCase()}`
  )
    .filter((section) => {
      const fingerprint = `${section.heading.toLowerCase()}|${section.text.toLowerCase()}`;
      if (seenAcrossDataset.has(fingerprint)) return false;
      seenAcrossDataset.add(fingerprint);
      return true;
    })
    .slice(0, maxSections);
}

function formatContact(contact: ContextContact): string {
  const parts: string[] = [];
  if (contact.name) parts.push(contact.name);
  if (contact.email) parts.push(`Email: ${contact.email}`);
  if (contact.phone) parts.push(`Phone: ${contact.phone}`);
  if (contact.office) parts.push(`Office: ${contact.office}`);
  return parts.join(' | ');
}

function contactFingerprint(contact: ContextContact): string {
  return [contact.name, contact.email, contact.phone, contact.office]
    .map((value) => value?.toLowerCase() || '')
    .join('|');
}

function pageContacts(page: RawPageV1): ContextContact[] {
  const contacts = page.contacts
    .map((contact) => ({
      name: normalizeText(contact.name),
      email: normalizeText(contact.email),
      phone: normalizeText(contact.phone),
      office: normalizeText(contact.office),
    }))
    .filter((contact) => contact.name || contact.email || contact.phone || contact.office);

  return dedupeByKey(contacts, contactFingerprint);
}

function pickContacts(
  page: RawPageV1,
  maxContacts: number,
  sharedFingerprints: ReadonlySet<string>
): ContextContact[] {
  return pageContacts(page)
    .filter((contact) => !sharedFingerprints.has(contactFingerprint(contact)))
    .slice(0, maxContacts);
}

/**
 * Contacts that recur across the dataset's pages, in first-seen page order so
 * the shared block stays stable between runs.
 */
function collectSharedContacts(pages: readonly RawPageV1[]): ContextContact[] {
  const occurrences = new Map<string, { contact: ContextContact; pages: number }>();
  pages.forEach((page) => {
    pageContacts(page).forEach((contact) => {
      const fingerprint = contactFingerprint(contact);
      const existing = occurrences.get(fingerprint);
      if (existing) {
        existing.pages += 1;
        return;
      }
      occurrences.set(fingerprint, { contact, pages: 1 });
    });
  });

  const threshold = Math.max(
    SHARED_CONTACT_MIN_PAGES,
    Math.ceil(pages.length * SHARED_CONTACT_MIN_PAGE_RATIO)
  );

  return Array.from(occurrences.values())
    .filter((entry) => entry.pages >= threshold)
    .map((entry) => entry.contact);
}

function pickDocuments(
  page: RawPageV1,
  maxDocuments: number
): Array<{ label: string; url: string }> {
  const docs = page.documents
    .map((doc) => ({
      label: normalizeText(doc.label),
      url: normalizeText(doc.url),
    }))
    .filter((doc): doc is { label: string; url: string } => Boolean(doc.label && doc.url));

  return dedupeByKey(docs, (doc) => `${doc.label.toLowerCase()}|${doc.url.toLowerCase()}`).slice(
    0,
    maxDocuments
  );
}

function getPageSortKey(page: RawPageV1): string {
  return `${page.sourceType === 'seed' ? '0' : '1'}|${page.title || ''}|${page.url}`;
}

function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function selectPages(dataset: RawDatasetV1, maxPages: number): RawPageV1[] {
  const successfulPages = dataset.pages
    .filter((page) => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400)
    .sort((a, b) => getPageSortKey(a).localeCompare(getPageSortKey(b)));

  const dedupedByUrl = new Map<string, RawPageV1>();
  successfulPages.forEach((page) => {
    const key = canonicalizeUrl(page.url);
    if (!dedupedByUrl.has(key)) {
      dedupedByUrl.set(key, page);
    }
  });

  const contentPages = Array.from(dedupedByUrl.values()).filter((page) => {
    const hasSections = page.sections.some((section) => normalizeText(section.text));
    const hasContacts = page.contacts.some(
      (contact) => contact.name || contact.email || contact.phone || contact.office
    );
    const hasDocuments = page.documents.length > 0;
    return hasSections || hasContacts || hasDocuments;
  });

  return contentPages.slice(0, maxPages);
}

function ensureOutputDir(filePath: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function generateCore6Markdown(options: Core6MarkdownOptions): void {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxSectionsPerPage = options.maxSectionsPerPage ?? DEFAULT_MAX_SECTIONS_PER_PAGE;
  const maxContactsPerPage = options.maxContactsPerPage ?? DEFAULT_MAX_CONTACTS_PER_PAGE;
  const maxDocumentsPerPage = options.maxDocumentsPerPage ?? DEFAULT_MAX_DOCUMENTS_PER_PAGE;

  if (!fs.existsSync(options.inputFilePath)) {
    console.error(`Error: normalized dataset not found at ${options.inputFilePath}`);
    process.exit(1);
  }

  let dataset: RawDatasetV1;
  try {
    const rawInput = JSON.parse(fs.readFileSync(options.inputFilePath, 'utf-8'));
    dataset = validateRawDatasetV1(rawInput);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating ${options.datasetName} normalized JSON: ${message}`);
    process.exit(1);
  }

  if (dataset.dataset !== options.datasetName) {
    console.error(
      `Error: expected dataset "${options.datasetName}" but found "${dataset.dataset}" in ${options.inputFilePath}`
    );
    process.exit(1);
  }

  const selectedPages = selectPages(dataset, maxPages);
  console.log(`Loaded ${dataset.pages.length} pages for ${options.datasetName}.`);
  console.log(`Selected ${selectedPages.length} pages for context markdown.`);

  let markdown = `# ${options.title}\n\n`;
  markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
  markdown += `${options.description}\n\n`;
  markdown += `- Dataset: ${dataset.dataset}\n`;
  markdown += `- Seed URLs: ${dataset.seedUrls.length}\n`;
  markdown += `- Pages Fetched: ${dataset.stats.pagesFetched}\n`;
  markdown += `- Pages Failed: ${dataset.stats.pagesFailed}\n`;
  markdown += `- Pages Included in Context: ${selectedPages.length}\n\n`;
  markdown += '---\n\n';

  if (selectedPages.length === 0) {
    markdown += 'No usable pages found.\n';
  } else {
    const sharedContacts = collectSharedContacts(selectedPages);
    const sharedContactFingerprints = new Set(sharedContacts.map(contactFingerprint));

    if (sharedContacts.length > 0) {
      markdown += `## ${options.title} Contacts\n\n`;
      markdown += `These contacts apply across ${options.title.toLowerCase()} pages.\n\n`;
      sharedContacts.forEach((contact) => {
        markdown += `- ${formatContact(contact)}\n`;
      });
      markdown += '\n---\n\n';
    }

    const seenSections = new Set<string>();
    selectedPages.forEach((page) => {
      const title = normalizeTitle(page.title, page.url);
      const sections = pickSections(
        page,
        maxSectionsPerPage,
        seenSections,
        options.derivedSections?.(page)
      );
      const contacts = pickContacts(page, maxContactsPerPage, sharedContactFingerprints);
      const documents = pickDocuments(page, maxDocumentsPerPage);

      markdown += `## ${title}\n\n`;
      markdown += `- URL: ${page.url}\n`;
      markdown += `- Source Type: ${page.sourceType}\n`;
      if (page.statusCode !== null) {
        markdown += `- Status: ${page.statusCode}\n`;
      }
      markdown += '\n';

      if (sections.length > 0) {
        markdown += '### Key Details\n\n';
        sections.forEach((section) => {
          markdown += `- **${section.heading}:** ${section.text}\n`;
        });
        markdown += '\n';
      }

      if (contacts.length > 0) {
        markdown += '### Contacts\n\n';
        contacts.forEach((contact) => {
          markdown += `- ${formatContact(contact)}\n`;
        });
        markdown += '\n';
      }

      if (documents.length > 0) {
        markdown += '### Documents\n\n';
        documents.forEach((document) => {
          markdown += `- ${document.label}: ${document.url}\n`;
        });
        markdown += '\n';
      }

      markdown += '---\n\n';
    });
  }

  ensureOutputDir(options.outputFilePath);
  fs.writeFileSync(options.outputFilePath, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${options.outputFilePath}`);
}
