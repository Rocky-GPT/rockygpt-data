/**
 * @module data-v2/repositories/search-terms
 * Removes words that cannot identify a record, before a strict lookup runs.
 *
 * Structured lookups require every query term to appear in the record, which is
 * what keeps them from answering the wrong thing. The failure was never that
 * rule — it was feeding it words that describe the *question* rather than the
 * thing being asked about: "when does the library close tonight" failed against
 * "Library (Main Building)" purely because of "tonight".
 *
 * Loosening the match to any-term was tried and rejected: it let a single
 * generic word drive the answer, so "bursar office contact" returned the
 * Registrar on the word "office" and "zzz nonexistent studies" returned
 * Africana Studies on "studies". A confidently wrong answer is worse than a
 * deferral in a system built to fail closed.
 *
 * So the match stays strict and the junk is removed first, from three sources:
 * a fixed list of words that phrase questions in any domain, a per-table
 * measurement of words too common in that table to distinguish anything, and a
 * per-table list of words naming what the table *is*.
 *
 * That third source exists because the measurement cannot see these words at
 * all. Frequency pruning only discards words that appear *in the records*, but
 * "clubs" never appears inside a club's own name, so it measures as maximally
 * distinctive while identifying nothing — and "what clubs can i join" then
 * required a record literally containing "clubs". Only the caller knows which
 * noun names its own table, so each finder passes its own.
 */

/**
 * Words that ask a question or name a generic attribute, never a specific
 * record. Deliberately small and domain-independent; anything corpus-specific
 * belongs to the measured frequencies instead, because a hand-written list
 * cannot anticipate every dataset.
 */
export const GENERIC_QUERY_WORDS = new Set([
  // asking
  'what', 'whats', 'when', 'where', 'who', 'whos', 'which', 'how', 'why', 'is', 'are', 'was',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'am',
  // filler
  'the', 'a', 'an', 'of', 'for', 'to', 'about', 'at', 'in', 'on', 'and', 'or', 'my', 'me',
  'you', 'your', 'their', 'there', 'this', 'that', 'it', 'be', 'get', 'got', 'please',
  'any', 'some', 'with', 'from', 'still', 'also', 'just', 'need', 'want', 'tell', 'know',
  'find', 'looking', 'look', 'help', 'give', 'list', 'all', 'info', 'information',
  // time framing
  'hour', 'hours', 'open', 'opens', 'opening', 'close', 'closes', 'closed', 'closing',
  'today', 'tonight', 'tomorrow', 'yesterday', 'now', 'currently', 'time', 'times',
  'morning', 'afternoon', 'evening', 'night', 'week', 'weekend', 'weekday', 'schedule',
  'date', 'dates', 'day', 'days', 'deadline',
  // generic attributes of a record
  'office', 'contact', 'phone', 'number', 'email', 'department', 'dept', 'location',
  'degree', 'program', 'programs', 'requirement', 'requirements', 'major', 'majors',
]);

/** How often each word appears across the searchable text of one table. */
export interface TermFrequencies {
  rowCount: number;
  documentFrequency: Map<string, number>;
}

/**
 * A word is only discarded as too common when it is both a large share of the
 * table and present in several rows. The share alone is misleading on a small
 * table: two of eighteen campus contacts is 11%, which would have thrown away
 * "public" and "safety" and made "public safety" unanswerable.
 */
const COMMON_SHARE = 0.1;
const COMMON_MINIMUM_ROWS = 4;

export function splitQueryWords(
  query: string,
  domainWords?: ReadonlySet<string>
): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) =>
        word.length > 1 && !GENERIC_QUERY_WORDS.has(word) && !domainWords?.has(word)
    );
}

export function buildTermFrequencies(texts: string[]): TermFrequencies {
  const documentFrequency = new Map<string, number>();
  for (const text of texts) {
    // Counted once per row: a word repeated inside one record says nothing
    // about how well it separates that record from the others.
    const seen = new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 1)
    );
    for (const word of seen) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  }
  return { rowCount: texts.length, documentFrequency };
}

function isTooCommon(word: string, frequencies: TermFrequencies): boolean {
  const count = frequencies.documentFrequency.get(word) || 0;
  return count >= COMMON_MINIMUM_ROWS && count / frequencies.rowCount > COMMON_SHARE;
}

/**
 * The query to run, and a fallback to try if it finds nothing. The fallback
 * keeps every non-generic word, so over-pruning cannot make an answerable
 * question unanswerable — it can only cost one extra query.
 */
export interface SearchTerms {
  primary: string;
  fallback: string | null;
}

export function searchTermsFor(
  query: string,
  frequencies: TermFrequencies,
  domainWords?: ReadonlySet<string>
): SearchTerms {
  const words = splitQueryWords(query, domainWords);
  if (!words.length) return { primary: '', fallback: null };

  const distinctive = words.filter((word) => !isTooCommon(word, frequencies));
  const primary = (distinctive.length ? distinctive : words).join(' ');
  const fallback = distinctive.length && distinctive.length < words.length ? words.join(' ') : null;
  return { primary, fallback };
}
