import { load } from 'cheerio';

const INTERNAL_METADATA_MARKERS = [
  'Organization:',
  'Event Name:',
  'Event Locator:',
  'Categories:',
  'Expected Headcount:',
  'Is this event is a fundraiser?',
];

function decodeHtml(value: string): string {
  const withLineBreaks = value.replace(/(?:&lt;|<)br\s*\/?(?:&gt;|>)/gi, '\n');
  return load(`<div>${withLineBreaks}</div>`).text();
}

/**
 * Converts event descriptions to readable text and rejects internal Archway form metadata.
 */
export function sanitizeEventDescription(value?: string | null): string | undefined {
  if (!value) return undefined;

  const decoded = decodeHtml(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!decoded) return undefined;

  const markerCount = INTERNAL_METADATA_MARKERS.filter((marker) =>
    decoded.toLowerCase().includes(marker.toLowerCase())
  ).length;

  if (markerCount >= 2) {
    return undefined;
  }

  return decoded;
}
