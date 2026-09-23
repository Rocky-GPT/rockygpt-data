/** Pure parsing of a captured faculty profile. No network, image downloads or writes. */
import { load, type CheerioAPI } from 'cheerio';
import { isTag, type AnyNode } from 'domhandler';
import type { FacultyProfile } from './schema';

export type FacultySection = 'education' | 'courses' | 'teachingInterests' | 'researchInterests' | 'publishedResearch';
export interface FacultyParseDiagnostic {
  reason: 'missing_profile_content' | 'missing_name' | 'empty_section' | 'external_reference' | 'unrecognized_heading' | 'unretained_content';
  section?: FacultySection;
  heading?: string;
  url?: string;
  text?: string;
}
export interface FacultyProfileParseResult {
  profile: FacultyProfile | null;
  diagnostics: FacultyParseDiagnostic[];
  sectionCounts: Record<FacultySection, { headings: number; entries: number }>;
}

const LABELS: Record<string, FacultySection> = {
  education: 'education',
  oneducation: 'education',
  byeducation: 'education',
  'courses offered': 'courses',
  'courses taught': 'courses',
  'teaching interest': 'teachingInterests',
  'teaching interests': 'teachingInterests',
  'teaching interest/s': 'teachingInterests',
  'research interest': 'researchInterests',
  'research interests': 'researchInterests',
  'research interest/s': 'researchInterests',
  'recent publications': 'publishedResearch',
  'selected publications': 'publishedResearch',
  'select publications': 'publishedResearch',
  'peer reviewed publications': 'publishedResearch',
  'invited publications': 'publishedResearch',
  'analytical publications': 'publishedResearch',
  'books written': 'publishedResearch',
  'publications': 'publishedResearch',
  'published research': 'publishedResearch',
  'scholarly publications': 'publishedResearch',
  'publications example': 'publishedResearch',
};
const EXCLUDED = 'script, style, nav, footer, .disclaimer, [role="navigation"]';
const BLOCK = 'p, ul, ol, h1, h2, h3, h4, h5, h6, table, blockquote, pre';
const compact = (value: string): string => value.replace(/\s+/g, ' ').trim();
const label = (value: string): string => compact(value).replace(/:$/, '').toLowerCase().replace(/peer[-‐‑–]reviewed/g, 'peer reviewed');
const dedupe = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function sectionFor(value: string): FacultySection | undefined {
  const normalized = label(value);
  if (/^recent publications \(from \d{4} to (?:present|\d{4})\)$/.test(normalized)) return 'publishedResearch';
  return LABELS[normalized];
}

function text($: CheerioAPI, node: AnyNode): string {
  if (node.type === 'text') return compact(node.data);
  const copy = $(node).clone();
  copy.find(EXCLUDED).remove();
  copy.find('br').replaceWith('\n');
  // Preserve nested list/paragraph boundaries without extracting descendants twice.
  copy.find('li, p, div').each((_, child) => { $(child).prepend('\n').append('\n'); });
  return copy.text().split('\n').map(compact).filter(Boolean).join('\n');
}

