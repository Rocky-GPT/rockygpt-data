/**
 * Ramapo's public program pages as the identity compiler reads them: each page's record ID
 * and the catalog codes of the programs the page links as its own. The pages themselves are
 * published whole as the `major-pages` release artifact.
 *
 * @module data-v2/major-pages
 */
export const MAJOR_PAGES_SOURCE_KEY = 'major-pages';
export interface MajorPageLink { id: string; programCodes: string[]; limitations: string[] }
/** The pages a captured artifact publishes; anything else is refused rather than half-read. */
export function majorPagesInput(value: unknown): MajorPageLink[] {
  if (value === undefined || value === null) return [];
  const pages = value && typeof value === 'object' ? (value as { pages?: unknown }).pages : undefined;
  if (!Array.isArray(pages)) throw new Error('Expected the major pages artifact.');
  return pages.map(page => {
    const record = page && typeof page === 'object' ? page as Record<string, unknown> : {};
    const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string') ? items as string[] : null;
    const programCodes = strings(record.programCodes);
    const limitations = strings(record.limitations ?? []);
    if (typeof record.id !== 'string' || !record.id || !programCodes || !limitations) throw new Error('A major page has no ID or program links.');
    return { id: record.id, programCodes, limitations };
  });
}
