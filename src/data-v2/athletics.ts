import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { CampusIdentity, CampusIdentityRelationship, IdentityEvidence } from './campus-identities';
import { campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';

/**
 * @module data-v2/athletics
 * Ramapo's varsity teams as `team` nodes, from the college's athletics site (ramapoathletics.com).
 *
 * The site's robots.txt lets any robot read the team pages with 30 seconds between requests, so
 * the collectors (ingestion/athletics.ts) read only two pages per team: its schedule, every day
 * (games, places, scores and season record), and its coaches page, every week (names, titles,
 * email and phone). Player rosters are never read: they list students' hometowns and schools.
 *
 * The collectors keep each page's HTML; this module reads it at publish time, so a better reader
 * re-reads the pages already captured without downloading anything again. A team is `listed_by`
 * the Athletics office and `held_at` each campus building its home games are played in. Its
 * `teams` record holds its season, record, coaches and games, each read from its own page.
 */

type Row = Record<string, unknown>;
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
export const ATHLETICS_SCHEDULES_SOURCE = 'athletics-schedules';
export const ATHLETICS_COACHES_SOURCE = 'athletics-coaches';
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** The reviewed list of teams (src/reference/athletics-teams.json). */
export interface ReviewedAthletics {
  site: string;
  office: string;
  teams: Array<{ slug: string; name: string }>;
  /** Home venues as the schedules print them, to the campus map building they are. */
  venues: Record<string, string>;
}

/** One page a collector saved: its HTML (scripts and styles removed) and when it was read. */
export interface AthleticsPage { team: string; url: string; status: number; fetchedAt: string; contentHash?: string; html?: string }
export interface AthleticsCapture { schemaVersion: 1; dataset: string; generatedAt: string; site: string; pages: AthleticsPage[] }

export interface AthleticsGame {
  /** ISO date of the game's first day; empty when the page's date could not be read. */
  date: string;
  /** The date as the page prints it ("Nov 7 (Sat)"). */
  date_label: string;
  /** "1:00 PM", "TBD", or empty. */
  time: string;
  site: 'home' | 'away' | 'neutral' | '';
  opponent: string;
  location: string;
  venue: string;
  /** "W", "L" or "T" when the page prints one. */
  outcome: string;
  /** The result as printed ("W, 5-0", "3rd of 8"); empty for a game not played yet. */
  result: string;
  /** A tournament or event the game is part of ("NJAC Quarterfinal"). */
  note: string;
  conference: boolean;
}
export interface AthleticsCoach { name: string; title: string; email: string; phone: string }
export interface ParsedSchedule { title: string; season: string; record: Record<string, string>; games: AthleticsGame[] }

export const teamId = (slug: string): string => uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'team', ATHLETICS_SCHEDULES_SOURCE, slug]));

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** The year a game in this month falls in: a "2026-2027" season's fall is 2026 and its spring 2027. */
export function gameDate(label: string, season: string): string {
  const day = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(label);
  const years = (season.match(/\d{4}/g) ?? []).map(Number);
  // "2026-27" names its second year by two digits.
  const short = /^(\d{4})\s*[-–]\s*(\d{2})$/.exec(season.trim());
  if (short) years.splice(0, years.length, Number(short[1]), Number(short[1].slice(0, 2) + short[2]));
  if (!day || !years.length) return '';
  const month = MONTHS[day[1].slice(0, 3).toLowerCase()];
  const year = years.length > 1 && month < 7 ? years[1] : years[0];
  return `${year}-${String(month).padStart(2, '0')}-${String(Number(day[2])).padStart(2, '0')}`;
}

const TIME = /\b(\d{1,2}(?::\d{2})?\s*[AaPp]\.?\s*[Mm]\.?|TBD|TBA|Noon|All Day)\b/;

/** The season a page names in its title: "2026-2027 Women's Basketball Schedule" is "2026-2027". */
function seasonOf(title: string): string {
  return /\b(\d{4}(?:\s*[-–]\s*\d{2,4})?)\b/.exec(title)?.[1].replace(/\s+/g, '') ?? '';
}

function ownText(_$: cheerio.CheerioAPI, node: { text(): string }): string {
  return text(node.text());
}

const RECORD_LABEL = /^(Overall|Conf\.?|Conference|Home|Away|Neutral|Streak):?$/i;
const RECORD_VALUE = /^\d+-\d+(?:-\d+)?$/;
const STREAK_VALUE = /^[WLT]\d+$/i;

/**
 * The season record a schedule page shows above its games: each label the site writes (Overall,
 * Conf, Home, Away, Neutral, Streak) with the value right after it, by the page's own text in
 * order, so it does not depend on the markup around them. Read from the page's record parts
 * (any element whose class names a record) first, the whole page when those give none. A label
 * whose next text is not a win-loss(-tie) count (a streak: W3, L1) is not read, so a percentage
 * line or a menu item named "Home" is skipped.
 */
