/**
 * graduation-plans.ts
 *
 * Ramapo's recommended graduation plans. The index at /mygraduationplan/ lists each
 * entering cohort's plans by major, with track variants nested under their major. Each
 * plan page lays out the recommended courses semester by semester, with placement
 * sequences, total credits, the GPA, general education notes and downloadable copies.
 *
 * A plan names its program through the index: a major's link carries the site's program
 * code, the last segment of the catalog code (CMPS for SN-BS-CMPS), and a nested variant
 * belongs to the major it is listed under. Anything else stays unlinked and is reported.
 *
 * Run: npm run fetch:graduation-plans
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawFileProvenance } from './pipeline-utils';
import { publicPath } from '../src/paths';

export const PLAN_INDEX_URL = 'https://www.ramapo.edu/mygraduationplan/';
const OUT = publicPath('data', 'graduation-plans.json');
const RAW_OUT = path.join(process.cwd(), 'data', 'raw', 'graduation-plans.raw.json');
const PROGRAMS_JSON = publicPath('data', 'programs.json');
const HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};
// One page at a time, with a pause, like a person reading the plans.
const PAUSE_MS = 300;

export interface PlanListing {
  /** The index section's own title, such as "Fall 2026 Recommended Graduation Plans by Major". */
  listing: string;
  /** The entering cohort the section names: "Fall 2026", or a span such as "2023-2024". */
  cohort: string;
  name: string;
  url: string;
  /** The site's program code on the link, when it has one. */
  code: string | null;
  /** The major this variant is listed under, for a nested link. */
  parent: { name: string; url: string; code: string | null } | null;
}

export interface PlanItem {
  /** The line's label, such as Major, Gen Ed or Career Pathways, when it has one. */
  category: string | null;
  text: string;
  courses: string[];
  hours: number | null;
  writingIntensive: boolean;
}
export interface PlanTerm { year: string; term: string; items: PlanItem[]; totalHours: number | null }
export interface NamedLink { name: string; url: string }
export interface GeneralEducationCategory { category: string; waivedForTransfers: boolean; text: string; links: NamedLink[] }

export interface GraduationPlanPage {
  title: string;
  applicability: string | null;
  introduction: string[];
  documents: NamedLink[];
  placement: Array<{ title: string; sequences: string[] }>;
  terms: PlanTerm[];
  /** Undergraduate credits required; a 4+1 plan also states its graduate credits. */
  totalCredits: number | null;
  graduateCredits: number | null;
  gpa: string | null;
  /** The page's own lines stating credits and GPA requirements, as written. */
  totals: string[];
  generalEducation: GeneralEducationCategory[];
  notes: string[];
  /** Every line of the page's content, so nothing the page says is lost. */
  text: string;
}

