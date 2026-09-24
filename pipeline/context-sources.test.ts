import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceKeyForPath } from './context-sources';

test('a context document belongs to the source its path names', () => {
  assert.equal(sourceKeyForPath('/repo/data/context/academic/major-pages.md'), 'major-pages');
  assert.equal(sourceKeyForPath('/repo/data/context/academic/major-page-links.md'), 'major-page-links');
  assert.equal(sourceKeyForPath('/repo/data/context/campus/offices/finaid.md'), 'office-pages');
  assert.equal(sourceKeyForPath('/repo/data/context/campus/offices/eof-program.md'), 'office-pages');
  assert.equal(sourceKeyForPath('/repo/data/context/campus/offices/health.md'), 'office-pages');
  assert.equal(sourceKeyForPath('/repo/data/context/campus/health.md'), 'health');
  assert.equal(sourceKeyForPath('/repo/data/context/academic/programs.md'), 'academic-programs');
  assert.equal(sourceKeyForPath('/repo/data/context/academic/calendar.md'), 'academic-calendar');
  assert.equal(sourceKeyForPath('/repo/data/context/dining/menu.md'), 'dining');
  assert.equal(sourceKeyForPath('/repo/data/context/campus/hours.md'), 'campus-hours');
});