function seasonRecord($: cheerio.CheerioAPI): Record<string, string> {
  const read = (scope: cheerio.Cheerio<AnyNode>) => {
    const leaves = scope.find('*').addBack().toArray()
      .filter(node => node.type === 'tag' && !$(node).children().length)
      .map(node => text($(node).text())).filter(Boolean);
    const record: Record<string, string> = {};
    leaves.forEach((leaf, index) => {
      const label = RECORD_LABEL.exec(leaf)?.[1].replace(/\.$/, '');
      const value = leaves[index + 1] ?? '';
      if (!label || label in record) return;
      if (/^streak$/i.test(label) ? STREAK_VALUE.test(value) : RECORD_VALUE.test(value)) record[label] = value;
    });
    return record;
  };
  const parts = $('[class*="record"]').filter((_, node) => !$(node).parents('[class*="record"]').length);
  const fromParts = read(parts);
  return Object.keys(fromParts).length ? fromParts : read($('body'));
}

/**
 * A game's start time when its date line does not hold it: from the entry's own time part (an
 * element whose class names a time), else from the entry's text without its opponent, place,
 * result and note, so an opponent "TBA" is not read as the time.
 */
function gameTime($: cheerio.CheerioAPI, entry: cheerio.Cheerio<AnyNode>): string {
  const own = entry.find('[class*="time"]').toArray().map(node => TIME.exec(text($(node).text()))?.[1]).find(Boolean);
  if (own) return own;
  const rest = entry.clone();
  rest.find('[class*="opponent-name"], [class*="opponent-text"], [class*="location"], [class*="result"], [class*="tournament"], [class*="promotion"]').remove();
  return TIME.exec(text(rest.text()))?.[1] ?? '';
}

/**
 * A team's schedule page (Sidearm's list view): one entry per game. Each game's date, time,
 * home/away, opponent, place and result are read from the entry's own parts. The page repeats the
 * games as cards; a game read twice is kept once.
 */
export function parseSchedule(html: string): ParsedSchedule {
  const $ = cheerio.load(html);
  const title = text($('title').first().text()).replace(/\s+-\s+Ramapo College.*$/i, '');
  const season = seasonOf(title);
  const record = seasonRecord($);
  const games: AthleticsGame[] = [];
  const seen = new Set<string>();
  $('li.sidearm-schedule-game').each((_, item) => {
    const entry = $(item);
    const classes = (entry.attr('class') ?? '').split(/\s+/);
    const dateText = ownText($, entry.find('.sidearm-schedule-game-opponent-date').first());
    const opponent = ownText($, entry.find('.sidearm-schedule-game-opponent-name').first()).replace(/^\*\s*/, '');
    if (!opponent) return;
    const locationNode = entry.find('.sidearm-schedule-game-location').first().clone();
    const atVs = ownText($, locationNode.find('.sidearm-schedule-game-at-vs, .sidearm-schedule-game-conference-vs').first()).toLowerCase();
    locationNode.find('.sidearm-schedule-game-at-vs, .sidearm-schedule-game-conference-vs').remove();
    const placeParts = locationNode.find('span').toArray().map(span => ownText($, $(span))).filter(Boolean);
    const location = placeParts[0] ?? ownText($, locationNode);
    const venue = placeParts.slice(1).join(' ');
    const resultText = ownText($, entry.find('.sidearm-schedule-game-result').first()).replace(/\s*,\s*/, ', ');
    const outcome = /^([WLT])\b/.exec(resultText)?.[1] ?? '';
    const note = ownText($, entry.find('[class*="tournament"], [class*="promotion"]').first());
    const site = classes.some(c => /home/.test(c)) ? 'home' : classes.some(c => /neutral/.test(c)) ? 'neutral'
      : classes.some(c => /away/.test(c)) ? 'away' : atVs === 'at' ? 'away' : atVs === 'vs' || atVs === 'vs.' ? 'home' : '';
    const dateLabel = dateText.replace(TIME, '').replace(/\s+/g, ' ').trim();
    const time = TIME.exec(dateText)?.[1] ?? gameTime($, entry);
    const game: AthleticsGame = {
      date: gameDate(dateLabel, season), date_label: dateLabel, time: time.replace(/\s+/g, ' '),
      site, opponent, location, venue, outcome, result: resultText, note,
      conference: classes.some(c => /conference/.test(c)),
    };
    const key = `${game.date_label}|${game.opponent}|${game.time}`;
    if (seen.has(key)) return;
    seen.add(key);
    games.push(game);
  });
  return { title, season, record, games };
}

/** A team's coaches page: its staff table (name, title, email, phone), one row per coach. */
export function parseCoaches(html: string): AthleticsCoach[] {
  const $ = cheerio.load(html);
  const coaches: AthleticsCoach[] = [];
  const seen = new Set<string>();
  $('table').each((_, table) => {
    const headers = $(table).find('thead th, thead td').toArray().map(cell => ownText($, $(cell)).toLowerCase());
    if (!headers.some(h => h.includes('name')) || !headers.some(h => h.includes('title'))) return;
    $(table).find('tbody tr').each((_, row) => {
      const cells = $(row).find('th, td').toArray().map(cell => $(cell));
      const at = (label: string) => { const i = headers.findIndex(h => h.includes(label)); return i >= 0 ? cells[i] : undefined; };
      const name = text(at('name')?.text());
      if (!name || seen.has(name)) return;
      const email = $(row).find('a[href^="mailto:"]').first().attr('href')?.replace(/^mailto:/i, '').trim() ?? '';
      const phone = $(row).find('a[href^="tel:"]').first().text().trim()
        || (/\(?\d{3}\)?[-. ]?\d{3}-\d{4}/.exec(text(at('phone')?.text()))?.[0] ?? '');
      seen.add(name);
      coaches.push({ name, title: text(at('title')?.text()), email: text(email), phone: text(phone) });
    });
  });
  return coaches;
}

