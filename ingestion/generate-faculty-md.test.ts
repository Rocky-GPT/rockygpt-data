import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFacultyMarkdown } from './generate-faculty-md';
import { type FacultyProfile, validateFacultyProfiles } from './schema';
import { chunkDocumentSections } from '../src/data-v2/document-text';

test('retrieval documents preserve complete profile sections beyond former summary caps', () => {
  const profile: FacultyProfile = {
    name: 'Faculty Example', title: 'Professor', school: 'School',
    email: '', phone: '', office: '', imageUrl: '', profileUrl: 'https://example.edu/faculty',
    bio: `${'Long biographical content. '.repeat(40)}Final biographical fact.`,
    education: ['Degree One', 'Degree Two'],
    courses: Array.from({ length: 12 }, (_, i) => `Course ${i + 1}`),
    teachingInterests: ['Teaching topic'], researchInterests: ['Research topic'],
    publishedResearch: Array.from({ length: 25 }, (_, i) => `Publication ${i + 1}. Full citation.`),
  };
  const captured = '2026-09-23T20:00:00Z';
  const markdown = renderFacultyMarkdown([profile], { [profile.profileUrl]: captured });
  for (const value of [profile.bio, ...profile.education, ...profile.courses,
    ...profile.teachingInterests, ...profile.researchInterests, ...profile.publishedResearch]) {
    assert.ok(markdown.includes(value), `Missing source content: ${value}`);
  }
  assert.match(markdown, /Teaching Interests/);
  assert.match(markdown, /Research Interests/);
  assert.match(markdown, /undated/);
  const chunks = chunkDocumentSections(markdown).filter(chunk => chunk.canonicalUrl === profile.profileUrl);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.collectedAt === captured));
  assert.ok(chunks.some(chunk => chunk.content.includes('Final biographical fact.')));
});

test('an adjunct profile with no published title is kept, and its write-up has no empty title line', () => {
  const adjunct: FacultyProfile = {
    name: 'Adjunct Example', title: '', school: 'Anisfield School of Business',
    email: 'adjunct@ramapo.edu', phone: '', office: 'ASB-331', imageUrl: '',
    profileUrl: 'https://www.ramapo.edu/asb/faculty/adjunct-example/', bio: '',
    education: [], courses: ['ACCT 329 Federal Taxation I'],
    teachingInterests: [], researchInterests: [], publishedResearch: [],
  };
  const nameOnly = { ...adjunct, name: 'Name Only', email: '', office: '',
    profileUrl: 'https://www.ramapo.edu/asb/faculty/name-only/' };
  const kept = validateFacultyProfiles([adjunct, nameOnly]);
  assert.deepEqual(kept.map(profile => [profile.name, profile.title]), [['Adjunct Example', '']]);
  const markdown = renderFacultyMarkdown(kept);
  assert.match(markdown, /## Adjunct Example/);
  assert.match(markdown, /adjunct@ramapo\.edu/);
  assert.doesNotMatch(markdown, /\*\*Title:\*\*/);
});
