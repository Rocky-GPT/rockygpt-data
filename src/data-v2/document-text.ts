import fs from 'node:fs';
import path from 'node:path';

/**
 * Ingestion bookkeeping written into context markdown by the generators.
 * These lines describe how the corpus was scraped and are never campus facts,
 * so they must not survive into an answerable chunk.
 */
const INGESTION_METADATA_LINE =
  /^[ \t]*(?:\*Generated \(UTC\):[^\n]*\*?|Context extracted from[^\n]*|-\s*(?:Dataset|Seed URLs?|Pages Fetched|Pages Failed|Pages Included in Context|Source Type|Status):[^\n]*)[ \t]*$/gim;

/** The specific official page a context section was extracted from. */
const SECTION_URL_LINE = /^[ \t]*-\s*URL:\s*(https?:\/\/\S+)[ \t]*$/im;

export function extractSectionUrl(text: string): string | undefined {
  return text.match(SECTION_URL_LINE)?.[1];
}

export function stripIngestionMetadata(text: string): string {
  return text
    .replace(new RegExp(SECTION_URL_LINE.source, 'gim'), '')
    .replace(INGESTION_METADATA_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keep document ingestion and indexing on the exact same chunks. */
export function chunkDocumentText(
  text: string,
  maxChars = 1_250,
  overlap = 220
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const output: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + maxChars);
    if (end < normalized.length) {
      const boundary = Math.max(
        normalized.lastIndexOf('\n', end),
        normalized.lastIndexOf('. ', end)
      );
      if (boundary > cursor + maxChars / 2) end = boundary + 1;
    }
    output.push(normalized.slice(cursor, end).trim());
    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return output.filter(Boolean);
}

export interface SectionChunk {
  content: string;
  canonicalUrl?: string;
  headingPath?: string;
}

/**
 * Chunk within Markdown sections so citations and headings survive ingestion.
 * Large sections are subdivided with the same bounded overlap as legacy
 * chunks, but overlap never crosses into a different source page.
 */
export function chunkDocumentSections(text: string): SectionChunk[] {
  const withoutFrontmatter = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const rawSections = withoutFrontmatter.split(/\n(?=#{1,3}\s)/);
  const headings: Array<string | undefined> = [];
  const urls: Array<string | undefined> = [];
  const chunks: SectionChunk[] = [];

  for (const rawSection of rawSections) {
    const heading = rawSection.match(/^(#{1,3})\s+(.+)$/m);
    const level = heading?.[1].length || 0;
    if (level > 0) {
      headings[level - 1] = heading?.[2].trim();
      headings.length = level;
      // A sibling starts a new source scope; nested headings may inherit only
      // from their ancestors, never from a previous sibling page.
      urls.length = level;
      urls[level - 1] = undefined;
    }

    const sectionUrl = extractSectionUrl(rawSection);
    if (sectionUrl && level > 0) urls[level - 1] = sectionUrl;
    const canonicalUrl = sectionUrl || [...urls].reverse().find(Boolean);
    const cleaned = stripIngestionMetadata(rawSection);
    if (cleaned.length <= 40) continue;
    const headingPath = headings.filter(Boolean).join(' › ') || undefined;
    for (const content of chunkDocumentText(cleaned)) {
      chunks.push({ content, canonicalUrl, headingPath });
    }
  }
  return chunks;
}

export function listMarkdownFiles(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => path.join(root, entry));
}