function webUrl(value: string | undefined, base: string): string {
  if (!value) return '';
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

/** Preserve web destinations as well as display text, without fetching linked pages. */
function linkedText($: CheerioAPI, node: AnyNode, base: string): string {
  const copy = $(node).clone();
  copy.find('a[href]').each((_, anchor) => {
    const url = webUrl($(anchor).attr('href'), base);
    if (url && compact($(anchor).text()) !== url) $(anchor).append(` (${url})`);
  });
  return copy[0] ? text($, copy[0]) : text($, node);
}

/** A whole semantic heading, never a heading phrase embedded in a publication citation. */
function heading($: CheerioAPI, node: AnyNode): string | null {
  if (!isTag(node)) return null;
  const element = $(node);
  const value = compact(element.text());
  if (!value || element.find('ul, ol, p, table').length) return null;
  if (!element.find('a[href]').length && (sectionFor(value) || label(value) === 'contact information')) return value;
  if (/^h[1-6]$/.test(node.name) || element.is('.collapsableTitle')) return value;
  // Some profiles format all headings as bold paragraphs instead of semantic h4s.
  // Unknown labels still end the prior section and stay in the biography.
  const emphasized = element.find('strong, b, em');
  if (element.is('p') && value.length <= 100 && (value.endsWith(':') || emphasized.length > 0
      && label(emphasized.text()) === label(value)) && !element.find('a').length
      && /^[\p{L}\p{N}\s&/(),’'–—:-]+$/u.test(value)) return value;
  return null;
}

type Block = { node: AnyNode; biographyBoundary?: boolean };
function blocks($: CheerioAPI, nodes: AnyNode[]): Block[] {
  const output: Block[] = [];
  function visit(node: AnyNode): void {
    if (isTag(node)) {
      const element = $(node);
      if (element.is(EXCLUDED)) return;
      if (element.is('.collapsableContent')) {
        output.push({ node, biographyBoundary: true });
        element.contents().each((_, child) => { visit(child); });
      } else if (heading($, node) !== null || element.is(BLOCK)) output.push({ node });
      else if (element.find(BLOCK).length) element.contents().each((_, child) => { visit(child); });
      else if (text($, node)) output.push({ node });
    } else if (node.type === 'text' && compact(node.data)) output.push({ node });
  }
  nodes.forEach(visit);
  return output;
}

/** Parse only the profile content region; never use site navigation as faculty evidence. */
export function parseFacultyProfileHtml(html: string, profileUrl: string, schoolName: string): FacultyProfileParseResult {
  const $ = load(html);
  const diagnostics: FacultyParseDiagnostic[] = [];
  const sectionCounts: FacultyProfileParseResult['sectionCounts'] = {
    education: { headings: 0, entries: 0 }, courses: { headings: 0, entries: 0 },
    teachingInterests: { headings: 0, entries: 0 }, researchInterests: { headings: 0, entries: 0 },
    publishedResearch: { headings: 0, entries: 0 },
  };
  const content = $('#content-block .col-lg-12').first();
  if (!content.length) return { profile: null, sectionCounts, diagnostics: [{ reason: 'missing_profile_content' }] };
  const name = compact($('.callout-no-image h1').first().text())
    || compact($('h1').first().text()) || compact($('title').text().split(' - ')[0]);
  if (!name) return { profile: null, sectionCounts, diagnostics: [{ reason: 'missing_name' }] };
  const photo = content.find('.facphotoLarge').first();
  const titleHeader = photo.closest('h3').length ? photo.closest('h3') : content.find('h3').first();
  const profile: FacultyProfile = {
    name, title: compact(titleHeader.text()), school: schoolName,
    email: '', phone: '', office: '', bio: '',
    education: [], courses: [], teachingInterests: [], researchInterests: [], publishedResearch: [],
    profileUrl, imageUrl: webUrl(photo.attr('src'), profileUrl), imagePath: '',
  };
  const biography: string[] = [];
  let section: FacultySection | 'contact' | null = null;
  let entryGroup: string | null = null;
  let sectionContext: string | null = null;
  let sectionLevel = 0;
  let previousPublicationParagraph = false;
  let followsSectionHeading = false;
  const encountered: { section: FacultySection; heading: string }[] = [];
  function entryText(node: AnyNode): string {
    const value = text($, node);
    const links = $(node).find('a[href]');
    // An external bibliography link is evidence of the link, not its unseen contents.
    // Keep its destination rather than reducing a link-only entry to "Google Scholar".
    if (links.length === 1 && compact(links.text()) === compact(value)) {
      const url = webUrl(links.attr('href'), profileUrl);
      if (url) {
        if (section && section !== 'contact') diagnostics.push({ reason: 'external_reference', section, url });
        return compact(value) === url ? value : `${value} (${url})`;
      }
    }
    // Retain destinations embedded in prose too (CVs, labs, article links, etc.).
    return linkedText($, node, profileUrl);
  }
  for (const block of blocks($, content.contents().toArray())) {
    const { node } = block;
    if (block.biographyBoundary) {
      if (!followsSectionHeading) { section = null; entryGroup = null; sectionContext = null; }
      continue;
    }
    if (node === titleHeader[0]) { section = null; continue; }
    const sectionHeading = heading($, node);
    if (sectionHeading !== null) {
      previousPublicationParagraph = false;
      if (section === 'courses' && /^(?:undergraduate|graduate|for the .+ (?:major|program))\s*:?$/i.test(sectionHeading)) {
        entryGroup = sectionHeading;
        continue;
      }
      const level = isTag(node) && /^h[1-6]$/.test(node.name) ? Number(node.name[1]) : 0;
      if (section === 'publishedResearch' && (!level || !sectionLevel || level > sectionLevel)
          && /^(?:(?:peer reviewed|encyclopedia) )?(?:books|monographs|articles|papers|book reviews|chapters(?: in edited books)?|education materials)$/.test(label(sectionHeading))) {
        entryGroup = sectionHeading;
        continue;
      }
      const normalized = label(sectionHeading);
      const mapped = sectionFor(sectionHeading);
      followsSectionHeading = Boolean(mapped);
      entryGroup = null;
      sectionContext = /\(from \d{4} to (?:present|\d{4})\)/i.test(sectionHeading) ? sectionHeading : null;
      if (mapped) {
        section = mapped;
        sectionLevel = level;
        sectionCounts[mapped].headings++;
        encountered.push({ section: mapped, heading: sectionHeading });
      } else if (normalized === 'contact information') section = 'contact';
      else {
        section = null;
        if (!/^more about\b/i.test(sectionHeading)) {
          biography.push(sectionHeading);
          if (!/^year joined\b/i.test(sectionHeading)) diagnostics.push({ reason: 'unrecognized_heading', heading: sectionHeading });
        }
      }
      continue;
    }
    const element = $(node);
    followsSectionHeading = false;
    const isList = isTag(node) && element.is('ul, ol');
    // A list immediately following a publication paragraph often contains its
    // translation/review notes. Retain the source grouping instead of inventing
    // additional bibliography entries for those notes.
    if (section === 'publishedResearch' && isList && previousPublicationParagraph && profile.publishedResearch.length) {
      profile.publishedResearch[profile.publishedResearch.length - 1] += `\n${entryText(node)}`;
      previousPublicationParagraph = false;
      continue;
    }
    const entries = isList ? element.children('li').toArray() : [node];
    for (const item of entries) {
      const value = entryText(item);
      if (!value) continue;
      if (section === 'contact') {
        const match = value.match(/^(Email|Phone|Office)\s*:\s*([\s\S]*)$/i);
        if (match) {
          const field = match[1].toLowerCase() as 'email' | 'phone' | 'office';
          // Retain what the source publishes; do not invent domains or full phone numbers.
          profile[field] = compact(match[2]);
        } else biography.push(value); // Office Hours and other unmapped contact text remain available.
      } else if (section) profile[section].push([sectionContext, entryGroup, value].filter(Boolean).join('\n'));
      else biography.push(value);
    }
    previousPublicationParagraph = section === 'publishedResearch' && isTag(node) && element.is('p') && Boolean(text($, node));
  }
  for (const key of Object.keys(sectionCounts) as FacultySection[]) {
    profile[key] = dedupe(profile[key]);
    sectionCounts[key].entries = profile[key].length;
  }
  // Empty source sections remain unknown. Diagnostics distinguish them from absent headings.
  for (const item of encountered) {
    if (!sectionCounts[item.section].entries) diagnostics.push({ reason: 'empty_section', section: item.section, heading: item.heading });
  }
  profile.bio = dedupe(biography).join('\n\n');
  // Audit the original text nodes independently of section assignment. A parser
  // must not report success after quietly consuming a section it failed to retain.
  const canonical = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const retained = canonical(Object.values(profile).flat().join('\n'));
  const missed = new Set<string>();
  function verify(node: AnyNode): void {
    if (isTag(node)) {
      if ($(node).is(EXCLUDED)) return;
      const semantic = heading($, node);
      if (semantic && (sectionFor(semantic) || label(semantic) === 'contact information'
          || /^more about\b/i.test(semantic))) return;
      $(node).contents().each((_, child) => { verify(child); });
    } else if (node.type === 'text') {
      const value = compact(node.data).replace(/^(?:Email|Phone|Office)\s*:\s*/i, '');
      if (value && /[\p{L}\p{N}]/u.test(value) && !retained.includes(canonical(value))) missed.add(value);
    }
  }
  content.contents().each((_, node) => { verify(node); });
  for (const value of missed) diagnostics.push({ reason: 'unretained_content', text: value });
  return { profile, sectionCounts, diagnostics };
}

/** Reject actual lost source text, not legitimately empty or absent source sections. */
export function assertFacultyProfileCoverage(result: FacultyProfileParseResult): void {
  const failures = result.diagnostics.filter(diagnostic =>
    ['missing_profile_content', 'missing_name', 'unretained_content'].includes(diagnostic.reason));
  if (failures.length) throw new Error(`Faculty extraction omitted source content: ${JSON.stringify(failures)}`);
}

/** Replay the shared library listing without issuing new requests or downloading photos. */
export function parseLibraryStaffHtml(html: string, profileUrl: string): FacultyProfile[] {
  const $ = load(html);
  const profiles: FacultyProfile[] = [];
  const byName = new Map<string, FacultyProfile>();
  const invalidNames = new Set(['New Books', 'New DVDs', 'Recreational Reading', 'Floor Guides',
    'Study Rooms', 'Library Instruction', 'Suggest a Purchase', 'Course Reserves']);
  $('.et_pb_blurb_content').each((_, element) => {
    const name = compact($(element).find('h4.et_pb_module_header').text());
    if (!name || invalidNames.has(name) || /New Books|New DVDs/.test(name)) return;
    const description = $(element).find('.et_pb_blurb_description');
    const lines = description[0] ? text($, description[0]).split('\n') : [];
    const title = lines[0] || '';
    // A contact-form username does not establish an email address. Keep the
    // form link in the biography and use only explicitly published addresses.
    const mailto = description.find('a[href^="mailto:"]').first().attr('href')?.slice(7).split('?')[0];
    const literal = description.text().match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i)?.[0];
    const email = mailto || literal || '';
    if (!title && !email) return;
    const phone = description.find('a[href^="tel:"]').first().attr('href')?.slice(4) || '';
    // These source rows explicitly print room identifiers on their own line.
    // Preserve the published identifier without inferring a building or room.
    const office = lines.find(line => /^LC-\d+[A-Z]?$/i.test(line)) || '';
    const profile: FacultyProfile = { name, title, school: 'Library Faculty & Staff', email,
      phone, office, bio: description[0] ? linkedText($, description[0], profileUrl) : '',
      education: [], courses: [], teachingInterests: [], researchInterests: [], publishedResearch: [],
      profileUrl, imageUrl: webUrl($(element).find('.et_pb_main_blurb_image img').attr('src'), profileUrl),
    };
    // The listing repeats two staff members in its collection-development panel.
    // Match only exact names within this one source and retain both descriptions,
    // so later normalization cannot discard the additional published contact form.
    const previous = byName.get(name);
    if (previous) previous.bio = dedupe([previous.bio, profile.bio]).join('\n\n');
    else { profiles.push(profile); byName.set(name, profile); }
  });
  return profiles;
}
