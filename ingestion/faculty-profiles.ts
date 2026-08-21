import fs from 'fs';
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

const RAW_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'faculty.raw.json');
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

function dedupeList(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))
  );
}

async function fetchPage(url: string) {
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return cheerio.load(response.text());
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const $ = cheerio.load(response.text());

    // 1. Extract Name
    // Found in <div class="callout-no-image"><h1>Name</h1></div>
    let name = $('.callout-no-image h1').text().trim();
    if (!name) {
        name = $('h1').first().text().trim();
    }
    // Fallback to title tag if h1 is missing
    if (!name) {
         const titleTag = $('title').text().trim(); // e.g., "Rikki Abzug - Anisfield..."
         if (titleTag) {
             name = titleTag.split('-')[0].trim();
         }
    }

    if (!name) {
        console.warn(`[WARN] No name found for ${url}`);
        return null; // Skip if no name
    }

    // 2. Extract Photo & Title
    // <div class="col-lg-9" id="content-block"> ... <h3><img ... class="facphotoLarge ...">Title</h3>
    const contentBlock = $('#content-block .col-lg-12').first();
    const photoEl = contentBlock.find('.facphotoLarge');
    
    let photoUrl = photoEl.attr('src') || '';
    if (photoUrl && !photoUrl.startsWith('http')) {
        photoUrl = `https://www.ramapo.edu${photoUrl}`;
    }

    // Title is the text of the h3 tag that contains the photo
    let title = photoEl.closest('h3').text().trim();
    if (!title) {
        // Fallback: looking for h3 in content block if photo structure is different
        title = contentBlock.find('h3').first().text().trim();
    }

    // 3. Extract Contact Info
    // <h4>Contact Information</h4><ul><li>Phone: ...</li>...</ul>
    let email = '';
    let phone = '';
    let office = '';

    const contactHeader = contentBlock.find('h4').filter((i, el) => $(el).text().includes('Contact Information'));
    if (contactHeader.length > 0) {
        const contactList = contactHeader.next('ul');
        contactList.find('li').each((i, el) => {
            const text = $(el).text();
            if (text.includes('Email:')) {
                email = $(el).find('a').text().trim();
            } else if (text.includes('Phone:')) {
                phone = text.replace('Phone:', '').trim();
            } else if (text.includes('Office:')) {
                office = text.replace('Office:', '').trim();
            }
        });
    }

    // 4. Extract Structured Info & Bio
    const education: string[] = [];
    const courses: string[] = [];
    const teachingInterests: string[] = [];
    const researchInterests: string[] = [];
    const publishedResearch: string[] = [];

    // Helper to extract list items after a header
    const extractList = (headerText: string, targetArray: string[]) => {
        const header = contentBlock.find('h4').filter((i, el) => $(el).text().toLowerCase().includes(headerText.toLowerCase()));
        if (header.length > 0) {
            let nextElem = header.next();
            // It could be a ul directly, or some intermediate text/div
            if (nextElem.is('ul')) {
                nextElem.find('li').each((i, el) => {
                    targetArray.push($(el).text().trim());
                });
            } else {
                 // Try one more next if it was a div or something
                 nextElem = nextElem.next();
                 if (nextElem.is('ul')) {
                    nextElem.find('li').each((i, el) => {
                        targetArray.push($(el).text().trim());
                    });
                 }
            }
        }
    };

    const extractSectionEntries = (headerTexts: string[], targetArray: string[]) => {
      const lowerHeaders = headerTexts.map((header) => header.toLowerCase());
      const header = contentBlock
        .find('h4')
        .filter((_, el) => {
          const text = $(el).text().toLowerCase();
          return lowerHeaders.some((candidate) => text.includes(candidate));
        })
        .first();

      if (!header.length) return;

      let current = header.next();
      while (current.length > 0) {
        const currentText = current.text().replace(/\s+/g, ' ').trim();
        if (
          current.is('h4, h3, .collapsableContent, .disclaimer, footer') ||
          current.find('.collapsableTitle, .disclaimer').length > 0 ||
          /^more about\s+/i.test(currentText)
        ) {
          break;
        }

        if (current.is('ul, ol')) {
          current.find('li').each((_, li) => {
            const text = $(li).text().replace(/\s+/g, ' ').trim();
            if (text) targetArray.push(text);
          });
        } else if (current.is('p, div')) {
          const text = current.text().replace(/\s+/g, ' ').trim();
          if (text) {
            text
              .split(/(?:\s*;\s+|\s*\n+\s*|\.\s+(?=[A-Z]))/)
              .map((part) => part.replace(/\s+/g, ' ').trim())
              .filter((part) => part.length > 20)
              .forEach((part) => targetArray.push(part));
          }
        }

        current = current.next();
      }
    };

    extractList('Education', education);
    extractList('Courses Offered', courses);
    extractList('Teaching Interest', teachingInterests);
    extractList('Research Interest', researchInterests);
    extractSectionEntries(
      ['Recent Publications', 'Publications', 'Published Research', 'Selected Publications'],
      publishedResearch
    );

    // 5. Construct Narrative Bio
    // Clone content block and remove everything we've already extracted or don't want
    const bioContainer = contentBlock.clone();
    
    // Remove Title/Photo header (h3)
    bioContainer.find('h3').remove();
    
    // Remove Contact Info
    bioContainer.find('h4').filter((i, el) => $(el).text().includes('Contact Information')).next('ul').remove();
    bioContainer.find('h4').filter((i, el) => $(el).text().includes('Contact Information')).remove();
    
    // Remove "Year Joined"
    bioContainer.find('h4').filter((i, el) => $(el).text().includes('Year Joined')).remove();

    // Remove structured sections already represented by typed fields. Stop
    // before the collapsible narrative bio so useful biography text remains.
    [
      'Education',
      'Courses Offered',
      'Teaching Interest',
      'Research Interest',
      'Recent Publications',
      'Selected Publications',
      'Published Research',
      'Publications',
    ].forEach((headerText) => {
      bioContainer
        .find('h4')
        .filter((_, el) => $(el).text().toLowerCase().includes(headerText.toLowerCase()))
        .each((_, element) => {
          const header = $(element);
          let current = header.next();
          while (
            current.length > 0 &&
            !current.is('h4, h3, .collapsableContent, .disclaimer')
          ) {
            const next = current.next();
            current.remove();
            current = next;
          }
          header.remove();
        });
    });

    // Also remove the "More about Name" toggle header
    bioContainer.find('.collapsableTitle').remove();

    // Remove scripts, styles, disclaimer
    bioContainer.find('script').remove();
    bioContainer.find('style').remove();
    bioContainer.find('.disclaimer').remove(); 

    // Get remaining text (Narrative Bio)
    let bioKeyPoints = bioContainer.text().trim();
    bioKeyPoints = bioKeyPoints.replace(/\n\s*\n/g, '\n\n').trim();

    // 5. Download Photo (Local path logic)
    let imagePath = '';
    if (photoUrl) {
        const slug = url.split('/').filter(Boolean).pop() || name.replace(/\s+/g, '-').toLowerCase();
        const ext = path.extname(photoUrl).split('?')[0] || '.jpg';
        const filename = `${slug}${ext}`;
        // We call the helper function
        const savedPath = await downloadImage(photoUrl, filename);
        if (savedPath) imagePath = savedPath;
    }

    return {
      name,
      title,
      email,
      phone,
      office,
      bio: bioKeyPoints,
      education: dedupeList(education),
      courses: dedupeList(courses),
      teachingInterests: dedupeList(teachingInterests),
      researchInterests: dedupeList(researchInterests),
      publishedResearch: dedupeList(publishedResearch),
      school: schoolName,
      profileUrl: url,
      imageUrl: photoUrl,
      imagePath
    };

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
  const $ = await fetchPage(url);
  if (!$) return [];

  const profiles: FacultyProfile[] = [];
  
  // Selectors:
  // Container: .et_pb_blurb_content
  // Name: h4.et_pb_module_header
  // Title: First line of .et_pb_blurb_description
  // Email: link in description with 'contact-form'
  
  $('.et_pb_blurb_content').each((i, el) => {
      try {
          const name = $(el).find('h4.et_pb_module_header').text().trim();
          if (!name) return;

          // Filter out known non-staff UI elements found on the page
          const invalidNames = ['New Books', 'New DVDs', 'Recreational Reading', 'Floor Guides', 'Study Rooms', 'Library Instruction', 'Suggest a Purchase', 'Course Reserves'];
          if (invalidNames.includes(name) || name.includes('New Books') || name.includes('New DVDs')) return;

          const description = $(el).find('.et_pb_blurb_description');
          let title = '';
          let email = '';
          const phone = ''; 
          const office = ''; 

          if (description.length) {
              const lines = description.text().split('\n').map(l => l.trim()).filter(l => l);
              if (lines.length > 0) title = lines[0];

              const emailLink = description.find('a[href*="contact-form"]');
              if (emailLink.length) {
                  const username = emailLink.text().trim();
                  if (username && !username.includes(' ')) {
                     email = `${username}@ramapo.edu`;
                  }
              }
          }
          
          // Strict validation: Must have an email OR a title that looks like a title (not empty)
          // And name shouldn't be generic if no email.
          if (!email && !title) return;

          let photoUrl = $(el).find('.et_pb_main_blurb_image img').attr('src') || '';
           if (photoUrl && !photoUrl.startsWith('http')) {
                photoUrl = `https://www.ramapo.edu${photoUrl}`;
           }

          profiles.push({
              name,
              title,
              school: 'Library Faculty & Staff',
              email,
              phone,
              office,
              bio: '',
              education: [],
              courses: [],
              teachingInterests: [],
              researchInterests: [],
              publishedResearch: [],
              profileUrl: url,
              imageUrl: photoUrl
          });

      } catch (err) {
          console.error('Error parsing library profile:', err);
      }
  });

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
  const $ = await fetchPage(schoolUrl);
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
