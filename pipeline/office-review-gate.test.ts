import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCompletedOfficeReviews } from './office-review-gate';
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
  assert.deepEqual(checkCompletedOfficeReviews(['Anisfield School of Business'], [office()]), { blocking: [], toReview: [] });
});

test('new candidates on a reviewed office page ask for another review without holding back the release', () => {
  const check = checkCompletedOfficeReviews(['Anisfield School of Business'], [office({ contact_review: changedSection })]);
  assert.deepEqual(check.blocking, []);
  assert.deepEqual(check.toReview,
    ['Anisfield School of Business: 2 unreviewed candidate(s), 1 exclusion(s) whose section changed.']);
});

test('a reviewed fact that lost its evidence stops publication, and every such office is named at once', () => {
  const withheld = office({ withheld: [{ field: 'phone', value: '(201) 684-7378', reason: 'The section no longer states it.' }] });
  const unreadable = { ...office({ contact_review: review({ status: 'needs_review',
    unavailable_sections: [{ url: 'https://www.ramapo.edu/asb/', section: 'Contact Us', reason: 'Not captured.' }] }) }),
  name: 'Registrar' } as StructuredDirectoryContact;
  const check = checkCompletedOfficeReviews(['Anisfield School of Business', 'Registrar', 'Payroll'], [withheld, unreadable]);
  assert.equal(check.blocking.length, 3);
  assert.match(check.blocking[0], /^Anisfield School of Business: a reviewed contact fact lost its evidence/);
  assert.match(check.blocking[1], /^Registrar: a reviewed contact fact lost its evidence/);
  assert.match(check.blocking[2], /^Payroll: /);
});

test('a reviewed field that is now missing without a confirmed absence stops publication', () => {
  const noEmail = { ...office(), email: undefined } as StructuredDirectoryContact;
  assert.deepEqual(checkCompletedOfficeReviews(['Anisfield School of Business'], [noEmail]).blocking,
    ['Anisfield School of Business: unreviewed missing field(s) email.']);
});
