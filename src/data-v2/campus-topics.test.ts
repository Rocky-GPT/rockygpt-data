import assert from 'node:assert/strict';
import test from 'node:test';
import { contactSectionHash, pageKey, type CapturedPage } from '../directory/contact-evidence';
import { checkTopics, type ReviewedTopic } from './campus-topics';

const url = 'https://www.ramapo.edu/scholarships/faqs/';
const text = 'Who do I ask?\nContact Financial Aid (finaid@ramapo.edu) or Student Accounts about awards.';
const pages = new Map<string, CapturedPage>([[pageKey(url), {
  url, fetchedAt: '2026-10-15T14:00:00.000Z',
  sections: [{ heading: 'Who do I ask?', text: 'Contact Financial Aid (finaid@ramapo.edu) or Student Accounts about awards.' }] }]]);
const names = new Set(['Financial Aid', 'Student Accounts']);
const topic = (changes: Partial<ReviewedTopic> = {}): ReviewedTopic => ({
  name: 'Scholarships', aliases: [], status: 'current', handled_by: ['Financial Aid', 'Student Accounts'],
  evidence: { url, section: 'Who do I ask?', text_sha256: contactSectionHash(text),
    quote: 'Contact Financial Aid (finaid@ramapo.edu) or Student Accounts' }, note: 'The FAQ names both.', ...changes });
const check = (...topics: ReviewedTopic[]) => checkTopics({ schema_version: 1, reviewed_on: '2026-10-15', topics }, pages, names);

test('a topic publishes with the time its cited page was captured', () => {
  assert.deepEqual(check(topic()).map(t => [t.name, t.checked_at]), [['Scholarships', '2026-10-15T14:00:00.000Z']]);
});

test('a topic is refused when its section changed, its quote is gone or it names an office the graph lacks', () => {
  assert.throws(() => check(topic({ evidence: { ...topic().evidence, text_sha256: 'a'.repeat(64) } })), /changed; review the topic again/);
  assert.throws(() => check(topic({ evidence: { ...topic().evidence, quote: 'Contact the Bursar' } })), /quote is not in its section/);
  assert.throws(() => check(topic({ handled_by: ['Financial Aid', 'Bursar'] })), /names Bursar, which the graph has no identity for/);
});

test('a current topic names an office; a retired one names none; a topic never reuses an identity name', () => {
  assert.throws(() => check(topic({ handled_by: [] })), /names no office/);
  assert.throws(() => check(topic({ status: 'retired' })), /is retired but names offices/);
  assert.throws(() => check(topic({ name: 'Financial Aid' })), /already the name of an identity/);
});

test('a quote may be exact pieces in page order, and a further section must back an office the topic lists', () => {
  const pieces = { ...topic().evidence, quote: 'Contact Financial Aid … Student Accounts about awards' };
  assert.equal(check(topic({ evidence: pieces })).length, 1);
  assert.throws(() => check(topic({ evidence: { ...pieces, quote: 'Student Accounts … Contact Financial Aid' } })), /quote is not in its section/);
  const more = { ...topic().evidence, handled_by: ['Bursar'] };
  assert.throws(() => check(topic({ more_evidence: [more] })), /cites a section for Bursar, which it does not list/);
});
