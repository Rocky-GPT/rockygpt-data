/**
 * enrich-programs-json.ts
 * Fetches rich content from each major's ramapo.edu page:
 * - OG description (about paragraph)
 * - What You'll Learn
 * - Sample courses
 * - Careers & Outcomes
 *
 * Also fixes incorrect URL slugs for the 25 programs that 404'd.
 */

import * as fs from 'fs';
import * as https from 'https';
import { publicPath } from '../src/paths';

const OUTPUT = publicPath('data/programs.json');

interface MajorEntry {
  name: string;
  degree: string;
  type: 'undergraduate' | 'graduate';
  url: string;
  description?: string;
  whatYoullLearn?: string;
  sampleCourses?: string[];
  careers?: string;
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

// Corrected URL map for the 25 programs that had wrong slugs
const URL_CORRECTIONS: Record<string, string> = {
  'Accounting (4+1 BS-MS)': 'https://www.ramapo.edu/majors-minors/majors/accounting-bs-ms/',
  'Accounting (MSAC)': 'https://www.ramapo.edu/majors-minors/majors/accounting-msac/',
  'Information Technology Management': 'https://www.ramapo.edu/majors-minors/majors/information-technology-management/',
  'Master of Business Administration (MBA)': 'https://www.ramapo.edu/majors-minors/majors/master-of-business-administration-mba/',
  'Contemporary Arts: Professional Communication': 'https://www.ramapo.edu/majors-minors/majors/contemporary-arts-professional-communication/',
  'Music and Creative Music Technology (4+1 BA/MFA)': 'https://www.ramapo.edu/majors-minors/majors/music-and-creative-music-technology-ba-mfa/',
  'Theater and Film': 'https://www.ramapo.edu/majors-minors/majors/theater-and-film-major/',
  'English and Literary Studies': 'https://www.ramapo.edu/majors-minors/majors/literature/',
  'Law and Society': 'https://www.ramapo.edu/majors-minors/majors/law-and-society/',
  'Law and Society/Master of Public Policy 4+1': 'https://www.ramapo.edu/majors-minors/majors/law-and-society-master-public-policy-4-1/',
  'Master of Public Policy': 'https://www.ramapo.edu/majors-minors/majors/master-of-public-policy/',
  'Political Science/Master of Public Policy 4+1': 'https://www.ramapo.edu/majors-minors/majors/political-science-master-of-public-policy-4-1/',
  'Educational Leadership (MAEL)': 'https://www.ramapo.edu/majors-minors/majors/master-of-arts-in-educational-leadership-mael/',
  'Special Education (MASE)': 'https://www.ramapo.edu/majors-minors/majors/master-of-arts-in-special-education-mase/',
  'Clinical Lab Science (CLS)': 'https://www.ramapo.edu/majors-minors/majors/clinical-lab-science/',
  'Cybersecurity/MS Computer Science 4+1': 'https://www.ramapo.edu/majors-minors/majors/cybersecurity-ms-computer-science-4-1/',
  'Cybersecurity/MS Data Science 4+1': 'https://www.ramapo.edu/majors-minors/majors/cybersecurity-ms-data-science-4-1/',
  'Dentistry': 'https://www.ramapo.edu/majors-minors/majors/pre-dental/',
  'Master Science in Applied Mathematics (MSAM)': 'https://www.ramapo.edu/majors-minors/majors/applied-mathematics-msam/',
  'Master Science in Computer Science (MSCS)': 'https://www.ramapo.edu/majors-minors/majors/computer-science-mscs/',
  'Master Science in Data Science (MSDS)': 'https://www.ramapo.edu/majors-minors/majors/data-science-msds/',
  'Nursing (Accelerated Program)': 'https://www.ramapo.edu/majors-minors/majors/nursing-absn/',
  'Nursing (MSN) (Education Track)': 'https://www.ramapo.edu/majors-minors/majors/msn/',
  'Nursing (MSN) (Family Nurse Practitioner)': 'https://www.ramapo.edu/majors-minors/majors/nursing-msn-family-nurse-practitioner/',
  'Nursing (MSN) (Nurse Administration)': 'https://www.ramapo.edu/majors-minors/majors/nursing-msn-nurse-administration/',
};

function fetchHtml(url: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchHtml(loc, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html: string, prop: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function extractSectionText(plain: string, startRe: RegExp, maxLen = 800): string {
  const m = plain.match(startRe);
  if (!m || m.index === undefined) return '';
  const start = m.index + m[0].length;
  let text = plain.slice(start, start + maxLen * 2);
  // Stop at next major heading-like pattern (all caps block or common stop words)
  text = text.replace(/\b(Apply Now|Request Information|Learn More|Contact Us|Related Programs|How to Apply|Faculty Spotlight|Virtual Tour)\b.*/i, '');
  return text.trim().slice(0, maxLen);
}

function extractSampleCourses(html: string): string[] {
  // Find bullet points that look like course codes: e.g. "CSSS 101 – INTRO..."
  const plain = stripHtml(html);
  const courseRe = /\b([A-Z]{2,5}\s+\d{3,4})\s*[–\-—]\s*([^.;\n]{5,80})/g;
  const courses: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = courseRe.exec(plain)) !== null && courses.length < 8) {
    courses.push(`${m[1]} – ${m[2].trim()}`);
  }
  return courses;
}

async function enrichMajor(major: MajorEntry): Promise<MajorEntry> {
  const url = URL_CORRECTIONS[major.name] ?? major.url;
  try {
    const html = await fetchHtml(url);
    const plain = stripHtml(html);

    const description = extractMeta(html, 'og:description')
      || extractSectionText(plain, /About\s+the\s+\w+\s+(Major|Program|MS|MBA|MSN|MAEL|MASE|MPP)/i, 600)
      || '';

    const whatYoullLearn = extractSectionText(plain, /What\s+You'?ll?\s+Learn/i, 700)
      || extractSectionText(plain, /What\s+you\s+will\s+study/i, 700);

    const careers = extractSectionText(plain, /Careers?\s*[&]?\s*Outcomes?/i, 700)
      || extractSectionText(plain, /Career\s+Paths?/i, 600)
      || extractSectionText(plain, /Job\s+Opportunities/i, 600);

    const sampleCourses = extractSampleCourses(html);

    return {
      ...major,
      url, // use corrected URL
      description: description || major.description,
      whatYoullLearn: whatYoullLearn || undefined,
      sampleCourses: sampleCourses.length > 0 ? sampleCourses : undefined,
      careers: careers || major.careers || undefined,
    };
  } catch (e) {
    console.error(`  ✗ ${major.name} [${url}] — ${(e as Error).message}`);
    return { ...major, url };
  }
}

async function main() {
  const data: ProgramsData = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
  const allMajors = data.schools.flatMap(s => s.majors);
  console.log(`Enriching ${allMajors.length} majors (full scrape)...`);

  const BATCH = 5;
  const enriched: Record<string, MajorEntry> = {};

  for (let i = 0; i < allMajors.length; i += BATCH) {
    const batch = allMajors.slice(i, i + BATCH);
    console.log(`  Batch ${Math.floor(i / BATCH) + 1}: ${batch.map(m => m.name).join(', ')}`);
    const results = await Promise.all(batch.map(enrichMajor));
    results.forEach(m => { enriched[m.name] = m; });
    if (i + BATCH < allMajors.length) await new Promise(r => setTimeout(r, 600));
  }

  const enrichedData: ProgramsData = {
    ...data,
    generatedAt: new Date().toISOString(),
    schools: data.schools.map(school => ({
      ...school,
      majors: school.majors.map(m => enriched[m.name] ?? m),
    })),
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(enrichedData, null, 2));
  const withDesc = Object.values(enriched).filter(m => m.description).length;
  const withCourses = Object.values(enriched).filter(m => m.sampleCourses?.length).length;
  const withCareers = Object.values(enriched).filter(m => m.careers).length;
  console.log(`\n✓ Done!`);
  console.log(`  Descriptions:   ${withDesc}/${allMajors.length}`);
  console.log(`  Sample courses: ${withCourses}/${allMajors.length}`);
  console.log(`  Careers:        ${withCareers}/${allMajors.length}`);
}

main().catch(console.error);