export interface GraduationPlan extends GraduationPlanPage {
  /** The semesters as the page lists them, one line per course line. */
  planText?: string | null;
  placementText?: string | null;
  generalEducationText?: string | null;
  id: string;
  name: string;
  cohort: string;
  listing: string;
  url: string;
  /** Where the listed link led, when it redirected. */
  finalUrl: string | null;
  /** Catalog codes of the programs this plan belongs to. */
  programCodes: string[];
  /** The major a variant is listed under, for a nested plan. */
  variantOf: string | null;
  limitations: string[];
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
// A line stating a credit total or a GPA requirement.
const STATEMENT = /\bCredits\b[^:]{0,80}:\s*[\d.]|\bGPA\b[^:]{0,40}:/i;
const cohortOf = (title: string) => /\b(?:Fall|Spring|Summer)\s+\d{4}\b|\b\d{4}\s*[-–]\s*\d{4}\b/i.exec(title)?.[0].replace(/\s*[-–]\s*/, '-') ?? clean(title);

/** Every plan the index lists, by cohort section, with nested variants under their major. */
export function planListings(html: string, base = PLAN_INDEX_URL): PlanListing[] {
  const $ = load(html);
  const listings: PlanListing[] = [];
  const absolute = (href: string | undefined) => { try { return href ? new URL(href, base).toString() : ''; } catch { return ''; } };
  const isPlan = (url: string) => /^https:\/\/www\.ramapo\.edu\/(?:recommended-graduation-plan|four-year)[^/]*\//.test(url);
  $('#content-block .collapsableContent').each((_, section) => {
    const listing = clean($(section).children('.collapsableTitle').first().text());
    const content = $(section).children('.c_content').first();
    const link = (element: Element) => {
      const anchor = $(element).children('a').first();
      return { name: clean(anchor.text()), url: absolute(anchor.attr('href')), code: anchor.attr('data-guid')?.trim() || null };
    };
    content.find('li').each((__, item) => {
      const own = link(item);
      if (!own.name || !isPlan(own.url)) return;
      const parentItem = $(item).parent('ul').parent('li');
      const parent = parentItem.length ? link(parentItem.get(0)!) : null;
      listings.push({ listing, cohort: cohortOf(listing), ...own, parent: parent && parent.name && isPlan(parent.url) ? parent : null });
    });
  });
  if (!listings.length) throw new Error('The graduation plan index lists no plans.');
  return listings;
}

function namedLinks($: CheerioAPI, scope: ReturnType<CheerioAPI>, base: string): NamedLink[] {
  return scope.find('a[href]').toArray().flatMap(anchor => {
    const name = clean($(anchor).text());
    try { return name ? [{ name, url: new URL($(anchor).attr('href')!, base).toString() }] : []; } catch { return []; }
  });
}

/** A catalog course link's code, as the catalog writes it ("CMPS 147"). */
function courseCode(url: string): string | null {
  const match = /catalog\.ramapo\.edu\/courses\/([A-Z]{2,5})(\d{3}[A-Z]?)\b/.exec(url);
  return match ? `${match[1]} ${match[2]}` : null;
}

/** One plan page: its semesters, placement, totals and notes, and all of its text. */
export function parseGraduationPlan(html: string, url: string): GraduationPlanPage {
  const $ = load(html);
  const block = $('#content-block').first();
  if (!block.length) throw new Error(`No page content at ${url}.`);
  block.find('script,style').remove();
  // A line break separates text as it does on the page, such as the credits and GPA lines.
  block.find('br').replaceWith('\n');
  const plan = block.find('.fouryear').first();
  const terms: PlanTerm[] = [];
  let year = '';
  plan.children().each((_, element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'h3') year = clean($(element).text());
    if (tag === 'h4') terms.push({ year, term: clean($(element).text()), items: [], totalHours: null });
    if (tag === 'ul' && terms.length) {
      const term = terms[terms.length - 1];
      $(element).children('li').each((__, item) => {
        const text = clean($(item).text());
        const hours = /\(HRS\s*([\d.]+)\)/i.exec(text);
        if (/^Total\s*:/i.test(text)) {
          term.totalHours = hours ? Number(hours[1]) : null;
          return;
        }
        const label = /^([A-Za-z][A-Za-z .&/]{0,40}):\s+/.exec(text);
        term.items.push({
          category: label ? label[1].trim() : null,
          text: (label ? text.slice(label[0].length) : text).replace(/\s*\(HRS\s*[\d.]+\)\s*/i, ' ').trim(),
          courses: [...new Set(namedLinks($, $(item), url).map(link => courseCode(link.url)).filter((code): code is string => Boolean(code)))],
          hours: hours ? Number(hours[1]) : null,
          writingIntensive: /\bWI\b/.test(text),
        });
      });
    }
  });
  const paragraphs = (scope: ReturnType<CheerioAPI>) => scope.find('p').toArray().map(p => clean($(p).text())).filter(Boolean);
  const before = block.find('.colSet').first();
  const introduction = paragraphs(before);
  const placement = block.find('.infoBox').toArray().map(box => ({
    title: clean($(box).find('.boxTitle').first().text()),
    sequences: paragraphs($(box).find('.boxContent').first()),
  })).filter(box => box.title && box.sequences.length);
  const generalEducation = block.find('.collapsableContent').toArray().map(section => {
    const title = clean($(section).children('.collapsableTitle').first().text());
    const content = $(section).children('.c_content').first();
    return { category: title.replace(/\s*\(\+W\)\s*$/, '').trim(), waivedForTransfers: /\(\+W\)\s*$/.test(title),
      text: paragraphs(content).join('\n'), links: namedLinks($, content, url) };
  }).filter(category => category.category);
  // Notes: the paragraphs outside the plan, placement boxes and general education lists.
  const notes = block.children().find('p').addBack('p').toArray()
    .filter(p => !$(p).closest('.fouryear, .infoBox, .collapsableContent').length && !$(p).closest(before).length)
    .map(p => clean($(p).text())).filter(text => text && !STATEMENT.test(text));
  const lines: string[] = [];
  block.find('h1,h2,h3,h4,h5,h6,p,li,.boxTitle,.collapsableTitle').each((_, element) => {
    if ($(element).is('p') && $(element).closest('li').length) return;
    const text = clean($(element).text());
    if (text && lines[lines.length - 1] !== text) lines.push(text);
  });
  // Pages word totals differently: "Total Credits Required: 128 credits GPA: 2.0", or
  // "Total Undergraduate Credits Required: 128 credits" and "Major GPA required for
  // undergraduate graduation: 2.0", with a 4+1's graduate credits on their own line.
  // Each paragraph line, wherever it sits, and each heading or list line.
  const statements = [...new Set([
    ...block.find('p').toArray().flatMap(p => $(p).text().split('\n').map(clean)),
    ...block.find('h1,h2,h3,h4,h5,h6,li').toArray().map(element => clean($(element).text())),
  ])].filter(text => text && STATEMENT.test(text));
  const first = (pattern: RegExp) => statements.map(text => pattern.exec(text)).find(Boolean);
  const credits = first(/Total (?:Undergraduate )?Credits Required(?: \([^)]*\))?(?: for (?:the )?(?:undergraduate degree|graduation))?:\s*([\d.]+)/i);
  const graduate = first(/Total Graduate Credits Required(?: for [a-z ]+)?:\s*([\d.]+)/i);
  // A single stated GPA only; varied or multiple requirements stay in their own words.
  const gpa = first(/\bGPA\b[^:\d]{0,60}:\s*([\d.]+)\s*$/i);
  const applicability = [...introduction, ...notes].find(text => /applicable to students/i.test(text))?.replace(/^NOTE:\s*/i, '') ?? null;
  return {
    title: clean($('h1').last().text()) || clean($('title').text()),
    applicability, introduction, documents: namedLinks($, before.find('.btn').parent(), url).filter(link => /\.(pdf|docx?)(\?|$)/i.test(link.url)),
    placement, terms, totalCredits: credits ? Number(credits[1]) : null, graduateCredits: graduate ? Number(graduate[1]) : null,
    gpa: gpa ? gpa[1] : null, totals: [...new Set(statements)], generalEducation, notes, text: lines.join('\n'),
  };
}

