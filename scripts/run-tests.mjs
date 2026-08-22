import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['api', 'ingestion', 'pipeline', 'src'];
const tests = [];

function visit(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith('.test.ts')) tests.push(file);
  }
}

for (const root of roots) visit(root);
tests.sort();

if (tests.length === 0) {
  console.error('No TypeScript tests were found.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
