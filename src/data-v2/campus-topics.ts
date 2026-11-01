/**
 * Topics: ramapo.edu sites with no office behind them (Scholarships, Summer Session, Parents &
 * Families). Each points to the offices its own page names, quoted from one captured section; a
 * retired topic (a program that ended, a center that left) says so in its page's own words. A
 * topic publishes only when that section is in this run's capture with the reviewed text and
 * still holds the quote, and every office it names is an identity in the graph by exact name.
 * A topic whose page changed is withheld until it is reviewed again; the other topics publish.
 */
import path from 'node:path';
import { type CapturedPage, contactSectionHash, evidenceText, pageKey } from '../directory/contact-evidence';

export interface ReviewedTopic {
  name: string;
  aliases: string[];
  status: 'current' | 'retired';
  /** Exact names of graph identities with contacts, in the order the page gives them. */
  handled_by: string[];
  evidence: TopicEvidence;
  /** Further sections of the topic's own pages, each with the offices it names. */
  more_evidence?: Array<TopicEvidence & { handled_by: string[] }>;
  /** Where a retired topic's page sends people, when it says. */
  refer_url?: string;
  note: string;
}
/** A quote may be exact pieces of its section, in page order, joined by " … ". */
export interface TopicEvidence { url: string; section: string; text_sha256: string; quote: string }
export interface ReviewedTopics { schema_version: 1; reviewed_on: string; topics: ReviewedTopic[] }
export interface CheckedTopic extends ReviewedTopic { checked_at: string }
/** A topic left out of this release because Ramapo's page no longer says what was reviewed. */
export interface WithheldTopic { name: string; reason: string }
export interface TopicCheck { topics: CheckedTopic[]; withheld: WithheldTopic[] }

const words = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Why a cited section no longer backs a topic: gone, changed, or without its quoted words. */
function sectionProblem(item: TopicEvidence, pages: ReadonlyMap<string, CapturedPage>): string | null {
  const found = evidenceText({ url: item.url, section: item.section, fields: [] }, pages);
  if ('reason' in found) return found.reason;
  if (contactSectionHash(found.text) !== item.text_sha256) {
    return `the section "${item.section}" of ${item.url} changed; review the topic again`;
  }
  const text = words(found.text);
  let from = 0;
  for (const piece of item.quote.split(' … ').map(words)) {
    const at = text.indexOf(piece, from);
    if (!piece || at < 0) return 'the quote is not in its section';
    from = at + piece.length;
  }
  return null;
}

/**
 * The topics whose cited sections still say what was reviewed. A topic whose page changed (gone,
 * section changed, quote missing) is withheld with the reason, never published from the older
 * reading, and the rest publish: one page Ramapo edits must not hold back every source (11-01, the
 * Emergency page's retirement stopped the daily publish). A mistake in the reviewed file itself (a
 * duplicate, an office the graph lacks, a retired topic naming offices) is still an error.
 */
export function checkTopics(reviewed: ReviewedTopics, pages: ReadonlyMap<string, CapturedPage>,
  identityNames: ReadonlySet<string>): TopicCheck {
  const problems: string[] = [];
  const checked: CheckedTopic[] = [];
  const withheld: WithheldTopic[] = [];
  const seen = new Set<string>();
  for (const topic of reviewed.topics) {
    const fail = (why: string) => problems.push(`${topic.name}: ${why}`);
    if (seen.has(topic.name)) { fail('listed twice'); continue; }
    seen.add(topic.name);
    if (identityNames.has(topic.name)) { fail('is already the name of an identity'); continue; }
    if (topic.status === 'current' ? !topic.handled_by.length : topic.handled_by.length) {
      fail(topic.status === 'current' ? 'names no office' : 'is retired but names offices');
      continue;
    }
    const missing = topic.handled_by.filter(name => !identityNames.has(name));
    if (missing.length) { fail(`names ${missing.join(', ')}, which the graph has no identity for`); continue; }
    const extra = topic.more_evidence ?? [];
    const stray = extra.flatMap(item => item.handled_by).filter(name => !topic.handled_by.includes(name));
    if (stray.length) { fail(`cites a section for ${stray.join(', ')}, which it does not list`); continue; }
    const why = [topic.evidence, ...extra].map(item => sectionProblem(item, pages)).find(Boolean);
    if (why) { withheld.push({ name: topic.name, reason: why }); continue; }
    checked.push({ ...topic, checked_at: pages.get(pageKey(topic.evidence.url))?.fetchedAt || '' });
  }
  if (problems.length) throw new Error(`Reviewed topics need review:\n${problems.join('\n')}`);
  return { topics: checked, withheld };
}

/** Where a publish that withheld topics leaves its note for the data-refresh incident. */
export const WITHHELD_TOPICS_REPORT = path.join('data', 'review', 'refresh-withheld-topics.md');

/** The withheld topics as a review note, or null when every topic published. */
export function withheldTopicsReport(withheld: readonly WithheldTopic[]): string | null {
  if (!withheld.length) return null;
  return ['Withheld these reviewed topics because their pages changed; review each again in',
    '`src/reference/campus-topics.json`:', '',
    ...withheld.map(topic => `- ${topic.name}: ${topic.reason}`), ''].join('\n');
}
