import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCourseIdentities, courseIdentityId, pythonJsonStrings } from './course-identities';

// Computed with the Brain's original Python derivation:
// str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(["rockygpt", "course", source, key])))
const GOLDEN: [string, string][] = [
  ['ACCT 100', '854b7bc3-8fa5-5456-9e69-7b8c6739d29c'],
  ['CMPS 147', '39b6f485-63cd-5e73-bce1-d1815efbc785'],
  ['HIST 100T', 'b4f8f296-6f2f-5498-bfd7-c7c091891dfe'],
  ['CAFÉ 101', '9580c58a-0f61-5427-84f7-e984cb2d94d3'],
  ['Q"uote\\ 1', '12efff06-5eb6-541a-9a14-17b13c053ddb'],
  ['EMOJI 🎓', '2f5e57d7-2681-544e-8d00-3c6f8844a9d2'],
  ['DEL\u007f 2', '85c86e3c-595a-5bb6-aef7-ad879ddbce0b'],
  ['TAB\t3', '10dfe08e-f1b3-5837-9349-6971066eef03'],
];

test('course IDs reproduce the Brain derivation byte for byte, including escapes', () => {
  assert.equal(pythonJsonStrings(['rockygpt', 'course', 'academic-programs', 'CAFÉ 101']),
    '["rockygpt", "course", "academic-programs", "CAF\\u00c9 101"]');
  for (const [code, id] of GOLDEN) assert.equal(courseIdentityId('academic-programs', code), id, code);
});

test('every published catalog key becomes one course identity, in stable order', () => {
  const artifact = compileCourseIdentities({ 'CMPS 147': { code: 'CMPS 147', name: 'COMPUTER SCIENCE I' }, 'ACCT 100': { code: 'ACCT 100' } });
  assert.deepEqual(artifact.courses, [
    { id: GOLDEN[0][1], source_key: 'academic-programs', source_record_key: 'ACCT 100', name: null },
    { id: GOLDEN[1][1], source_key: 'academic-programs', source_record_key: 'CMPS 147', name: 'COMPUTER SCIENCE I' },
  ]);
  assert.deepEqual(compileCourseIdentities(undefined).courses, []);
});
