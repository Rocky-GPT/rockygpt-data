import path from 'node:path';
import type { StructuredDirectoryContact } from '../src/directory/structured-contacts';

/** A reviewed office whose pages no longer back some reviewed facts, and what this release leaves out. */
export interface ChangedOffice { name: string; leftOut: string[] }

export interface OfficeReviewCheck {
  /** A mistake in the reviewed files themselves: publication must stop. */
  blocking: string[];
  /**
   * Offices whose pages changed under a reviewed fact. This release publishes only what tonight's
   * pages still state for them (the builder already left the rest out); they wait for a review.
   */
  changed: ChangedOffice[];
  /** Offices whose pages show values nobody reviewed yet. They are never published facts. */
  toReview: string[];
}

const short = (text: string, limit = 90) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * Completed manual office reviews must not silently degrade on a later refresh, and one office's
 * page edit must not hold back every other source's fresh data (11-08..11-10, 2026: a new coach
 * line and a renamed heading stopped three nightly publishes and kept menus and events three days
 * old). So a reviewed fact the pages no longer back (a value withheld, an absence or note no
 * longer confirmed, a lost website, an unreadable cited section) is left out of this release,
 * never published from the older reading, and the office is listed for another review; every
 * other office and source publishes. The same rule already holds for reviewed topics
 * (src/data-v2/campus-topics.ts) and for every contact without a completed review.
 *
 * A mistake in the reviewed files themselves still stops publication: a reviewed name that is not
 * exactly one office contact, or a field nobody reviewed that is empty with nothing on the pages
 * having changed. New discovery candidates only ask for another review: a candidate never
 * becomes a fact.
 */
export function checkCompletedOfficeReviews(reviewedNames: readonly string[],
  contacts: readonly StructuredDirectoryContact[]): OfficeReviewCheck {
  const blocking: string[] = [];
  const changed: ChangedOffice[] = [];
  const toReview: string[] = [];
  for (const name of reviewedNames) {
    const matches = contacts.filter(contact => contact.name === name && contact.type === 'office');
    const evidence = matches.length === 1 ? matches[0].evidence : undefined;
    const review = evidence?.contact_review;
    if (!evidence || !review) {
      blocking.push(`${name}: is not exactly one reviewed office contact with checked evidence. Inspect src/reference/directory-contacts.json.`);
      continue;
    }
    const leftOut = [
      ...evidence.withheld.map(item => `${item.field} ${item.value}: ${item.reason}`),
      // One line per field: a claim usually cites several sections, each with its own reason.
      ...[...new Set(evidence.absence_issues.map(issue => issue.field))].map(field =>
        `the note that no ${field} is published: ${[...new Set(evidence.absence_issues
          .filter(issue => issue.field === field).map(issue => issue.reason))].join(' ')}`),
      ...(evidence.website_issue ? [`website ${evidence.website_issue.url}: ${evidence.website_issue.reason}`] : []),
      ...(evidence.contact_note_issues ?? []).map(issue => `contact instruction "${short(issue.text)}": ${issue.reason}`),
      ...(evidence.contact_preference_issue ? [`preferred contact method: ${evidence.contact_preference_issue}`] : []),
    ];
    // A cited section that could not be read is already named by the fact it backed; say it on
    // its own only when nothing else did.
    for (const section of review.unavailable_sections) {
      if (!leftOut.some(line => line.includes(section.reason))) {
        leftOut.push(`section "${section.section}" of ${section.url} could not be read: ${section.reason}`);
      }
    }
    if (leftOut.length) {
      changed.push({ name, leftOut });
      continue;
    }
    const contact = matches[0];
    const reviewedFields = { department: contact.department, email: contact.email,
      phone: contact.phone || contact.phones?.length, office: contact.office || contact.offices?.length,
      prefers_email: contact.prefers_email, preferred_contact: contact.preferred_contact,
      contact_note: contact.contact_note };
    const missing = Object.entries(reviewedFields).filter(([field, value]) =>
      (value === undefined || value === null || value === '' || value === 0)
      && !evidence.not_published.some(absence => absence.field === field)).map(([field]) => field);
    if (missing.length) blocking.push(`${name}: unreviewed missing field(s) ${missing.join(', ')}.`);
    else if (!evidence.website) blocking.push(`${name}: needs a checked website.`);
    else if (review.status !== 'no_unrecorded_values_in_scanned_sections') {
      const candidates = review.unrecorded.reduce((total, item) => total + item.found.length, 0);
      toReview.push(`${name}: ${candidates} unreviewed candidate(s), ${review.exclusion_issues.length} exclusion(s) whose section changed.`);
    }
  }
  return { blocking, changed, toReview };
}

/** Where a publish that left out reviewed office facts leaves its note for the data-refresh incident. */
export const CHANGED_OFFICES_REPORT = path.join('data', 'review', 'refresh-changed-offices.md');

/** The changed offices as a review note, or null when every reviewed office fact still holds. */
export function changedOfficesReport(changed: readonly ChangedOffice[]): string | null {
  if (!changed.length) return null;
  return ['Left out these reviewed office facts because their pages changed. Each office publishes only what',
    'tonight\'s pages still state until it is reviewed again in `src/reference/directory-contacts.json`',
    '(the "Show changed office review sections" workflow prints each changed section, old and new):', '',
    ...changed.flatMap(office => [`- **${office.name}**`, ...office.leftOut.map(line => `  - ${line}`)]), ''].join('\n');
}
