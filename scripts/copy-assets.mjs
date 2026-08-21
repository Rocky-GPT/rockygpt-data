/**
 * Copies the non-TypeScript files the package needs at runtime — the schema,
 * its migrations, and the campus reference data — into the build output.
 *
 * `tsc` emits only what it compiles, so these would otherwise be missing from
 * dist and every lookup through `packageAsset` would fail. Written in Node
 * rather than shelling out because this runs wherever the package is
 * installed, including build images that have no rsync.
 */

import fs from 'node:fs';
import path from 'node:path';

const FROM = 'src';
const TO = path.join('dist', 'src');
const KEEP = /\.(sql|json)$/;

let copied = 0;

function walk(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      walk(source, target);
    } else if (KEEP.test(entry.name)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied += 1;
    }
  }
}

walk(FROM, TO);
console.log(`copied ${copied} asset${copied === 1 ? '' : 's'} into ${TO}`);
