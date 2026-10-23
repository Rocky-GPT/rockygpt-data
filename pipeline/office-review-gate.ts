import type { StructuredDirectoryContact } from '../src/directory/structured-contacts';

export interface OfficeReviewCheck {
  /** Offices whose published contact facts would degrade: publication must stop. */
  blocking: string[];
  /** Offices whose pages show values nobody reviewed yet. They are never published facts. */
  toReview: string[];
}

/**
 * Completed manual office reviews must not silently degrade on a later refresh. A reviewed
 * value withheld, an absence or note no longer confirmed, a lost website or an unreadable
 * cited section changes what the office publishes, so it stops publication. New discovery
 * candidates (and exclusions whose section text changed) only ask for another review: a
 * candidate never becomes a fact, so one office's page edit must not hold back every other
 * office's fresh data.
 */
export function checkCompletedOfficeReviews(reviewedNames: readonly string[],
  contacts: readonly StructuredDirectoryContact[]): OfficeReviewCheck {
  const blocking: string[] = [];
  const toReview: string[] = [];
  for (const name of reviewedNames) {
    const matches = contacts.filter(contact => contact.name === name && contact.type === 'office');
    const evidence = matches.length === 1 ? matches[0].evidence : undefined;
    const review = evidence?.contact_review;
    if (!evidence || !review || evidence.withheld.length || evidence.absence_issues.length || evidence.website_issue
        || evidence.contact_note_issues?.length || review.unavailable_sections.length) {
      blocking.push(`${name}: a reviewed contact fact lost its evidence. Inspect contact evidence and coverage diagnostics.`);
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
  return { blocking, toReview };
}
