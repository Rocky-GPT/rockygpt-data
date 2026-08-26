import assert from 'node:assert/strict';
import test from 'node:test';

import { inferDegreeLabel, inferProgramType } from './scrape-catalog-api';

test('Creative Music Technology MFA is normalized as a graduate MFA degree', () => {
  const program = {
    id: 'creative-music-technology-mfa',
    code: 'CG-MFA-CRMT',
    name: 'Creative Music Technology MFA',
  };

  assert.equal(inferProgramType(program), 'graduate');
  assert.equal(inferDegreeLabel(program, 'graduate'), 'Master of Fine Arts');
});