/**
 * The team nodes and their `teams` records. A team with no schedule page captured is left out
 * and reported; a page whose games could not be read is reported too, so a site change shows up
 * in the coverage report instead of as a quietly empty schedule.
 */
export function compileAthleticsTeams(entities: CampusIdentity[], schedules: AthleticsCapture | undefined,
  coaches: AthleticsCapture | undefined, reviewed: ReviewedAthletics, artifact: CampusBuildingsArtifact):
  { entities: CampusIdentity[]; records: GraphRecordCollectionData; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const nodes: CampusIdentity[] = [];
  const rows: GraphRecordRow[] = [];
  const office = entities.filter(e => e.kind === 'office' && e.name === reviewed.office);
  const buildings = new Map(artifact.buildings.map(b => [b.map_key, campusBuildingId(b)] as [string, string]));
  const pageOf = (capture: AthleticsCapture | undefined, slug: string) =>
    capture?.pages.find(page => page.team === slug && page.status === 200 && page.html);
  for (const team of reviewed.teams) {
    const schedulePage = pageOf(schedules, team.slug);
    if (!schedulePage) {
      if (schedules) unresolved.push({ entity: team.name, collection: 'teams', record: team.slug, reason: 'The team\'s schedule page was not captured; the team is left out.', kind: 'no_records' });
      continue;
    }
    const schedule = parseSchedule(schedulePage.html!);
    if (!schedule.games.length) {
      unresolved.push({ entity: team.name, collection: 'teams', record: schedulePage.url, reason: 'No game could be read from the team\'s schedule page.', kind: 'note' });
    }
    const coachPage = pageOf(coaches, team.slug);
    const staff = coachPage ? parseCoaches(coachPage.html!) : [];
    if (coaches && !staff.length) {
      unresolved.push({ entity: team.name, collection: 'teams', record: coachPage?.url ?? team.slug,
        reason: coachPage ? 'No coach could be read from the team\'s coaches page.' : 'The team\'s coaches page was not captured.', kind: 'note' });
    }
    const id = teamId(team.slug);
    const evidence = (field: string, url: string): IdentityEvidence =>
      ({ collection: 'teams', source_key: ATHLETICS_SCHEDULES_SOURCE, source_record_key: team.slug, field, source_url: url });
    const relationships: CampusIdentityRelationship[] = [];
    if (office.length === 1) relationships.push({ type: 'listed_by', target_entity_id: office[0].id, evidence: [evidence('schedule_url', schedulePage.url)] });
    else unresolved.push({ entity: team.name, collection: 'contacts', record: reviewed.office, reason: 'The office that runs the teams is not one office in the registry.', kind: 'missing_connection' });
    for (const venue of [...new Set(schedule.games.filter(game => game.site === 'home' && game.venue).map(game => game.venue))].sort()) {
      const building = buildings.get(reviewed.venues[venue] ?? '');
      if (!building) {
        unresolved.push({ entity: team.name, collection: 'buildings', record: venue, reason: 'This home venue is not matched to a campus map building (athletics-teams.json venues).', kind: 'missing_connection' });
        continue;
      }
      if (!relationships.some(r => r.type === 'held_at' && 'target_entity_id' in r && r.target_entity_id === building)) {
        relationships.push({ type: 'held_at', target_entity_id: building, evidence: [evidence('games', schedulePage.url)] });
      }
    }
    const node: CampusIdentity = { id, kind: 'team', name: team.name, aliases: [],
      links: [{ collection: 'teams', source_key: ATHLETICS_SCHEDULES_SOURCE, source_record_keys: [team.slug] }],
      ...relationships.length ? { relationships } : {} };
    nodes.push(node);
    rows.push({
      source_record_key: team.slug, name: team.name, season: schedule.season, schedule_title: schedule.title,
      record: schedule.record, games: schedule.games, coaches: staff,
      source_url: schedulePage.url, schedule_collected_at: schedulePage.fetchedAt,
      ...coachPage ? { coaches_url: coachPage.url, coaches_collected_at: coachPage.fetchedAt } : {},
    });
  }
  const collectedAt = schedules?.pages.map(page => page.fetchedAt).filter(Boolean).sort().pop() ?? '';
  return { entities: nodes, records: { source_key: ATHLETICS_SCHEDULES_SOURCE, collected_at: collectedAt, rows }, unresolved };
}

/** A collector's capture, when its file holds one. */
export function athleticsCapture(value: unknown): AthleticsCapture | undefined {
  const row = value as Row | undefined;
  return row && typeof row === 'object' && Array.isArray(row.pages) ? row as unknown as AthleticsCapture : undefined;
}
