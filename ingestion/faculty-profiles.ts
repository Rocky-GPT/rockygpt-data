import fs from 'fs';
import { createHash } from 'node:crypto';
import path from 'path';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { fetchWithPolicy } from './http-client';
import {
  assertCollectionCount,
  isRawOnlyMode,
  runGeneratorScript,
  writeJsonFile,
  writeRawProvenance,
} from './pipeline-utils';
import { type FacultyProfile, validateFacultyProfiles } from './schema';
import { publicPath } from '../src/paths';
import { assertFacultyProfileCoverage, parseFacultyProfileHtml, parseLibraryStaffHtml, type FacultyParseDiagnostic, type FacultyProfileParseResult } from './faculty-profile-parser';

const RAW_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'faculty.raw.json');
const SOURCE_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'faculty-sources.raw.json');
const sourceCaptures: FacultySourceCapture[] = [];

interface FacultySourceCapture {
  requestedUrl: string; url: string; role: 'profile' | 'school' | 'library'; school?: string;
  fetchedAt: string; status: number; contentType: string; contentHash: string; html: string;
  parser?: { sectionCounts: FacultyProfileParseResult['sectionCounts']; diagnostics: FacultyParseDiagnostic[] };
}

function captureSource(response: { url: string; status: number; headers: Headers; text(): string }, requestedUrl: string, role: FacultySourceCapture['role'], school?: string): FacultySourceCapture {
  const html = response.text();
  const capture: FacultySourceCapture = { requestedUrl, url: response.url, role, ...(school ? { school } : {}),
    fetchedAt: new Date().toISOString(), status: response.status, contentType: response.headers.get('content-type') || '',
    contentHash: createHash('sha256').update(html).digest('hex'), html };
  sourceCaptures.push(capture);
  return capture;
}

const JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'normalized', 'faculty.json');
const IMAGES_DIR = publicPath('images', 'faculty');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-faculty-md.ts');

