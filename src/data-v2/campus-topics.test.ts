import assert from 'node:assert/strict';
import test from 'node:test';
import { contactSectionHash, pageKey, type CapturedPage } from '../directory/contact-evidence';
import { checkTopics, withheldTopicsReport, type ReviewedTopic } from './campus-topics';

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
const checked = (...topics: ReviewedTopic[]) => checkTopics({ schema_version: 1, reviewed_on: '2026-10-15', topics }, pages, names);
const check = (...topics: ReviewedTopic[]) => checked(...topics).topics;
const withheld = (...topics: ReviewedTopic[]) => checked(...topics).withheld.map(t => t.reason).join('\n');

test('a topic publishes with the time its cited page was captured', () => {
  assert.deepEqual(check(topic()).map(t => [t.name, t.checked_at]), [['Scholarships', '2026-10-15T14:00:00.000Z']]);
});

test('a topic whose page changed is withheld with the reason, and the other topics still publish', () => {
  const changed = topic({ name: 'Changed', evidence: { ...topic().evidence, text_sha256: 'a'.repeat(64) } });
  const result = checked(topic(), changed);
  assert.deepEqual(result.topics.map(t => t.name), ['Scholarships']);
  assert.deepEqual(result.withheld.map(t => t.name), ['Changed']);
  assert.match(withheld(changed), /changed; review the topic again/);
  assert.match(withheld(topic({ evidence: { ...topic().evidence, quote: 'Contact the Bursar' } })), /quote is not in its section/);
  const gone = 'https://www.ramapo.edu/emergency/';
  assert.match(withheld(topic({ evidence: { ...topic().evidence, url: gone } })), /emergency\/ was not captured in this run/);
  const report = withheldTopicsReport(result.withheld) ?? '';
  assert.match(report, /- Changed: the section "Who do I ask\?" of .* changed/);
  assert.equal(withheldTopicsReport([]), null);
});

test('a topic naming an office the graph lacks still stops the publish', () => {
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
  assert.match(withheld(topic({ evidence: { ...pieces, quote: 'Student Accounts … Contact Financial Aid' } })), /quote is not in its section/);
  const more = { ...topic().evidence, handled_by: ['Bursar'] };
  assert.throws(() => check(topic({ more_evidence: [more] })), /cites a section for Bursar, which it does not list/);
});
