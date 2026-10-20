/**
 * How-to entries: what an office's page says a student can do or must know, one entry per task,
 * written once per page by a model when the page changes and held to the page's own words.
 *
 * Section search answered "how do I start a club" with the protest procedure, because it shares
 * words. An entry names its task in plain words ("Start a new student club"), who it is for, the
 * office the page says handles it, the term it is for, and its steps; every step carries a quote
 * copied from the page. Code keeps a step only while its quote is on the page and every number,
 * email and web address it states is in its quote, and an entry only while a step remains. The
 * model reads; code decides what is kept.
 */
import { createHash } from 'crypto';
import type { OfficeSection } from './office-sections';

export interface HowtoStep { text: string; quote: string }
export interface HowtoEntry {
  task: string;
  /** Who it is for, in the page's terms ("graduate students"); empty when everyone. */
  applies_to: string;
  /** The office the page says does it, when not the page's own office; else empty. */
  handled_by: string;
  /** The term or year the page says it is for ("Spring 2026"); empty when not dated. */
  term: string;
  /** The heading of the section it comes from. */
  section: string;
  steps: HowtoStep[];
}

/** The model's instructions. The page's sections follow as JSON. */
export const HOWTO_PROMPT = `You read one page of a Ramapo College office's website and list what it tells a student,
parent or visitor how to do, or the rules they must know: a procedure, a requirement, a deadline,
a fee, who is eligible, what happens if. One entry per distinct task.

For each entry:
- task: the task in plain words a student would use, starting with a verb ("Request an official
  transcript", "Appeal a final grade", "Get a commuter parking permit"). Name exactly what the page
  covers; a page about protests is not about starting a club.
- applies_to: who it is for when the page says (e.g. "graduate students", "College employees",
  "residents of Laurel Hall"); empty when it is for everyone.
- handled_by: the office the page says handles it when that is a different office from the page's
  own (an orientation page saying Public Safety issues permits); else empty.
- term: the term or year the page says it is for ("Spring 2026", "2025-2026"); else empty.
- section: the heading of the section it comes from, exactly as given.
- steps: what to do or know, in order, each a short plain sentence (text) and the words of the page
  that say it (quote), copied exactly, at most 300 characters. Every number, date, amount, email and
  web address in a step's text must be in its quote.

Leave out navigation, staff lists, contact blocks, office hours, news, event listings and
marketing. If the page tells nothing a student can do or must know, return no entries. Never add
anything the page does not say.`;

export const HOWTO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['entries'],
  properties: { entries: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['task', 'applies_to', 'handled_by', 'term', 'section', 'steps'],
    properties: {
      task: { type: 'string' }, applies_to: { type: 'string' }, handled_by: { type: 'string' },
      term: { type: 'string' }, section: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'quote'],
        properties: { text: { type: 'string' }, quote: { type: 'string' } } } },
    } } } },
} as const;

/** What the model is shown for a page: its address and headed sections. */
export function pageInput(url: string, sections: readonly OfficeSection[]): string {
  return JSON.stringify({ page: url, sections: sections.map(section => ({ heading: section.heading, text: section.text })) });
}

/** The cache key of a page's entries: the prompt and the page's sections, so either changing reads it again. */
export function entriesKey(url: string, sections: readonly OfficeSection[]): string {
  return createHash('sha256').update(HOWTO_PROMPT).update(pageInput(url, sections)).digest('hex');
}

const folded = (text: string) => text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim().toLowerCase();
const STATED = /(?:https?:\/\/\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\$?\d[\d,.:/-]*)/g;
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * The entries a page holds: each step's quote must be in the page's text, and every number, email
 * and web address its text states must be in its quote; an entry needs a task and a kept step.
 * Its section must be one of the page's headings (else the first section that holds its first quote).
 */
export function verifiedEntries(raw: unknown, sections: readonly OfficeSection[]): HowtoEntry[] {
  const list = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  const texts = sections.map(section => folded(`${section.heading} ${section.text}`));
  const page = texts.join(' ');
  const kept: HowtoEntry[] = [];
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const task = clean(entry.task, 160);
    if (!task || !Array.isArray(entry.steps)) continue;
    const steps: HowtoStep[] = [];
    for (const step of entry.steps as Array<Record<string, unknown>>) {
      const text = clean(step?.text, 600), quote = clean(step?.quote, 400);
      if (!text || quote.length < 12 || !page.includes(folded(quote))) continue;
      const said = folded(quote);
      if ((text.match(STATED) ?? []).some(value => !said.includes(folded(value).replace(/[.,:;]+$/, '')))) continue;
      steps.push({ text, quote });
    }
    if (!steps.length) continue;
    const named = clean(entry.section, 200);
    const section = sections.find(candidate => candidate.heading === named)?.heading
      ?? sections[texts.findIndex(text => text.includes(folded(steps[0].quote)))]?.heading ?? '';
    kept.push({ task, applies_to: clean(entry.applies_to, 200), handled_by: clean(entry.handled_by, 120),
      term: clean(entry.term, 60), section, steps });
  }
  return kept;
}