/** Listings the index shows without a major in one cohort section take the major that the
 * index lists the same plan under in another section, when every such section agrees. */
export function withSiteGrouping(listings: PlanListing[]): Array<PlanListing & { groupedElsewhere?: boolean }> {
  const parents = new Map<string, Set<string>>();
  const byKey = new Map<string, NonNullable<PlanListing['parent']>>();
  for (const listing of listings) {
    if (!listing.parent) continue;
    const key = JSON.stringify([listing.parent.name, listing.parent.code]);
    parents.set(listing.name, (parents.get(listing.name) ?? new Set()).add(key));
    byKey.set(key, listing.parent);
  }
  return listings.map(listing => {
    if (listing.parent || listing.code) return listing;
    const keys = [...(parents.get(listing.name) ?? [])];
    return keys.length === 1 ? { ...listing, parent: byKey.get(keys[0])!, groupedElsewhere: true } : listing;
  });
}

interface CatalogProgram { catalogCode?: string; programKind?: string; type?: string; name?: string }

const DEGREE_SUFFIX = /\s+(?:BA|BS|BSN|BSW|BFA)$/;

/** The catalog programs a listing belongs to: the one bachelor's major whose code ends in the
 * listing's program code, or, for a nested variant, the major it is listed under. A major the
 * index gives no code is linked only to the one major with exactly its name. */
