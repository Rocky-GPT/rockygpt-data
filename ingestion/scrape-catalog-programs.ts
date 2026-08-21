/**
 * scrape-catalog-programs.ts
 *
 * Uses Playwright to scrape all programs from catalog.ramapo.edu/programs
 * Extracts: description, required courses, electives, concentrations, total credits
 * Merges results into public/data/programs.json
 *
 * Run: npx tsx scripts/fetch/scrape-catalog-programs.ts
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { publicPath } from '../src/paths';

const CATALOG_URL = 'https://catalog.ramapo.edu/programs';
const PROGRAMS_JSON = publicPath('data', 'programs.json');

interface CatalogCourse {
  code: string;
  name: string;
  credits?: string;
}

interface CatalogRequirement {
  section: string; // e.g. "Core Requirements", "Electives", "Math Electives"
  courses: CatalogCourse[];
  note?: string;   // e.g. "Choose 2 from the following"
}

interface CatalogProgram {
  catalogCode: string;       // e.g. "TS-BS-CMPS"
  catalogUrl: string;
  catalogName: string;
  description?: string;
  learningOutcomes?: string[];
  totalCredits?: string;
  requirements?: CatalogRequirement[];
  concentrations?: string[];
}

interface MajorEntry {
  name: string;
  degree: string;
  type: 'undergraduate' | 'graduate';
  url: string;
  description?: string;
  whatYoullLearn?: string;
  sampleCourses?: string[];
  careers?: string;
  // New catalog fields
  catalogCode?: string;
  catalogUrl?: string;
  totalCredits?: string;
  requirements?: CatalogRequirement[];
  concentrations?: string[];
  learningOutcomes?: string[];
}

interface SchoolGroup {
  school: string;
  shortName: string;
  majors: MajorEntry[];
}

interface ProgramsData {
  generatedAt: string;
  totalSchools: number;
  totalMajors: number;
  schools: SchoolGroup[];
  source: string;
}

async function getAllProgramLinks(page: import('playwright').Page): Promise<Array<{name: string, url: string, code: string}>> {
  const programs: Array<{name: string, url: string, code: string}> = [];
  let pageNum = 1;

  while (true) {
    const url = `${CATALOG_URL}?page=${pageNum}&pq=`;
    console.log(`  Fetching listing page ${pageNum}...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for program cards
    await page.waitForSelector('[data-testid="program-card"], .program-card, a[href*="/programs/"]', { timeout: 15000 }).catch(() => {});

    const links = await page.evaluate(() => {
      const found: Array<{name: string, url: string, code: string}> = [];
      // Collect all links to program pages
      document.querySelectorAll('a[href]').forEach(el => {
        const href = (el as HTMLAnchorElement).href;
        const match = href.match(/\/programs\/([A-Za-z0-9_-]+)$/);
        if (match) {
          const code = match[1];
          const name = el.textContent?.trim() || code;
          found.push({ name, url: href, code });
        }
      });
      return found;
    });

    if (links.length === 0) break;
    programs.push(...links);

    // Check if there's a next page
    const hasNext = await page.evaluate(() => {
      const nextBtn = document.querySelector('a[aria-label="Next page"], button[aria-label="Next"], [data-testid="next-page"]');
      return !!nextBtn;
    });
    if (!hasNext) break;
    pageNum++;
    if (pageNum > 20) break; // safety limit
  }

  // Deduplicate by code
  const seen = new Set<string>();
  return programs.filter(p => {
    if (seen.has(p.code)) return false;
    seen.add(p.code);
    return true;
  });
}

async function scrapeProgram(page: import('playwright').Page, programUrl: string, code: string): Promise<CatalogProgram | null> {
  try {
    await page.goto(programUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    const data = await page.evaluate((catalogCode: string) => {
      const result: {
        catalogCode: string;
        catalogName: string;
        description: string;
        totalCredits: string;
        requirements: Array<{section: string; note: string; courses: Array<{code: string; name: string; credits: string}>}>;
        concentrations: string[];
        learningOutcomes: string[];
      } = {
        catalogCode,
        catalogName: '',
        description: '',
        totalCredits: '',
        requirements: [],
        concentrations: [],
        learningOutcomes: [],
      };

      // Program name (h1/h2)
      const h1 = document.querySelector('h1, h2, [data-testid="program-title"]');
      if (h1) result.catalogName = h1.textContent?.trim() || '';

      // Description — look for a description/overview paragraph
      const descEl = document.querySelector('[data-testid="program-description"], .program-description, .overview p, .description');
      if (descEl) {
        result.description = descEl.textContent?.trim() || '';
      } else {
        // Fallback: grab the first substantive paragraph on the page
        const paras = Array.from(document.querySelectorAll('p'));
        for (const p of paras) {
          const t = p.textContent?.trim() || '';
          if (t.length > 80 && !t.startsWith('Credit') && !t.startsWith('This program')) {
            result.description = t.slice(0, 600);
            break;
          }
        }
      }

      // Total credits
      const creditText = document.body.innerText.match(/Total(?:\s+Program)?\s+Credits?:?\s*(\d+)/i);
      if (creditText) result.totalCredits = creditText[1];

      // Collect course rows — works on most catalog pages
      const courseRows = Array.from(document.querySelectorAll('tr, [data-testid="course-row"], .course-row'));
      let currentSection = 'Requirements';

      for (const row of courseRows) {
        const text = row.textContent?.trim() || '';
        if (!text) continue;

        // Section headings
        const isHeading = row.querySelector('th, [data-testid="section-header"], .section-header, strong') && text.length < 120;
        if (isHeading && row.querySelector('th')) {
          const thText = row.querySelector('th')?.textContent?.trim() || '';
          if (thText && thText.length < 100 && !thText.match(/^(Code|Credits?|Course)$/i)) {
            currentSection = thText;
            continue;
          }
        }

        // Course row: look for CODE pattern
        const codeEl = row.querySelector('td:first-child, [data-testid="course-code"]');
        const nameEl = row.querySelector('td:nth-child(2), [data-testid="course-name"]');
        const creditsEl = row.querySelector('td:last-child, [data-testid="course-credits"]');

        const code_match = codeEl?.textContent?.trim().match(/^[A-Z]{2,5}\s+\d{3,4}[A-Z]?$/);
        if (code_match) {
          const courseCode = codeEl!.textContent!.trim();
          const courseName = nameEl?.textContent?.trim() || '';
          const courseCredits = creditsEl?.textContent?.trim() || '';

          // Find or create section
          let section = result.requirements.find(r => r.section === currentSection);
          if (!section) {
            section = { section: currentSection, note: '', courses: [] };
            result.requirements.push(section);
          }
          section.courses.push({ code: courseCode, name: courseName, credits: courseCredits });
        }
      }

      // Learning outcomes
      const outcomeEls = document.querySelectorAll('[data-testid="learning-outcome"], .learning-outcome, .outcomes li');
      outcomeEls.forEach(el => {
        const t = el.textContent?.trim();
        if (t) result.learningOutcomes.push(t);
      });

      // Concentrations
      const concEls = document.querySelectorAll('[data-testid="concentration"], .concentration-name, .concentration h3, .concentration h4');
      concEls.forEach(el => {
        const t = el.textContent?.trim();
        if (t) result.concentrations.push(t);
      });

      return result;
    }, code);

    return {
      ...data,
      catalogUrl: programUrl,
    };
  } catch (e) {
    console.error(`  ✗ ${code}: ${(e as Error).message}`);
    return null;
  }
}

// Match a catalog program name to a major in our programs.json
function matchMajor(catalogName: string, catalogCode: string, majors: MajorEntry[]): MajorEntry | null {
  // Normalize by removing degree suffixes
  const normalize = (s: string) => s.toLowerCase()
    .replace(/\b(b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?b\.?a\.?|m\.?p\.?p\.?|minor|4\+1|bs|ba|ms|mba|mpp|phd)\b/gi, '')
    .replace(/\s+/g, ' ').trim();

  const catNorm = normalize(catalogName);

  for (const major of majors) {
    const majNorm = normalize(major.name);
    if (majNorm === catNorm) return major;
    if (catNorm.includes(majNorm) || majNorm.includes(catNorm)) return major;
  }

  // Try by catalog code pattern
  const codeSubject = catalogCode.replace(/^[A-Z]+-[A-Z]+-/, '').toLowerCase();
  for (const major of majors) {
    const majNorm = normalize(major.name).replace(/\s+/g, '');
    if (majNorm.includes(codeSubject) || codeSubject.includes(majNorm.slice(0, 4))) return major;
  }

  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Step 1: Get all program listings
    console.log('Step 1: Collecting all program URLs...');
    const allPrograms = await getAllProgramLinks(page);
    console.log(`  Found ${allPrograms.length} programs`);

    // Step 2: Scrape each program detail page
    console.log('\nStep 2: Scraping program details...');
    const catalogData: CatalogProgram[] = [];
    const BATCH = 5;

    for (let i = 0; i < allPrograms.length; i += BATCH) {
      const batch = allPrograms.slice(i, i + BATCH);
      console.log(`  [${i + 1}-${Math.min(i + BATCH, allPrograms.length)}/${allPrograms.length}] ${batch.map(p => p.code).join(', ')}`);

      for (const prog of batch) {
        const detail = await scrapeProgram(page, prog.url, prog.code);
        if (detail) {
          detail.catalogName = detail.catalogName || prog.name;
          catalogData.push(detail);
        }
        await page.waitForTimeout(300);
      }
    }

    // Step 3: Merge into programs.json
    console.log('\nStep 3: Merging with programs.json...');
    const programsJson: ProgramsData = JSON.parse(fs.readFileSync(PROGRAMS_JSON, 'utf-8'));
    const allMajors = programsJson.schools.flatMap(s => s.majors);

    let matched = 0;
    for (const catalog of catalogData) {
      const major = matchMajor(catalog.catalogName, catalog.catalogCode, allMajors);
      if (major) {
        major.catalogCode = catalog.catalogCode;
        major.catalogUrl = catalog.catalogUrl;
        if (catalog.description && !major.description) major.description = catalog.description;
        if (catalog.totalCredits) major.totalCredits = catalog.totalCredits;
        if (catalog.requirements?.length) major.requirements = catalog.requirements;
        if (catalog.concentrations?.length) major.concentrations = catalog.concentrations;
        if (catalog.learningOutcomes?.length) major.learningOutcomes = catalog.learningOutcomes;
        matched++;
      } else {
        console.log(`  ⚠ No match for: ${catalog.catalogName} (${catalog.catalogCode})`);
      }
    }

    // Save enriched JSON
    programsJson.generatedAt = new Date().toISOString();
    fs.writeFileSync(PROGRAMS_JSON, JSON.stringify(programsJson, null, 2));

    const withReqs = allMajors.filter(m => m.requirements?.length).length;
    const withCredits = allMajors.filter(m => m.totalCredits).length;
    console.log(`\n✓ Done!`);
    console.log(`  Catalog programs scraped: ${catalogData.length}`);
    console.log(`  Matched to majors:        ${matched}`);
    console.log(`  Majors with requirements: ${withReqs}`);
    console.log(`  Majors with total credits: ${withCredits}`);
    console.log(`  Written to ${PROGRAMS_JSON}`);

    // Also save raw catalog data
    const rawOut = path.join(process.cwd(), 'data', 'raw', 'catalog-programs.raw.json');
    fs.writeFileSync(rawOut, JSON.stringify({ scrapedAt: new Date().toISOString(), programs: catalogData }, null, 2));
    console.log(`  Raw catalog data → ${rawOut}`);

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
