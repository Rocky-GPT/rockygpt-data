/** Only manually reviewed, unchanged source sections can establish a missing hours field. */
import { createHash } from 'node:crypto';
import reviewData from '../src/reference/office-hours-review.json';
import { buildRawPageFromHtml } from './raw-collector';
import type { HoursSourceCapture } from './campus-hours';
import type { LocationHours, ReviewedHoursAbsence } from './schema';

interface Review {
  schedule: string;
  source_url: string;
  scope: string;
  reason: string;
  missing_weekdays: string[];
  missing_validity: Array<'valid_from' | 'valid_until'>;
  checks: Array<{ url: string; section: string; section_sha256: string }>;
}

const reviews = reviewData.schedules as Review[];
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

export function attachReviewedHoursAbsences(records: LocationHours[], captures: HoursSourceCapture[]): LocationHours[] {
  const pages = new Map<string, ReturnType<typeof buildRawPageFromHtml>>();
  const check = (ref: Review['checks'][number]): ReviewedHoursAbsence['checks'][number] => {
    const sources = captures.filter(source => source.sourceUrl === ref.url);
    if (sources.length !== 1) throw new Error(`Reviewed hours omission needs one source capture: ${ref.url}`);
    const source = sources[0];
    if (!Number.isFinite(Date.parse(source.collectedAt)) || !source.html.trim()) {
      throw new Error(`Reviewed hours omission has an invalid source capture: ${ref.url}`);
    }
    if (!pages.has(ref.url)) pages.set(ref.url, buildRawPageFromHtml({
      url: ref.url, html: source.html, sourceType: 'seed', statusCode: 200,
      fetchedAt: source.collectedAt, allowedHost: new URL(ref.url).hostname,
    }));
    const sections = pages.get(ref.url)!.sections.filter(section => section.heading === ref.section
      && hash(`${section.heading}\n${section.text}`) === ref.section_sha256);
    if (sections.length !== 1) {
      throw new Error(`Reviewed hours section changed; review omissions before publication: ${ref.url} — ${ref.section}`);
    }
    return { url: ref.url, section: ref.section, checked_at: source.collectedAt, html_sha256: hash(source.html) };
  };

  return records.map(record => {
    const matches = reviews.filter(review => review.schedule === record.name && review.source_url === record.sourceUrl);
    if (!matches.length) return record;
    if (matches.length !== 1) throw new Error(`Duplicate reviewed hours omissions: ${record.name}`);
    const review = matches[0];
    const checks = review.checks.map(check);
    if (!checks.some(proof => proof.url === record.sourceUrl && proof.checked_at === record.collectedAt)) {
      throw new Error(`Reviewed hours omission is not bound to its source record: ${record.name}`);
    }
    const claims: ReviewedHoursAbsence[] = [];
    if (review.missing_weekdays.length) {
      if (record.availabilityIssue || review.missing_weekdays.some(day => record.hours[day] !== 'Hours unavailable')) {
        throw new Error(`Reviewed missing weekdays contradict the captured schedule: ${record.name}`);
      }
      claims.push({ field: 'weekday_hours', days: review.missing_weekdays,
        scope: review.scope, reason: review.reason, checks });
    }
    for (const field of review.missing_validity) {
      if (field === 'valid_from' ? record.validFrom : record.validUntil) {
        throw new Error(`Reviewed missing validity contradicts the captured schedule: ${record.name} ${field}`);
      }
      claims.push({ field, scope: review.scope, reason: review.reason, checks });
    }
    if (!claims.length) return record;
    return { ...record, normalization_metadata: { evidence: { schedule: {
      ...record.normalization_metadata?.evidence?.schedule, not_published: claims,
    } } } };
  });
}