export function planPrograms(listing: PlanListing, programs: CatalogProgram[]): { codes: string[]; variantOf: string | null; limitation?: string } {
  const owner = listing.parent ?? listing;
  const code = (owner.code ?? '').split('-')[0].trim().toUpperCase();
  const bachelors = programs.filter(program => program.programKind === 'major' && program.type === 'undergraduate' && typeof program.catalogCode === 'string');
  if (!code) {
    const named = bachelors.filter(program => (program.name ?? '').replace(DEGREE_SUFFIX, '').trim() === owner.name.trim());
    return named.length === 1
      ? { codes: [named[0].catalogCode!], variantOf: listing.parent?.name ?? null,
        limitation: `The index gives ${owner.name} no program code; it is linked to the one catalog major with exactly that name.` }
      : { codes: [], variantOf: listing.parent?.name ?? null, limitation: 'The index gives this plan no program code, so it is not linked to a catalog program.' };
  }
  const majors = bachelors.filter(program => program.catalogCode!.split('-').pop() === code);
  if (majors.length !== 1) {
    return { codes: [], variantOf: listing.parent?.name ?? null,
      limitation: `The index's program code ${code} matches ${majors.length} catalog majors, so the plan is not linked to one.` };
  }
  return { codes: [majors[0].catalogCode!], variantOf: listing.parent?.name ?? null };
}

const planId = (listing: PlanListing) => crypto.createHash('sha256').update(JSON.stringify([listing.cohort, listing.url])).digest('hex').slice(0, 32);
const nameKey = (value: string) => clean(value).toLowerCase().replace(/[‐-―]/g, '-');

/** A captured plan with its program links and any caveats about how it was reached. */
export function graduationPlan(listing: PlanListing & { groupedElsewhere?: boolean }, page: GraduationPlanPage, finalUrl: string, programs: CatalogProgram[]): GraduationPlan {
  const { codes, variantOf, limitation } = planPrograms(listing, programs);
  const limitations = limitation ? [limitation] : [];
  if (listing.groupedElsewhere && listing.parent) {
    limitations.push(`This section lists the plan without a major; the index lists the same plan under ${listing.parent.name} in another cohort.`);
  }
  // A redirect can land on a different page. A moved page keeps its slug; otherwise the page
  // must still name the listed plan.
  const slug = (url: string) => url.replace(/\/+$/, '').split('/').pop()!.toLowerCase();
  if (finalUrl !== listing.url && slug(finalUrl) !== slug(listing.url) && !nameKey(page.title).includes(nameKey(listing.name))) {
    limitations.push(`The listed link led to ${finalUrl}, titled "${page.title}", which does not name this plan.`);
  }
  return {
    id: planId(listing), name: listing.name, cohort: listing.cohort, listing: listing.listing, url: listing.url,
    finalUrl: finalUrl === listing.url ? null : finalUrl, programCodes: limitations.some(text => text.startsWith('The listed link')) ? [] : codes,
    variantOf, limitations, ...page,
  };
}

