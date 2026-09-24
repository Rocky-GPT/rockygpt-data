/**
 * generate-major-pages-md.ts
 *
 * The context document for Ramapo's public program pages: one section per page, cited to
 * that page and its capture time, with the page's own sections beneath it. A document
 * search then returns the passage that answers a question, with its page. Reads the
 * public/data/major-pages.json artifact that fetch:major-pages writes.
 *
 * Run: npm run generate:major-pages:md
 */

import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp } from './pipeline-utils';
import { MAJORS_INDEX_URL, type MajorPagesArtifact } from './major-pages';
import { publicPath } from '../src/paths';

const INPUT = publicPath('data', 'major-pages.json');
const OUTPUT = path.join(process.cwd(), 'data', 'context', 'academic', 'major-pages.md');

// A page line that starts with '#' would read as a heading and split the document there.
const literal = (text: string) => text.replace(/^(#+)/gm, '\\$1');

export function majorPagesMarkdown(artifact: MajorPagesArtifact, generatedAt: string): string {
  let markdown = buildFrontmatter({
    source_url: MAJORS_INDEX_URL, title: 'Majors, Minors & Concentrations',
    trust_tier: 'official_primary', freshness_sla_hours: 4_320,
  });
  markdown += '# Ramapo College Program Pages\n\n';
  markdown += `*Generated (UTC): ${generatedAt}*\n\n`;
  markdown += "*Text from Ramapo's public major, minor and graduate program pages. A page describes its program; the college catalog states its requirements.*\n\n";
  markdown += '---\n\n';
  for (const page of artifact.pages) {
    markdown += `## ${page.degrees.length ? `${page.name} (${page.degrees.join(', ')})` : page.name}\n\n`;
    markdown += `- URL: ${page.finalUrl ?? page.url}\n- Collected At: ${artifact.captured_at}\n\n`;
    if (page.offers.length) markdown += `Offered as: ${page.offers.join(', ')}.\n\n`;
    for (const section of page.sections) {
      markdown += `### ${section.heading || 'Overview'}\n\n${literal(section.text)}\n\n`;
    }
  }
  return markdown;
}

function main() {
  const artifact = JSON.parse(fs.readFileSync(INPUT, 'utf8')) as MajorPagesArtifact;
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, majorPagesMarkdown(artifact, getGeneratedTimestamp()));
  console.log(`Wrote ${artifact.pages.length} program pages to ${path.relative(process.cwd(), OUTPUT)}.`);
}

if (process.argv[1]?.endsWith('generate-major-pages-md.ts')) main();
