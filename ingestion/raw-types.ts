export type RawDatasetV1 = {
  version: '1.0';
  dataset: string;
  collectedAt: string;
  seedUrls: string[];
  stats: { pagesFetched: number; pagesFailed: number; externalLinksSeen: number };
  pages: RawPageV1[];
};

export type RawPageV1 = {
  url: string;
  sourceType: 'seed' | 'detail';
  fetchedAt: string;
  statusCode: number | null;
  title: string | null;
  links: string[];
  externalLinks: string[];
  sections: { heading: string; text: string }[];
  lists: string[][];
  tables: { headers: string[]; rows: string[][] }[];
  contacts: { name?: string; email?: string; phone?: string; office?: string }[];
  documents: { label: string; url: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asStringArray(value: unknown, path: string): string[] {
  assert(Array.isArray(value), `${path} must be an array`);
  value.forEach((entry, index) => {
    assert(typeof entry === 'string', `${path}[${index}] must be a string`);
  });
  return value as string[];
}

function asOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  assert(typeof value === 'string', `${path} must be a string when present`);
  return value;
}

function validateRawPageV1(page: unknown, index: number): RawPageV1 {
  const pathPrefix = `pages[${index}]`;
  assert(isRecord(page), `${pathPrefix} must be an object`);

  assert(typeof page.url === 'string', `${pathPrefix}.url must be a string`);
  assert(page.sourceType === 'seed' || page.sourceType === 'detail', `${pathPrefix}.sourceType must be seed or detail`);
  assert(typeof page.fetchedAt === 'string', `${pathPrefix}.fetchedAt must be a string`);
  assert(
    page.statusCode === null || (typeof page.statusCode === 'number' && Number.isFinite(page.statusCode)),
    `${pathPrefix}.statusCode must be a number or null`
  );
  assert(page.title === null || typeof page.title === 'string', `${pathPrefix}.title must be a string or null`);

  const links = asStringArray(page.links, `${pathPrefix}.links`);
  const externalLinks = asStringArray(page.externalLinks, `${pathPrefix}.externalLinks`);

  assert(Array.isArray(page.sections), `${pathPrefix}.sections must be an array`);
  const sections = page.sections.map((section, sectionIndex) => {
    assert(isRecord(section), `${pathPrefix}.sections[${sectionIndex}] must be an object`);
    assert(typeof section.heading === 'string', `${pathPrefix}.sections[${sectionIndex}].heading must be a string`);
    assert(typeof section.text === 'string', `${pathPrefix}.sections[${sectionIndex}].text must be a string`);
    return { heading: section.heading, text: section.text };
  });

  assert(Array.isArray(page.lists), `${pathPrefix}.lists must be an array`);
  const lists = page.lists.map((list, listIndex) => asStringArray(list, `${pathPrefix}.lists[${listIndex}]`));

  assert(Array.isArray(page.tables), `${pathPrefix}.tables must be an array`);
  const tables = page.tables.map((table, tableIndex) => {
    assert(isRecord(table), `${pathPrefix}.tables[${tableIndex}] must be an object`);
    const headers = asStringArray(table.headers, `${pathPrefix}.tables[${tableIndex}].headers`);

    assert(Array.isArray(table.rows), `${pathPrefix}.tables[${tableIndex}].rows must be an array`);
    const rows = table.rows.map((row, rowIndex) =>
      asStringArray(row, `${pathPrefix}.tables[${tableIndex}].rows[${rowIndex}]`)
    );

    return { headers, rows };
  });

  assert(Array.isArray(page.contacts), `${pathPrefix}.contacts must be an array`);
  const contacts = page.contacts.map((contact, contactIndex) => {
    assert(isRecord(contact), `${pathPrefix}.contacts[${contactIndex}] must be an object`);
    return {
      name: asOptionalString(contact.name, `${pathPrefix}.contacts[${contactIndex}].name`),
      email: asOptionalString(contact.email, `${pathPrefix}.contacts[${contactIndex}].email`),
      phone: asOptionalString(contact.phone, `${pathPrefix}.contacts[${contactIndex}].phone`),
      office: asOptionalString(contact.office, `${pathPrefix}.contacts[${contactIndex}].office`),
    };
  });

  assert(Array.isArray(page.documents), `${pathPrefix}.documents must be an array`);
  const documents = page.documents.map((document, docIndex) => {
    assert(isRecord(document), `${pathPrefix}.documents[${docIndex}] must be an object`);
    assert(typeof document.label === 'string', `${pathPrefix}.documents[${docIndex}].label must be a string`);
    assert(typeof document.url === 'string', `${pathPrefix}.documents[${docIndex}].url must be a string`);
    return { label: document.label, url: document.url };
  });

  return {
    url: page.url,
    sourceType: page.sourceType,
    fetchedAt: page.fetchedAt,
    statusCode: page.statusCode,
    title: page.title,
    links,
    externalLinks,
    sections,
    lists,
    tables,
    contacts,
    documents,
  };
}

export function validateRawDatasetV1(input: unknown): RawDatasetV1 {
  assert(isRecord(input), 'raw dataset must be an object');
  assert(input.version === '1.0', 'raw dataset version must be 1.0');
  assert(typeof input.dataset === 'string', 'raw dataset.dataset must be a string');
  assert(typeof input.collectedAt === 'string', 'raw dataset.collectedAt must be a string');

  const seedUrls = asStringArray(input.seedUrls, 'raw dataset.seedUrls');

  assert(isRecord(input.stats), 'raw dataset.stats must be an object');
  assert(typeof input.stats.pagesFetched === 'number', 'raw dataset.stats.pagesFetched must be a number');
  assert(typeof input.stats.pagesFailed === 'number', 'raw dataset.stats.pagesFailed must be a number');
  assert(typeof input.stats.externalLinksSeen === 'number', 'raw dataset.stats.externalLinksSeen must be a number');

  assert(Array.isArray(input.pages), 'raw dataset.pages must be an array');
  const pages = input.pages.map((page, index) => validateRawPageV1(page, index));

  return {
    version: '1.0',
    dataset: input.dataset,
    collectedAt: input.collectedAt,
    seedUrls,
    stats: {
      pagesFetched: input.stats.pagesFetched,
      pagesFailed: input.stats.pagesFailed,
      externalLinksSeen: input.stats.externalLinksSeen,
    },
    pages,
  };
}
