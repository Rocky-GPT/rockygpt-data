/** Rewrite docs/campus-graph.md from a downloaded graph export. Never touches a database. */
import fs from 'node:fs';
import { describeGraph, type GraphExport } from '../../src/data-v2/describe-graph';

const [exportPath, outputPath = 'docs/campus-graph.md'] = process.argv.slice(2);
if (!exportPath) throw new Error('Usage: npm run docs:graph -- EXPORT_JSON [OUTPUT_MD]');
fs.writeFileSync(outputPath, describeGraph(JSON.parse(fs.readFileSync(exportPath, 'utf8')) as GraphExport));
console.log(`Wrote ${outputPath}`);