/** A plan's semesters, placement and general education lists as readable text. */
export function withPlanTexts(plan: GraduationPlan): GraduationPlan {
  const hours = (value: number | null) => (value === null ? '' : ` (${value} ${value === 1 ? 'credit' : 'credits'})`);
  const planText = plan.terms.map(term => [
    `${[term.year, term.term].filter(Boolean).join(', ')}${hours(term.totalHours)}`,
    ...term.items.map(item => `  ${item.category ? `${item.category}: ` : ''}${item.text}${hours(item.hours)}`),
  ].join('\n')).join('\n');
  const placementText = plan.placement.map(box => `${box.title}: ${box.sequences.join('; ')}`).join('\n');
  const generalEducationText = plan.generalEducation.map(category =>
    `${category.category}${category.waivedForTransfers ? ' (+W)' : ''}: ${category.text}`).join('\n');
  // Always written, null when the page has none, so a missing section reads as unpublished.
  return { ...plan, planText: planText || null, placementText: placementText || null, generalEducationText: generalEducationText || null };
}

export interface GraduationPlansArtifact {
  schema_version: 1;
  source_url: string;
  captured_at: string;
  plans: GraduationPlan[];
  unresolved: Array<{ name: string; cohort: string; url: string; reason: string }>;
  /** Plans the index lists whose page is gone; nothing of them is published. */
  unavailable: Array<{ name: string; cohort: string; url: string; status: number }>;
}

/** A page, or its status when the site says it is gone. Any other failure stops the capture,
 * so a temporary outage never quietly drops plans. */
async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | { gone: number }> {
  const response = await fetchWithPolicy(url, { headers: HEADERS }, { expectedContentTypes: ['text/html'], maxResponseBytes: 8 * 1024 * 1024 });
  if (response.status === 404 || response.status === 410) return { gone: response.status };
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return { html: response.text(), finalUrl: response.url || url };
}

async function main() {
  const capturedAt = new Date().toISOString();
  const programs = (JSON.parse(fs.readFileSync(PROGRAMS_JSON, 'utf8')) as { schools: Array<{ majors: CatalogProgram[] }> })
    .schools.flatMap(school => school.majors);
  const index = await fetchPage(PLAN_INDEX_URL);
  if ('gone' in index) throw new Error(`The graduation plan index returned ${index.gone}.`);
  const listings = withSiteGrouping(planListings(index.html));
  const plans: GraduationPlan[] = [];
  const unavailable: GraduationPlansArtifact['unavailable'] = [];
  const pages: Array<{ url: string; finalUrl: string; sha256: string; bytes: number }> = [];
  for (const listing of listings) {
    const page = await fetchPage(listing.url);
    if ('gone' in page) {
      unavailable.push({ name: listing.name, cohort: listing.cohort, url: listing.url, status: page.gone });
      continue;
    }
    pages.push({ url: listing.url, finalUrl: page.finalUrl, sha256: crypto.createHash('sha256').update(page.html).digest('hex'), bytes: page.html.length });
    plans.push(withPlanTexts(graduationPlan(listing, parseGraduationPlan(page.html, page.finalUrl), page.finalUrl, programs)));
    await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
  }
  const artifact: GraduationPlansArtifact = {
    schema_version: 1, source_url: PLAN_INDEX_URL, captured_at: capturedAt, plans,
    unresolved: plans.filter(plan => !plan.programCodes.length).map(plan => ({ name: plan.name, cohort: plan.cohort, url: plan.url, reason: plan.limitations.join(' ') })),
    unavailable,
  };
  writeJsonFile(RAW_OUT, { capturedAt, index: { url: PLAN_INDEX_URL, finalUrl: index.finalUrl }, listings, pages, unavailable });
  writeRawFileProvenance('graduation-plans', RAW_OUT, { sourceUrl: PLAN_INDEX_URL, recordCount: plans.length, fetchedAt: capturedAt });
  writeJsonFile(OUT, artifact);
  const linked = plans.filter(plan => plan.programCodes.length).length;
  console.log(`Wrote ${plans.length} graduation plans; ${linked} linked to a catalog program, ${plans.length - linked} not linked, ${unavailable.length} listed pages gone.`);
}

if (process.argv[1]?.endsWith('graduation-plans.ts')) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
