import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProgramRecord } from '../schemas';
import {
  parseProgramSearch,
  programMatchesCriteria,
  programMatchesDegreeLevel,
} from './program-search';

const source = {
  sourceId: 'academic-programs',
  title: 'Ramapo Programs',
  url: 'https://catalog.ramapo.edu/programs',
};

function program(
  name: string,
  degree: string,
  programKind: ProgramRecord['programKind'] = 'major'
): ProgramRecord {
  return { name, degree, programKind, source };
}

const PROGRAMS = [
  program('Computer Science BS', 'Bachelor of Science'),
  program('Computer Science MS', 'Master of Science'),
  // The name fallback keeps a previously published artifact useful until its
  // corrected MFA degree label is recollected and activated.
  program('Creative Music Technology MFA', 'Undergraduate Program'),
  program('Nursing Practice DNP', 'Doctor of Nursing Practice'),
  program('Data Analyst-Graduate Certificate', 'Graduate Certificate', 'certificate'),
  program('MA-BA-Matric Undeclared', 'Bachelor of Arts', 'special'),
];

test('broad masters and graduate wording becomes a degree-level filter, not a subject', () => {
  const masters = parseProgramSearch("what master's programs are offered?");
  assert.equal(masters.subject, '');
  assert.equal(masters.requestedLevel, 'masters');

  const graduate = parseProgramSearch('show me graduate programs');
  assert.equal(graduate.subject, '');
  assert.equal(graduate.requestedLevel, 'graduate');

  const computerScience = parseProgramSearch("master's programs in computer science");
  assert.equal(computerScience.subject, 'computer science');
  assert.equal(computerScience.requestedLevel, 'masters');

  assert.equal(parseProgramSearch('master’s programs').requestedLevel, 'masters');
});

test('masters, graduate, and doctoral levels select their actual degree families', () => {
  assert.deepEqual(
    PROGRAMS.filter((record) => programMatchesDegreeLevel(record, 'masters')).map(({ name }) => name),
    ['Computer Science MS', 'Creative Music Technology MFA']
  );
  assert.deepEqual(
    PROGRAMS.filter((record) => programMatchesDegreeLevel(record, 'graduate')).map(({ name }) => name),
    [
      'Computer Science MS',
      'Creative Music Technology MFA',
      'Nursing Practice DNP',
      'Data Analyst-Graduate Certificate',
    ]
  );
  assert.deepEqual(
    PROGRAMS.filter((record) => programMatchesDegreeLevel(record, 'doctoral')).map(({ name }) => name),
    ['Nursing Practice DNP']
  );
});

test('DNP is a doctoral match while a PhD request accurately returns no records', () => {
  const dnp = parseProgramSearch('doctoral DNP programs');
  assert.equal(dnp.requestedDegree, 'Doctor of Nursing Practice');
  assert.equal(dnp.requestedLevel, 'doctoral');
  assert.deepEqual(
    PROGRAMS.filter((record) => programMatchesCriteria(record, dnp)).map(({ name }) => name),
    ['Nursing Practice DNP']
  );

  const phd = parseProgramSearch('what PhD programs are offered?');
  assert.equal(phd.subject, '');
  assert.equal(phd.requestedDegree, 'Doctor of Philosophy');
  assert.equal(phd.requestedLevel, 'phd');
  assert.deepEqual(PROGRAMS.filter((record) => programMatchesCriteria(record, phd)), []);
});

test('an explicit MFA query remains searchable across the old generic degree label', () => {
  const mfa = parseProgramSearch('MFA programs');
  assert.equal(mfa.requestedDegree, 'Master of Fine Arts');
  assert.deepEqual(
    PROGRAMS.filter((record) => programMatchesCriteria(record, mfa)).map(({ name }) => name),
    ['Creative Music Technology MFA']
  );
});
