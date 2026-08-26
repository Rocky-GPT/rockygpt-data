import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileRepositoryV2 } from './file-repository';
import { courseCredits } from '../course-record';

function fixture(t: test.TestContext): FileRepositoryV2 {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-course-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public/data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'public/data/courses.json'),
    JSON.stringify({
      'COMP 101': {
        code: 'COMP 101',
        name: 'Introduction to Computer Science',
        description: 'Programming fundamentals',
        credits: 4,
        attributes: ['Scientific Reasoning'],
      },
      'MATH 101': {
        code: 'MATH 101',
        name: 'College Mathematics',
        description: 'Mathematical reasoning',
        credits: 4,
        attributes: ['Quantitative Reasoning'],
      },
    })
  );
  return new FileRepositoryV2(root);
}

test('course codes match with or without spaces and rank exactly first', async (t) => {
  const found = await fixture(t).findCourses('COMP101');
  assert.equal(found[0]?.code, 'COMP 101');
  assert.equal(found[0]?.courseUrl, 'https://catalog.ramapo.edu/courses/COMP101');
});

test('course names, descriptions, and attributes are searchable', async (t) => {
  const repository = fixture(t);
  assert.equal((await repository.findCourses('programming fundamentals'))[0]?.code, 'COMP 101');
  assert.equal((await repository.findCourses('quantitative reasoning'))[0]?.code, 'MATH 101');
});

test('catalog min/max credit objects become useful wire text', () => {
  assert.equal(courseCredits({ min: 0, max: 4, operator: '' }), '4');
  assert.equal(courseCredits({ min: 1, max: 4, operator: 'TO' }), '1-4');
});
