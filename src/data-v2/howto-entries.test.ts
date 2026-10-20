import assert from 'node:assert/strict';
import test from 'node:test';
import { entriesKey, verifiedEntries } from './howto-entries';

const sections = [
  { heading: 'Clubs', text: 'Interested in starting a new club? Stop by the Center for Student Involvement in SC-218 to learn how.' },
  { heading: 'Fees', text: 'A replacement ID card costs $25. Email publicsafety@ramapo.edu to make an appointment.' },
];

test('a step is kept only while its quote is on the page and its numbers and addresses are in its quote', () => {
  const entries = verifiedEntries({ entries: [
    { task: 'Start a new club', applies_to: '', handled_by: '', term: '', section: 'Clubs', steps: [
      { text: 'Visit the Center for Student Involvement in SC-218.', quote: 'Stop by the Center for Student Involvement in SC-218' },
      { text: 'Submit a constitution.', quote: 'Submit your club constitution online' }] },
    { task: 'Replace a lost ID card', applies_to: '', handled_by: '', term: '', section: 'Wrong heading', steps: [
      { text: 'It costs $30.', quote: 'A replacement ID card costs $25.' },
      { text: 'Email publicsafety@ramapo.edu for an appointment.', quote: 'Email publicsafety@ramapo.edu to make an appointment' }] },
    { task: 'Win the lottery', applies_to: '', handled_by: '', term: '', section: 'Fees', steps: [
      { text: 'Buy a ticket.', quote: 'Buy a ticket at the store' }] },
  ] }, sections);
  assert.deepEqual(entries.map(entry => [entry.task, entry.section, entry.steps.map(step => step.text)]), [
    ['Start a new club', 'Clubs', ['Visit the Center for Student Involvement in SC-218.']],
    // The invented $30 is dropped; the section is found by its quote when the name is wrong.
    ['Replace a lost ID card', 'Fees', ['Email publicsafety@ramapo.edu for an appointment.']],
  ]);
});

test('a page is read again when its sections or the instructions change', () => {
  assert.equal(entriesKey('u', sections), entriesKey('u', sections));
  assert.notEqual(entriesKey('u', sections), entriesKey('u', [sections[0]]));
});

test('a page has entries only when the model read this very content', async () => {
  const { pageEntries } = await import('../../ingestion/howto-entries');
  const page = { key: 'k', folder: 'clubs', url: 'https://www.ramapo.edu/clubs/', fetchedAt: '', contentHash: 'h', sections };
  const reply = { entries: [{ task: 'Start a new club', applies_to: '', handled_by: '', term: '', section: 'Clubs',
    steps: [{ text: 'Visit the Center for Student Involvement.', quote: 'Stop by the Center for Student Involvement' }] }] };
  const read = { key: entriesKey(page.url, sections), url: page.url, model: 'm', read_at: '', reply };
  assert.equal(pageEntries({ dataset: 'howto-entries', pages: { k: read } }, page).length, 1);
  assert.deepEqual(pageEntries({ dataset: 'howto-entries', pages: { k: { ...read, key: 'older' } } }, page), []);
  assert.deepEqual(pageEntries({ dataset: 'howto-entries', pages: {} }, page), []);
});
