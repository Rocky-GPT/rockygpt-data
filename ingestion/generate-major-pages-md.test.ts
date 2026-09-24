import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkDocumentSections } from '../src/data-v2/document-text';
import { majorPagesMarkdown } from './generate-major-pages-md';
import type { MajorPagesArtifact } from './major-pages';

const CAPTURED = '2026-09-24T17:20:00.000Z';
const ARTIFACT = {
  schema_version: 1, source_url: 'https://www.ramapo.edu/majors-minors/', captured_at: CAPTURED,
  unresolved: [], unavailable: [],
  pages: [{
    id: 'cs', url: 'https://www.ramapo.edu/majors-minors/majors/computer-science/', finalUrl: null,
    name: 'Computer Science', title: 'Computer Science', degrees: ['Bachelor of Science'], offers: ['Major', 'Minor'],
    sections: [
      { heading: 'About the Computer Science Major', text: 'Technology is woven into society and our everyday lives, and the career prospects are bright.' },
      { heading: 'Careers & Outcomes', text: '#1 in the region for placements, among many software careers students go on to.' },
    ],
    links: [], catalogLinks: [], programCodes: ['SN-BS-CMPS'], otherProgramCodes: [], relatedProgramCodes: [], limitations: [],
  }],
} as MajorPagesArtifact;

test('each program page section is a chunk cited to its page, with its capture time', () => {
  const chunks = chunkDocumentSections(majorPagesMarkdown(ARTIFACT, CAPTURED));
  const about = chunks.find(chunk => chunk.content.includes('Technology is woven'))!;
  assert.equal(about.canonicalUrl, 'https://www.ramapo.edu/majors-minors/majors/computer-science/');
  assert.equal(about.headingPath,
    'Ramapo College Program Pages › Computer Science (Bachelor of Science) › About the Computer Science Major');
  assert.equal(about.collectedAt, CAPTURED);
  assert.ok(!about.content.includes('- URL:') && !about.content.includes('Collected At'));
  // A page line that starts with '#' stays in its section instead of starting a new one.
  const careers = chunks.find(chunk => chunk.content.includes('in the region for placements'))!;
  assert.equal(careers.headingPath?.split(' › ').pop(), 'Careers & Outcomes');
});