// Ensure directories exist
if (!fs.existsSync(path.dirname(JSON_OUTPUT_PATH))) fs.mkdirSync(path.dirname(JSON_OUTPUT_PATH), { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const limit = pLimit(5); // Concurrency limit

async function fetchPage(url: string, role: 'school' | 'library', school?: string) {
  try {
    const response = await fetchWithPolicy(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
    );
    const capture = captureSource(response, url, role, school);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return cheerio.load(capture.html);
  } catch (error: unknown) {
    console.error(`Error fetching ${url}:`, getErrorMessage(error));
    return null;
  }
}

async function downloadImage(url: string, filename: string): Promise<string | null> {
  if (isRawOnlyMode()) return null;
  if (!url) return null;
  try {
    const response = await fetchWithPolicy(
      url,
      { method: 'GET' },
      { maxResponseBytes: 15 * 1024 * 1024 }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const filePath = path.join(IMAGES_DIR, filename);
    fs.writeFileSync(filePath, response.body);
    console.log(`Downloaded image: ${filename}`);
    return `/images/faculty/${filename}`;
  } catch (error: unknown) {
    console.warn(`Failed to download image ${url}:`, getErrorMessage(error));
    return null;
  }
}

async function scrapeProfile(url: string, schoolName: string): Promise<FacultyProfile | null> {
  // console.log(`Processing ${url}...`);

  try {
    const response = await fetchWithPolicy(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
    );
    const capture = captureSource(response, url, 'profile', schoolName);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseFacultyProfileHtml(capture.html, url, schoolName);
    capture.parser = { sectionCounts: parsed.sectionCounts, diagnostics: parsed.diagnostics };
    assertFacultyProfileCoverage(parsed);
    for (const diagnostic of parsed.diagnostics) {
      if (diagnostic.reason !== 'external_reference' && diagnostic.reason !== 'unrecognized_heading') {
        console.warn(`[WARN] Faculty profile ${url}: ${JSON.stringify(diagnostic)}`);
      }
    }
    const profile = parsed.profile;
    if (!profile) return null;
    if (profile.imageUrl) {
      const slug = url.split('/').filter(Boolean).pop() || profile.name.replace(/\s+/g, '-').toLowerCase();
      const ext = path.extname(profile.imageUrl).split('?')[0] || '.jpg';
      profile.imagePath = await downloadImage(profile.imageUrl, `${slug}${ext}`) || '';
    }
    return profile;

  } catch (error) {
    console.error(`Error scraping ${url}:`, error);
    return null;
  }
}

async function scrapeLibrary(): Promise<FacultyProfile[]> {
  const url = 'https://www.ramapo.edu/library/staff/';
  console.log(`Scraping Library Staff: ${url}`);
  
  // Library page requires User-Agent and might be dynamic.
  // Using the selectors found by browser agent.
  const $ = await fetchPage(url, 'library');
  if (!$) return [];

  const profiles = parseLibraryStaffHtml($.html(), url);

  // Download images for library staff
  for (const profile of profiles) {
      if (profile.imageUrl) {
          const slug = profile.name.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
          const ext = path.extname(profile.imageUrl).split('?')[0] || '.jpg';
          const filename = `library-${slug}${ext}`;
          const savedPath = await downloadImage(profile.imageUrl, filename);
          if (savedPath) profile.imagePath = savedPath;
      }
  }
  
  console.log(`Found ${profiles.length} library staff profiles.`);
  return profiles;
}

async function scrapeSchool(schoolUrl: string, schoolName: string) {
  console.log(`Scraping school: ${schoolName} (${schoolUrl})`);
  const $ = await fetchPage(schoolUrl, 'school', schoolName);
  if (!$) return [];

  const profiles: FacultyProfile[] = [];
  const profileLinks: string[] = [];

  // Iterate over .facProfile elements directly
  $('.facProfile').each((i, el) => {
      const link = $(el).find('a').first();
      
      if (link.length > 0) {
          // Has individual profile page
          const href = link.attr('href');
          if (href) {
                let fullUrl = href;
                if (!href.startsWith('http')) {
                    if (href.startsWith('/')) {
                        fullUrl = `https://www.ramapo.edu${href}`;
                    } else {
                        fullUrl = `${schoolUrl}${href}`;
                    }
                }
                
                if (!fullUrl.includes('#') && !profileLinks.includes(fullUrl)) {
                    profileLinks.push(fullUrl);
                }
          }
      } else {
          // Linkless Profile (Common for Adjuncts)
          // Extract info directly from this element
          const name = $(el).find('h4').text().trim();
          if (name) {
              let photoUrl = $(el).find('img').attr('src') || '';
              if (photoUrl && !photoUrl.startsWith('http')) {
                    photoUrl = `https://www.ramapo.edu${photoUrl}`;
              }
              
              profiles.push({
                  name,
                  title: 'Adjunct Faculty', // Assumption for linkless profiles in adjunct lists
                  school: schoolName,
                  email: '', // Usually not listed here
                  phone: '',
                  office: '',
                  bio: '',
                  education: [],
                  courses: [],
                  teachingInterests: [],
                  researchInterests: [],
                  publishedResearch: [],
                  profileUrl: schoolUrl, // Link to the list page
                  imageUrl: photoUrl
              });
          }
      }
  });

  // Download images for linkless profiles
  for (const profile of profiles) {
      if (profile.imageUrl) {
          const slug = profile.name.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
          const ext = path.extname(profile.imageUrl).split('?')[0] || '.jpg';
          const filename = `adjunct-${slug}${ext}`; // Prefix to avoid collisions
          const savedPath = await downloadImage(profile.imageUrl, filename);
          if (savedPath) profile.imagePath = savedPath;
      }
  }

  console.log(`Found ${profileLinks.length} linked profiles and ${profiles.length} linkless profiles for ${schoolName}`);
  
  // Scrape linked profiles
  const linkedProfiles: FacultyProfile[] = [];
  const promises = profileLinks.map(url => limit(async () => {
      console.log(`Processing ${url}...`);
      const profile = await scrapeProfile(url, schoolName);
      if (profile) linkedProfiles.push(profile);
  }));

  await Promise.all(promises);
  return [...profiles, ...linkedProfiles];
}

async function main() {
  console.log('Starting full faculty scrape...');
  
  const schools = [
    // Main Faculty Lists
    { name: 'Anisfield School of Business', url: 'https://www.ramapo.edu/asb/faculty/' },
    {
      name: 'School of Arts, Humanities, and Education',
      url: 'https://www.ramapo.edu/ahe/faculty/',
    },
    {
      name: 'School of Social Sciences and Social Work',
      url: 'https://www.ramapo.edu/sssw/faculty/',
    },
    {
      name: 'School of Science, Nursing, and Health',
      url: 'https://www.ramapo.edu/snh/faculty/',
    },
    
    // Adjunct Faculty Lists
    { name: 'Anisfield School of Business (Adjunct)', url: 'https://www.ramapo.edu/asb/adjunct-faculty-profiles/' },
    {
      name: 'School of Science, Nursing, and Health (Adjunct)',
      url: 'https://www.ramapo.edu/snh/adjunct-faculty-profiles/',
    },
    
    // Retired Faculty
    {
      name: 'School of Social Sciences and Social Work (Retired)',
      url: 'https://www.ramapo.edu/sssw/retired-faculty-profiles/',
    },
  ];

  let allFaculty: FacultyProfile[] = [];

  // Scrape Schools
  for (const school of schools) {
    try {
        const faculty = await scrapeSchool(school.url, school.name);
        allFaculty = [...allFaculty, ...faculty];
    } catch (e) {
        console.warn(`Failed to scrape school ${school.name}:`, e);
    }
  }

  // Scrape Library
  try {
      const libraryStaff = await scrapeLibrary();
      allFaculty = [...allFaculty, ...libraryStaff];
  } catch (e) {
      console.warn('Failed to scrape Library:', e);
  }

  // Save original HTML before validating the parsed result: failed extraction must remain replayable.
  const sourcePayload = { schemaVersion: 1, generatedAt: new Date().toISOString(), pages: sourceCaptures };
  writeJsonFile(SOURCE_OUTPUT_PATH, sourcePayload);
  writeRawProvenance('faculty-sources', {
    sourceUrl: 'https://www.ramapo.edu/academics/faculty/',
    recordCount: sourceCaptures.length, payload: sourcePayload,
  });
  const failedExtractions = sourceCaptures.filter(capture => capture.parser?.diagnostics.some(diagnostic =>
    ['missing_profile_content', 'missing_name', 'unretained_content'].includes(diagnostic.reason)));
  if (failedExtractions.length) {
    throw new Error(`Faculty collection has incomplete profile extraction; captured HTML retained for replay: ${failedExtractions.map(capture => capture.requestedUrl).join(', ')}`);
  }

  const normalizedFaculty = validateFacultyProfiles(allFaculty);
  assertCollectionCount({
    dataset: 'faculty',
    count: normalizedFaculty.length,
    minimum: 150,
    previousFilePath: RAW_JSON_OUTPUT_PATH,
    minimumPreviousRatio: 0.7,
  });
  writeJsonFile(RAW_JSON_OUTPUT_PATH, normalizedFaculty);
  writeRawProvenance('faculty', {
    sourceUrl: 'https://www.ramapo.edu/academics/faculty/',
    recordCount: normalizedFaculty.length,
    payload: normalizedFaculty,
  });
  console.log(`Saved raw faculty data to ${RAW_JSON_OUTPUT_PATH}`);

  if (isRawOnlyMode()) {
    console.log('RAW_ONLY enabled: skipping normalization and context generation.');
    return;
  }

  writeJsonFile(JSON_OUTPUT_PATH, normalizedFaculty);
  console.log(`Saved normalized faculty data to ${JSON_OUTPUT_PATH}`);

  runGeneratorScript(MARKDOWN_GENERATOR_PATH);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
