import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGraph, reasonPattern, type GraphExport } from './describe-graph';

const node = (id: string, kind: string, name: string, aliases: string[] = [], extra = {}) => ({ id, kind, name, aliases, ...extra });
function graph(): GraphExport {
  return {
    schema: 'rockygpt.published-campus-knowledge-graph', exported_at: '2026-09-23T18:00:00Z',
    snapshot: { dataset_version: 'dev-release', campus_date: '2026-09-23', identity_hash: 'hash', dataset: { source_commit_sha: 'abc123' } },
    nodes: [
      node('venue', 'venue', 'Birch Tree Inn', ['Birch'], { source_bindings: [{ collection: 'menu', source_record_keys: ['a', 'b'] }, { collection: 'contacts', source_record_keys: ['office:birch'] }] }),
      node('ps-1', 'office', 'Public Safety (Emergency)', ['Public Safety'], { source_bindings: [{ collection: 'contacts', source_record_keys: ['office:ps-1'] }] }),
      node('ps-2', 'office', 'Public Safety (Non-Emergency)', ['Public Safety']),
      node('person', 'person', 'Retired Professor', [], { status: 'retired' }),
      node('course', 'course', 'CMPS 147 — COMPUTER SCIENCE I', ['CMPS 147']),
    ],
    edges: [{ source: 'person', target: 'course', type: 'profile_course' }],
    unresolved_relationships: [],
    contextual_records: [{ record_type: 'requirement_group' }],
    record_edges: [{ type: 'requirement_option' }, { type: 'requirement_option' }],
    diagnostics: [
      { collection: 'programs', reason: 'Explicit Program Faculty profile URL https://www.ramapo.edu/hgs/faculty/a resolves to 0 person identities.' },
      { collection: 'programs', reason: 'Explicit Program Faculty profile URL https://www.ramapo.edu/tas/faculty/b resolves to 2 person identities.' },
      { collection: 'courses', reason: 'Explicit code CMPS 999 is absent from this release catalog.' },
    ],
    coverage: { alias_sources: [{ sources: [{ basis: 'human_reviewed' }] }, { sources: [{ basis: 'department' }] }, { sources: [{ basis: 'department' }, { basis: 'department' }] }] },
  };
}

test('the generated counts come only from the export', () => {
  const doc = describeGraph(graph());
  assert.match(doc, /Generated from the graph export of `dev-release`/);
  assert.match(doc, /\| Data commit \| `abc123` \|/);
  assert.match(doc, /5 entities; 2 \(40%\) have at least one published relationship\. .* of the other 4 entities, 1 \(25%\) have one\./);
  assert.match(doc, /\| office \| 2 \| 0 \| 2 \| 0 \|/);
  assert.match(doc, /\| person \| 1 \| 1 \| 0 \| 1 \|/);
  assert.match(doc, /\| \*\*Total\*\* \| 5 \| 2 \| 4 \| 1 \|/);
  assert.match(doc, /\| `profile_course` \| 1 \|/);
  assert.match(doc, /\| contacts \| 2 \| 2 \|/);
  assert.match(doc, /\| menu \| 2 \| 1 \|/);
  // "Public Safety" is one name two entities answer to.
  assert.match(doc, /4 aliases under 3 names; 1 of those names find more than one entity/);
  assert.match(doc, /\| `department` \| 2 \|\n\| `human_reviewed` \| 1 \|/);
  assert.match(doc, /\| `requirement_option` edges \| 2 \|/);
  assert.match(doc, /\| programs \| Explicit Program Faculty profile URL <url> resolves to N person identities\. \| 2 \|/);
  assert.throws(() => describeGraph({ ...graph(), schema: 'other' }), /published campus knowledge graph/);
});

test('a coverage pattern drops what makes each reason unique', () => {
  assert.equal(reasonPattern('Catalog school "School of Social Science and Human Services" was split.'), 'Catalog school "…" was split.');
  assert.equal(reasonPattern('Explicit code CMPS 999 is absent.'), 'Explicit code <course> is absent.');
  assert.equal(reasonPattern('URL https://www.ramapo.edu/x/y/ resolves to 3 identities.'), 'URL <url> resolves to N identities.');
  // The catalog publishes some URLs with a stray parenthesis; it is part of the URL.
  assert.equal(reasonPattern('URL https://www.ramapo.edu/x/y/) resolves.'), 'URL <url> resolves.');
  assert.equal(reasonPattern('Profile https://www.ramapo.edu/x/y.'), 'Profile <url>.');
});

test('a release without alias sources says so instead of inventing them', () => {
  assert.match(describeGraph({ ...graph(), coverage: null }), /This release does not record why each alias exists\./);
});
