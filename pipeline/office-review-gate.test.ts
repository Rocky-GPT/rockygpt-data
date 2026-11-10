import assert from 'node:assert/strict';
import test from 'node:test';
import { changedOfficesReport, checkCompletedOfficeReviews } from './office-review-gate';
import type { StructuredDirectoryContact } from '../src/directory/structured-contacts';

type Evidence = NonNullable<StructuredDirectoryContact['evidence']>;
type Review = NonNullable<Evidence['contact_review']>;

const review = (changes: Partial<Review> = {}): Review => ({
  scope: 'captured_home_contact_faq_staff_and_cited_sections',
  status: 'no_unrecorded_values_in_scanned_sections',
  scanned_pages: [],
  unavailable_sections: [],
  unrecorded: [],
  excluded: [],
  exclusion_issues: [],
  ...changes,
});

const office = (evidence: Partial<Evidence> = {}): StructuredDirectoryContact => ({
  name: 'Anisfield School of Business',
  type: 'office',
  department: 'Anisfield School of Business',
  email: 'asb@ramapo.edu',
  phone: '(201) 684-7378',
  office: 'ASB-333',
  evidence: {
    source_urls: ['https://www.ramapo.edu/asb/'],
    withheld: [],
    not_published: ['prefers_email', 'preferred_contact', 'contact_note'].map(field => ({ field })),
    absence_issues: [],
    website: { url: 'https://www.ramapo.edu/asb/' },
    contact_review: review(),
    ...evidence,
  },
}) as unknown as StructuredDirectoryContact;

const changedSection = review({
  status: 'needs_review',
  unrecorded: [{ field: 'phone', found: ['2016847406', '2016847365'], url: 'https://www.ramapo.edu/myadvisor/declared-students/',
    section: 'Declared Students', captured_at: '2026-10-22T20:00:00.000Z' }],
  exclusion_issues: [{ field: 'phone', value: '2016847406', reason: 'The excluded candidate or reviewed section changed; review its scope again.' }],
});

test('a reviewed office whose facts all still hold does not stop publication', () => {
  assert.deepEqual(checkCompletedOfficeReviews(['Anisfield School of Business'], [office()]),
    { blocking: [], changed: [], toReview: [] });
});

test('new candidates on a reviewed office page ask for another review without holding back the release', () => {
  const check = checkCompletedOfficeReviews(['Anisfield School of Business'], [office({ contact_review: changedSection })]);
  assert.deepEqual(check.blocking, []);
  assert.deepEqual(check.toReview,
    ['Anisfield School of Business: 2 unreviewed candidate(s), 1 exclusion(s) whose section changed.']);
});

test('a reviewed fact whose page changed is left out and listed, without holding back the release', () => {
  const withheld = office({ withheld: [{ field: 'phone', value: '(201) 684-7378', reason: 'The section no longer states it.' }] });
  const unreadable = { ...office({ contact_review: review({ status: 'needs_review',
    unavailable_sections: [{ url: 'https://www.ramapo.edu/asb/', section: 'Contact Us', reason: 'Not captured.' }] }) }),
  name: 'Registrar' } as StructuredDirectoryContact;
  const check = checkCompletedOfficeReviews(['Anisfield School of Business', 'Registrar'], [withheld, unreadable]);
  assert.deepEqual(check.blocking, []);
  assert.deepEqual(check.toReview, []);
  assert.deepEqual(check.changed, [
    { name: 'Anisfield School of Business', leftOut: ['phone (201) 684-7378: The section no longer states it.'] },
    { name: 'Registrar', leftOut: ['section "Contact Us" of https://www.ramapo.edu/asb/ could not be read: Not captured.'] },
  ]);
});

test('every kind of lost evidence is named once, in plain lines', () => {
  const changedSectionReason = 'The reviewed section "Staff Directory" of https://ramapoathletics.com/staff-directory changed; review this absence again.';
  const gone = 'https://www.ramapo.edu/csi/roadrunner-central/ has no section "Six".';
  const athletics = { ...office({
    absence_issues: [
      { field: 'email', kind: 'unconfirmed', reason: changedSectionReason },
      { field: 'email', kind: 'unconfirmed', reason: changedSectionReason },
      { field: 'hours', kind: 'unconfirmed', reason: changedSectionReason },
    ],
    website_issue: { url: 'https://ramapoathletics.com/', reason: 'This run did not capture the page.' },
    contact_note_issues: [{ text: 'Comments, Questions, Concerns? Email csi@ramapo.edu or call 201-684-7593.', reason: gone }],
    contact_preference_issue: 'The cited section does not state this contact preference.',
    // Already named by the contact instruction it backed, so it is not listed a second time.
    contact_review: review({ status: 'needs_review',
      unavailable_sections: [{ url: 'https://www.ramapo.edu/csi/roadrunner-central/', section: 'Six', reason: gone }] }),
  }), name: 'Athletics' } as StructuredDirectoryContact;
  const check = checkCompletedOfficeReviews(['Athletics'], [athletics]);
  assert.deepEqual(check.blocking, []);
  assert.deepEqual(check.changed, [{ name: 'Athletics', leftOut: [
    `the note that no email is published: ${changedSectionReason}`,
    `the note that no hours is published: ${changedSectionReason}`,
    'website https://ramapoathletics.com/: This run did not capture the page.',
    `contact instruction "Comments, Questions, Concerns? Email csi@ramapo.edu or call 201-684-7593.": ${gone}`,
    'preferred contact method: The cited section does not state this contact preference.',
  ] }]);
  const report = changedOfficesReport(check.changed);
  assert.match(report ?? '', /^Left out these reviewed office facts because their pages changed\./);
  assert.match(report ?? '', /\n- \*\*Athletics\*\*\n  - the note that no email is published: /);
  assert.equal(changedOfficesReport([]), null);
});

test('a reviewed name that is not exactly one office contact stops publication', () => {
  const twice = checkCompletedOfficeReviews(['Anisfield School of Business', 'Payroll'], [office(), office()]);
  assert.equal(twice.blocking.length, 2);
  assert.match(twice.blocking[0], /^Anisfield School of Business: is not exactly one reviewed office contact/);
  assert.match(twice.blocking[1], /^Payroll: is not exactly one reviewed office contact/);
  assert.deepEqual(twice.changed, []);
});

test('a reviewed field that is now missing without a confirmed absence stops publication', () => {
  const noEmail = { ...office(), email: undefined } as StructuredDirectoryContact;
  assert.deepEqual(checkCompletedOfficeReviews(['Anisfield School of Business'], [noEmail]).blocking,
    ['Anisfield School of Business: unreviewed missing field(s) email.']);
});
