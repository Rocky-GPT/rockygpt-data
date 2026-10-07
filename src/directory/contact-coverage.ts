/** Discovery coverage is separate from evidence confirmation: candidates never become facts here. */
import {
  CONTACT_FIELDS, contactSectionHash, evidenceText, findUnrecordedValues, pageKey, statesValue,
  type AbsenceClaim, type CapturedPage, type ContactEvidence, type ContactValues,
  type ReviewedContactAddition, type ReviewedContactExclusion, type ReviewedContactNote, type UnrecordedValue,
} from './contact-evidence';

interface ContactReviewEntry extends ContactValues {
  evidence: ContactEvidence[];
  website?: string;
  additionalContacts?: ReviewedContactAddition[];
  contactNotes?: ReviewedContactNote[];
  notPublished?: AbsenceClaim[];
  websiteEvidence?: Pick<ContactEvidence, 'url' | 'section'>;
  contactConflicts?: ReviewedContactAddition[];
  contactReviewExclusions?: ReviewedContactExclusion[];
}

export interface ContactCoverageReport {
  /** This bounded scan does not claim to have reviewed every page on the office's site. */
  scope: 'captured_home_contact_faq_staff_and_cited_sections';
  status: 'needs_review' | 'no_unrecorded_values_in_scanned_sections';
  scanned_pages: Array<{ url: string; captured_at: string }>;
  unavailable_sections: Array<{ url: string; section: string; reason: string }>;
  unrecorded: Array<UnrecordedValue & { captured_at: string }>;
  excluded: Array<ReviewedContactExclusion & { checked_at: string }>;
  exclusion_issues: Array<{ field: string; value: string; reason: string }>;
}

function ownContactPage(home: string, candidate: string): boolean {
  try {
    const base = new URL(home);
    const page = new URL(candidate);
    if (base.hostname !== page.hostname) return false;
    const root = base.pathname.replace(/\/+$/, '');
    const pathname = page.pathname.replace(/\/+$/, '');
    if (pathname === root) return true;
    if (!pathname.startsWith(`${root}/`)) return false;
    const leaf = pathname.slice(root.length + 1).split('/').at(-1) ?? '';
    // Include contactus, oss-staff-contact-information, math-faq and about-the-staff.
    return /^(?:contactus|contacts?|faqs?|staff|staff-directory|about-us|about-the-staff)$/.test(leaf)
      || /(?:^|-)(?:contact|faq|faqs|staff)(?:-|$)/.test(leaf)
        && !/(?:resources?|polic(?:y|ies))/.test(leaf);
  } catch {
    return false;
  }
}

/**
 * Inspect captured home/contact/FAQ/staff pages beyond the sections manually cited.
 * Include text-only numbers, not just tel/mailto links. Values from staff lists and
 * resource lists stay pending review; guessing their owner would create false facts.
 */
export function reviewContactCoverage(entry: ContactReviewEntry,
  pages: ReadonlyMap<string, CapturedPage>): ContactCoverageReport {
  const evidence = [...entry.evidence,
    ...(entry.additionalContacts ?? []).flatMap(item => item.evidence),
    ...(entry.contactConflicts ?? []).flatMap(item => item.evidence),
    ...(entry.contactNotes ?? []).map(item => ({ ...item.evidence, fields: [...CONTACT_FIELDS] })),
    ...(entry.notPublished ?? []).flatMap(item => item.evidence.map(ref => ({ ...ref, fields: [...CONTACT_FIELDS] }))),
    ...(entry.websiteEvidence ? [{ ...entry.websiteEvidence, fields: [...CONTACT_FIELDS] }] : []),
  ];
  for (const page of pages.values()) {
    if (!entry.website || !ownContactPage(entry.website, page.url)) continue;
    for (const section of page.sections) evidence.push({ url: page.url, section: section.heading, fields: [...CONTACT_FIELDS] });
  }
  const sections = [...new Map(evidence.map(item => [
    JSON.stringify([pageKey(item.url), item.section.toLowerCase(), item.near ?? '']), item,
  ])).values()];
  const unavailable = sections.flatMap(item => {
    const found = evidenceText(item, pages);
    return 'reason' in found ? [{ url: item.url, section: item.section, reason: found.reason }] : [];
  });
  if (entry.website && !pages.has(pageKey(entry.website))) {
    unavailable.push({ url: entry.website, section: '(home page)', reason: 'The office home page was not captured.' });
  }
  const scanned = new Map<string, { url: string; captured_at: string }>();
  for (const item of sections) {
    const page = pages.get(pageKey(item.url));
    if (page) scanned.set(pageKey(page.url), { url: page.url, captured_at: page.fetchedAt });
  }
  // Keep one source section per candidate on each page; repeated sidebar contacts are one finding.
  const seen = new Set<string>();
  const recorded = [...(entry.additionalContacts ?? []), ...(entry.contactConflicts ?? []),
    ...(entry.contactNotes ?? []).flatMap(note => CONTACT_FIELDS.map(field => ({ field, value: note.text }))),
  ];
  const excluded: ContactCoverageReport['excluded'] = [];
  const exclusionIssues: ContactCoverageReport['exclusion_issues'] = [];
  for (const item of entry.contactReviewExclusions ?? []) {
    const found = evidenceText({ ...item.evidence, fields: [item.field] }, pages);
    if ('reason' in found || !item.reason.trim() || item.evidence.text_sha256 !== contactSectionHash(found.text)
        || !statesValue(item.field, item.value, found.text)) {
      exclusionIssues.push({ field: item.field, value: item.value,
        reason: 'The excluded candidate or reviewed section changed; review its scope again.' });
    } else excluded.push({ ...item, checked_at: pages.get(pageKey(item.evidence.url))!.fetchedAt });
  }
  const unrecorded = findUnrecordedValues(entry, sections, pages, recorded).flatMap(item => {
    const found = item.found.filter(value => {
      const key = JSON.stringify([pageKey(item.url), item.field, value]);
      if (seen.has(key)) return false;
      seen.add(key);
      if (excluded.some(review => review.field === item.field && review.value === value
          && pageKey(review.evidence.url) === pageKey(item.url)
          && review.evidence.section.toLowerCase() === item.section.toLowerCase())) return false;
      return true;
    });
    return found.length ? [{ ...item, found,
      captured_at: pages.get(pageKey(item.url))?.fetchedAt ?? '',
    }] : [];
  });
  return {
    scope: 'captured_home_contact_faq_staff_and_cited_sections',
    status: unrecorded.length || unavailable.length || exclusionIssues.length ? 'needs_review' : 'no_unrecorded_values_in_scanned_sections',
    scanned_pages: [...scanned.values()].sort((a, b) => a.url.localeCompare(b.url)),
    unavailable_sections: unavailable,
    unrecorded,
    excluded,
    exclusion_issues: exclusionIssues,
  };
}
