import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProgram } from './generate-programs-md';

test('document evidence includes the full nested catalog rules and restrictions', () => {
  const restriction = 'Published restriction. '.repeat(20) + 'At least one 300-level course.';
  const md = renderProgram({ name: 'History BA', requirements: [{ section: 'Requirements', note: restriction,
    rule: { condition: 'catalogBlock', subRules: [
      { condition: 'completedAtLeastXOf', count: 6, name: 'Upper-level choices', note: 'No double counting.',
        items: [{ logic: 'or', codes: [{ code: 'HIST 202', name: 'Public History' }, { code: 'HIST 308', name: 'Korean Cinema' }] }] },
      { condition: 'freeformText', text: 'Consult the advisor.', constraints: { minCredits: 4 } },
    ] } }] });
  for (const text of ['count: 6', 'HIST 202', 'HIST 308', 'No double counting.', 'Consult the advisor.', 'minCredits', 'At least one 300-level course.']) assert.ok(md.includes(text), text);
});
