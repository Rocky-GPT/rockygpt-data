import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import { fetchWithPolicy } from './http-client';
import {
    isRawOnlyMode,
    runGeneratorScript,
    writeJsonFile,
    writeRawProvenance,
} from './pipeline-utils';
import { validateCampusHours, type LocationHours } from './schema';
import { publicPath } from '../src/paths';
import { partitionHoursForPublication, readValidityFromNotes } from '../src/data-v2/validity';
import { withheldHoursRecord } from './unverified-hours';

const RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'hours.raw.json');
const PUBLIC_JSON_PATH = publicPath('data', 'hours.json');
const RAG_JSON_PATH = path.join(process.cwd(), 'data', 'normalized', 'hours.json');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-hours-md.ts');
export const ATHLETICS_HOURS_URL = 'https://ramapoathletics.com/sports/2008/1/21/bradleycenterhours.aspx';

export const LIBRARY_HOURS_URL = 'https://www.ramapo.edu/library/library-hours/';
export const GENERAL_CAMPUS_HOURS_URL = 'https://www.ramapo.edu/about/campus-hours/';
const SOURCE_CAPTURE_PATH = path.join(process.cwd(), 'data', 'raw', 'hours-sources.raw.json');
const OMISSIONS_PATH = path.join(process.cwd(), 'data', 'normalized', 'hours-omissions.json');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
type DayName = (typeof DAYS)[number];

function createUnknownWeek(): Record<string, string> {
    return DAYS.reduce<Record<string, string>>((acc, day) => {
        acc[day] = 'Hours unavailable';
        return acc;
    }, {});
}

function assignDays(hours: Record<string, string>, days: DayName[], schedule: string): void {
    days.forEach((day) => {
        hours[day] = schedule;
    });
}

function normalizePageText(raw: string): string {
    return raw
        .replace(/\u00a0/g, ' ')
        .replace(/[–—]/g, '-')
        .replace(/[“”]/g, '"')
        .replace(/[’]/g, "'")
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

function toCanonicalTime(raw: string): string {
    const cleaned = raw.trim().replace(/\./g, '');
    if (/^noon$/i.test(cleaned)) {
        return '12:00pm';
    }

    const match = cleaned.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
    if (!match) {
        throw new Error(`Unable to parse time token: "${raw}"`);
    }

    const hour = String(Number(match[1]));
    const minute = match[2];
    const meridiem = match[3].toLowerCase();
    return `${hour}:${minute}${meridiem}`;
}

function scheduleFromLine(line: string): string {
    const matches = Array.from(
        line.matchAll(/(Noon|\d{1,2}:\d{2}\s*[AaPp][Mm])\s*(?:-|to)\s*(Noon|\d{1,2}:\d{2}\s*[AaPp][Mm])/gi)
    );

    if (matches.length === 0) {
        throw new Error(`No hour ranges found in line: "${line}"`);
    }

    return matches
        .map((match) => `${toCanonicalTime(match[1] || '')}-${toCanonicalTime(match[2] || '')}`)
        .join(' and ');
}

function indexOfInsensitive(text: string, pattern: string, fromIndex = 0): number {
    // A reference in a page-wide warning is not the facility's own heading.
    const lines = text.split('\n');
    let offset = 0;
    for (const line of lines) {
        if (offset >= fromIndex && line.toLowerCase().startsWith(pattern.toLowerCase())) return offset;
        offset += line.length + 1;
    }
    return -1;
}

function sectionBetween(text: string, startHeading: string, endHeading?: string): string {
    const startIndex = indexOfInsensitive(text, startHeading);
    if (startIndex === -1) {
        throw new Error(`Could not find heading "${startHeading}" in hours page`);
    }

    const contentStart = startIndex + startHeading.length;
    let contentEnd = text.length;
    if (endHeading) {
        const endIndex = indexOfInsensitive(text, endHeading, contentStart);
        if (endIndex !== -1) {
            contentEnd = endIndex;
        }
    }

    return text.slice(contentStart, contentEnd).trim();
}

function findLine(section: string, matcher: RegExp, contextLabel: string): string {
    const line = section.split('\n').find((candidate) => matcher.test(candidate));
    if (!line) {
        throw new Error(`Could not find expected line for ${contextLabel}`);
    }
    return line;
}

export function parseAthleticsFacilityHours(pageText: string): LocationHours[] {
    const normalized = normalizePageText(pageText);

    const bradleySection = sectionBetween(
        normalized,
        'Bradley Center, Student Lounge, and Recreation Lounge',
        'Sharp Fitness Center'
    );
    const sharpSection = sectionBetween(normalized, 'Sharp Fitness Center', 'Adele and Reuben Thomas');
    const poolSection = sectionBetween(normalized, 'Adele and Reuben Thomas', 'Auxiliary Gym');
    const auxiliarySection = sectionBetween(normalized, 'Auxiliary Gym', 'Rock Climbing Wall');
    const rockSection = sectionBetween(normalized, 'Rock Climbing Wall', 'Lodge Fitness Center');
    const lodgeSection = sectionBetween(normalized, 'Lodge Fitness Center', 'To rent our facility');

    const bradleyHours = createUnknownWeek();
    assignDays(
        bradleyHours,
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        scheduleFromLine(findLine(bradleySection, /Monday\s*-\s*Friday/i, 'Bradley Center weekdays'))
    );
    assignDays(
        bradleyHours,
        ['Saturday'],
        scheduleFromLine(findLine(bradleySection, /Saturday/i, 'Bradley Center Saturday'))
    );
    assignDays(
        bradleyHours,
        ['Sunday'],
        scheduleFromLine(findLine(bradleySection, /Sunday/i, 'Bradley Center Sunday'))
    );

    const sharpHours = createUnknownWeek();
    assignDays(
        sharpHours,
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        scheduleFromLine(findLine(sharpSection, /Mondays?\s*-\s*Fridays?/i, 'Sharp Fitness weekdays'))
    );
    assignDays(
        sharpHours,
        ['Saturday'],
        scheduleFromLine(findLine(sharpSection, /Saturdays?/i, 'Sharp Fitness Saturday'))
    );
    assignDays(
        sharpHours,
        ['Sunday'],
        scheduleFromLine(findLine(sharpSection, /Sundays?/i, 'Sharp Fitness Sunday'))
    );

    const poolHours = createUnknownWeek();
    assignDays(
        poolHours,
        ['Monday'],
        scheduleFromLine(findLine(poolSection, /Monday/i, 'Pool Monday'))
    );
    assignDays(
        poolHours,
        ['Tuesday', 'Wednesday'],
        scheduleFromLine(findLine(poolSection, /Tuesday\s*(?:&|and)\s*Wednesday/i, 'Pool Tuesday/Wednesday'))
    );
    assignDays(
        poolHours,
        ['Thursday'],
        scheduleFromLine(findLine(poolSection, /Thursday/i, 'Pool Thursday'))
    );
    assignDays(
        poolHours,
        ['Friday'],
        scheduleFromLine(findLine(poolSection, /Friday/i, 'Pool Friday'))
    );
    assignDays(
        poolHours,
        ['Saturday'],
        scheduleFromLine(findLine(poolSection, /Saturday/i, 'Pool Saturday'))
    );
    assignDays(
        poolHours,
        ['Sunday'],
        scheduleFromLine(findLine(poolSection, /Sunday/i, 'Pool Sunday'))
    );

    const auxiliaryHours = createUnknownWeek();
    assignDays(
        auxiliaryHours,
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        scheduleFromLine(findLine(auxiliarySection, /Monday\s*-\s*Friday/i, 'Auxiliary Gym weekdays'))
    );
    assignDays(
        auxiliaryHours,
        ['Sunday'],
        scheduleFromLine(findLine(auxiliarySection, /Sunday/i, 'Auxiliary Gym Sunday'))
    );

    const rockHours = createUnknownWeek();
    assignDays(
        rockHours,
        ['Monday', 'Wednesday'],
        scheduleFromLine(findLine(rockSection, /Monday\s*(?:&|and)\s*Wednesday/i, 'Rock Climbing Wall'))
    );

    const lodgeHours = createUnknownWeek();
    const lodgeClosure = lodgeSection.split('\n').find((line) => /^closed until further notice$/i.test(line));
    if (lodgeClosure) assignDays(lodgeHours, [...DAYS], 'CLOSED');
    else assignDays(lodgeHours, ['Monday', 'Wednesday', 'Friday'],
        scheduleFromLine(findLine(lodgeSection, /Monday,\s*Wednesday,\s*Friday/i, 'Lodge Fitness Center')));
    const term = normalized.split('\n').find((line) => /^20\d{2} (Fall|Spring|Summer|Winter) Semester Hours$/i.test(line));
    if (!term) throw new Error('Athletics hours applicability heading is unavailable');
    const poolDates = poolSection.split('\n').find((line) => /20\d{2}/.test(line) && /\d.*-.*\d/.test(line));
    const poolNote = poolDates?.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1');
    const poolCondition = poolSection.split('\n').find((line) => /^Saturday/i.test(line))?.split('|')[1]?.trim();
    const auxiliaryCondition = auxiliarySection.split('\n').find((line) => /times may change/i.test(line));

    return [
        {
            name: "Bradley Center (Student & Recreation Lounge)",
            hours: bradleyHours, notes: term
        },
        {
            name: "Sharp Fitness Center (Weight Room)",
            hours: sharpHours, notes: term
        },
        {
            name: "Swimming Pool",
            hours: poolHours,
            notes: `${term}; ${poolNote || "dates unavailable"}${poolCondition ? `. Saturday: ${poolCondition}` : ''}`
        },
        {
            name: "Auxiliary Gym",
            hours: auxiliaryHours,
            notes: `${term}${auxiliaryCondition ? `; ${auxiliaryCondition}` : ''}`
        },
        {
            name: "Rock Climbing Wall",
            hours: rockHours, notes: term
        },
        {
            name: "Lodge Fitness Center (College Park Apartments)",
            hours: lodgeHours, notes: lodgeClosure || term
        }
    ];
}

export function hoursPageText(html: string): string {
    const $ = load(html);
    $('script,style,noscript').remove();
    $('br').replaceWith('\n');
    $('p,li,h1,h2,h3,h4,tr,div').append('\n');
    return normalizePageText($('body').text());
}

/** A library day line such as "Mon-Thu: 9:00am - 9:00pm", or null for any other line. */
function dayLine(line: string): { days: DayName[]; schedule: string } | null {
    const match = line.match(/^(Mon-Thu|Mon-Fri|Fri|Sat & Sun|Sat|Sun):\s*(.*)$/i);
    if (!match) return null;
    const days: DayName[] = /^Mon-Thu$/i.test(match[1]) ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday']
        : /^Mon-Fri$/i.test(match[1]) ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
        : /^Fri$/i.test(match[1]) ? ['Friday'] : /^Sat & Sun$/i.test(match[1]) ? ['Saturday', 'Sunday']
        : /^Sat$/i.test(match[1]) ? ['Saturday'] : ['Sunday'];
    return { days, schedule: /^CLOSED$/i.test(match[2]) ? 'CLOSED' : scheduleFromLine(match[2]) };
}

function parsedWeek(section: string): Record<string, string> {
    const hours = createUnknownWeek();
    for (const line of section.split('\n')) {
        const parsed = dayLine(line);
        if (parsed) assignDays(hours, parsed.days, parsed.schedule);
    }
    if (Object.values(hours).some((value) => value === 'Hours unavailable')) {
        throw new Error('Library weekly schedule has missing or unrecognized days');
    }
    return hours;
}

/** The days a repeated schedule lists, from its first day line to the next other line. */
function listedDays(lines: string[]): Record<string, string> {
    const listed: Record<string, string> = {};
    for (const line of lines) {
        const parsed = dayLine(line);
        if (!parsed) {
            if (Object.keys(listed).length) break;
            continue;
        }
        assignDays(listed, parsed.days, parsed.schedule);
    }
    return listed;
}

export function parseLibraryHours(pageText: string): LocationHours[] {
    const text = normalizePageText(pageText);
    const circulation = sectionBetween(text, 'CIRCULATION DESK HOURS', 'RESEARCH HELP HOURS');
    const research = sectionBetween(text, 'RESEARCH HELP HOURS', 'GAME LAB HOURS');
    const game = sectionBetween(text, 'GAME LAB HOURS', 'If we are offline');
    const parse = (name: string, section: string): LocationHours => {
        const lines = section.split('\n');
        const term = lines.find((line) => /^(Fall|Spring|Summer|Winter) Semester$/i.test(line));
        const dates = lines.find((line) => /20\d{2}/.test(line) && /\d.*-.*\d/.test(line));
        if (!term || !dates || !readValidityFromNotes(`${term} ${dates}`).window) {
            throw new Error(`Library source has no explicit applicability dates for ${name}`);
        }
        // Exceptions require dated records, never a silent weekly fallback.
        if (/Special Hours/i.test(section)) throw new Error(`Library source has unparsed special hours for ${name}`);
        return { name, hours: parsedWeek(section), notes: `${term} ${dates}` };
    };
    const library = parse('Library (Main Building)', circulation);
    const closingNote = text.split('\n').find((line) => /^Please note that the front doors/i.test(line));
    if (closingNote) library.notes += `. ${closingNote}`;
    const lab = parse('Game Lab', game);
    const priority = game.split('\n').find((line) => /^Please Note:/i.test(line));
    if (priority) lab.notes += `. ${priority}`;
    const help = parse('Research Help Desk', research);
    // Repeated sidebar schedules can disagree with main content on the year.
    const researchSections = [...text.matchAll(/^RESEARCH HELP HOURS$/gim)];
    const repeats = researchSections.map((match) => {
        const tail = text.slice(match.index! + match[0].length).split('\n').slice(1, 9);
        return { window: readValidityFromNotes(tail.slice(0, 3).join(' ')).window, listed: listedDays(tail) };
    });
    if (new Set(repeats.map((repeat) => JSON.stringify(repeat.window))).size > 1) {
        // In September 2026 the sidebar kept "Fall 2025" above the same hours the main
        // content lists for Fall 2026. Only a stale year label differs, so publish the main
        // schedule when it carries the latest term and every repeated day agrees with it.
        const latest = repeats.every((repeat) => (repeat.window?.validUntil ?? '')
            <= (repeats[0].window?.validUntil ?? ''));
        const sameHours = repeats.every((repeat) => Object.entries(repeat.listed)
            .every(([day, schedule]) => help.hours[day] === schedule));
        if (latest && sameHours) {
            help.notes += '. A repeated schedule on the page gives the same hours under an older year.';
        } else {
            help.availabilityIssue = 'conflicting-source-validity';
            help.notes += '. Source repeats research-help hours with conflicting applicability dates; withheld.';
        }
    }
    return [library, help, lab];
}

/** The parent page verifies these facilities but does not establish which
 * seasonal schedules currently apply. Preserve its facts without selecting a
 * season, extending an old update date, or interpreting assistance as closure. */
export function parseGeneralCampusHours(pageText: string): LocationHours[] {
    const text = normalizePageText(pageText);
    const offices = sectionBetween(text, 'Normal Office Hours:', 'Clarification of Terms');
    // The global navigation also says "Bookstore"; start at this page's
    // distinctive first content heading before selecting facility sections.
    const content = sectionBetween(text, 'Normal Office Hours:');
    const fallSpring = findLine(offices, /^Fall\s*\/\s*Spring Hours:/i, 'office Fall/Spring hours');
    const summer = findLine(offices, /^Summer Hours:/i, 'office Summer hours');
    const csi = sectionBetween(content, 'Center for Student Involvement (CSI)', 'ROADRUNNER CENTRAL');
    const csiHours = findLine(csi, /^The CSI main office is open/i, 'CSI hours');
    const csiUpdate = findLine(csi, /^\*?Updated as of/i, 'CSI source update');
    const jLee = sectionBetween(content, "J. LEE'S", "Women's Center");
    const assistance = findLine(jLee, /^Please visit the Center for Student Involvement for assistance\.?$/i,
        "J. Lee's assistance notice");
    const bookstore = sectionBetween(content, 'Bookstore', 'Bookstore FAQ:');
    if (!/Summer Store Hours:/i.test(bookstore) || !/Normal Store Hours:/i.test(bookstore)) {
        throw new Error('Bookstore source seasonal schedules are unavailable');
    }
    return [
        { name: 'Administrative Offices (Normal Hours)', hours: createUnknownWeek(),
            availabilityIssue: 'ambiguous-source-season',
            notes: `${fallSpring}\n${summer}\nThe source gives no dates selecting the applicable season.` },
        { name: 'Center for Student Involvement (CSI)', hours: createUnknownWeek(),
            availabilityIssue: 'source-update-only',
            notes: `${csiHours}\n${csiUpdate}\nThis is a source update date, not a current schedule validity period.` },
        { name: "J. Lee's (Student Lounge & Game Room)", hours: createUnknownWeek(),
            availabilityIssue: 'missing-schedule',
            notes: `${assistance}\nThe source does not publish a schedule or a closure for J. Lee's.` },
        { name: 'Ramapo Bookstore', hours: createUnknownWeek(),
            availabilityIssue: 'ambiguous-source-season',
            notes: `${bookstore}\nThe source lists Summer and Normal schedules without a complete applicability period.` },
    ];
}

export interface HoursSourceCapture {
    sourceUrl: string;
    collectedAt: string;
    html: string;
}

async function fetchHoursSource(sourceUrl: string): Promise<HoursSourceCapture> {
    const response = await fetchWithPolicy(sourceUrl,
        { headers: { Accept: 'text/html,application/xhtml+xml' } },
        { expectedContentTypes: ['text/html', 'application/xhtml+xml'] });
    if (!response.ok) throw new Error(`Hours source returned HTTP ${response.status}: ${sourceUrl}`);
    return { sourceUrl, collectedAt: new Date().toISOString(), html: response.text() };
}

/**
 * Offices whose own page publishes a regular (Fall/Spring) schedule beside a
 * separate summer one. Each name is the office's campus identity, and the label
 * is the line that starts its regular schedule on that page (read 2026-09-28).
 * Summer schedules stay out: no page dates them.
 */
export const OFFICE_HOURS_PAGES: ReadonlyArray<{ name: string; url: string; label: RegExp }> = [
    { name: 'Registrar', url: 'https://www.ramapo.edu/registrar/', label: /^Fall\s*\/\s*Spring Hours:/i },
    { name: 'Student Accounts', url: 'https://www.ramapo.edu/student-accounts/', label: /^Academic Year:/i },
    { name: 'Financial Aid', url: 'https://www.ramapo.edu/finaid/', label: /^Academic Year:/i },
    { name: 'Cahill Career Development Center', url: 'https://www.ramapo.edu/careercenter/', label: /^Office Hours:/i },
    { name: 'Dean of Students', url: 'https://www.ramapo.edu/student-affairs/', label: /^Regular Office Hours:/i },
    { name: 'Educational Opportunity Fund (EOF) Program', url: 'https://www.ramapo.edu/eof-program/',
        label: /^Academic Year Hours:/i },
    { name: 'Office of Student Conduct', url: 'https://www.ramapo.edu/student-conduct/',
        label: /^Fall and Spring Semester Hours:/i },
];

/** A Fall or Spring semester, from its first class day to its last class or final exam. */
export interface TermWindow { name: string; from: string; until: string }

const CALENDAR_PATH = path.join(process.cwd(), 'data', 'normalized', 'calendar.json');

/** Fall and Spring windows from the published academic calendar. */
export function termWindows(calendar: unknown): TermWindow[] {
    if (!Array.isArray(calendar)) throw new Error('Academic calendar is unavailable for office hours');
    const day = (event: { startsAt?: unknown }) => String(event.startsAt ?? '').slice(0, 10);
    return calendar.flatMap((term: { name?: unknown; events?: Array<{ kind?: unknown; startsAt?: unknown }> }) => {
        const name = String(term.name ?? '');
        if (!/^(Fall|Spring) 20\d{2}$/.test(name) || !Array.isArray(term.events)) return [];
        const begins = term.events.filter((event) => event.kind === 'classes_begin').map(day).filter(Boolean).sort();
        const ends = term.events.filter((event) => event.kind === 'classes_end' || event.kind === 'finals')
            .map(day).filter(Boolean).sort();
        return begins.length && ends.length ? [{ name, from: begins[0], until: ends[ends.length - 1] }] : [];
    });
}

function readTermWindows(): TermWindow[] {
    return termWindows(JSON.parse(fs.readFileSync(CALENDAR_PATH, 'utf8')) as unknown);
}

const MONTH_ABBREVIATIONS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
const shortDate = (iso: string) => `${MONTH_ABBREVIATIONS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * An office's regular schedule, dated by the semester the capture falls in (or
 * the next one): "Fall/Spring Hours" name no dates, and the academic calendar
 * does. Between semesters no schedule applies, so none is stated.
 */
export function parseOfficeHours(name: string, label: RegExp, pageText: string, collectedAt: string,
    terms: TermWindow[]): LocationHours {
    const lines = pageText.split('\n').map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) throw new Error(`Office hours line is unavailable for ${name}`);
    const range = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i;
    // The schedule follows its label on the same line, or on the next line (Registrar).
    const rest = lines[index].replace(label, '').trim();
    const text = range.test(rest) ? rest : `${rest} ${lines[index + 1] ?? ''}`.trim();
    const days = text.match(/\b(Monday|Mon\.?)\s*(?:-|to)\s*(Thursday|Thurs?\.?|Friday|Fri\.?)(?![a-z])/i);
    const time = text.match(range);
    if (!days || !time) throw new Error(`Office hours are unrecognized for ${name}: "${text}"`);
    const clock = (hour: string, minute: string | undefined, half: string) => `${hour}:${minute ?? '00'} ${half}M`;
    const schedule = scheduleFromLine(`${clock(time[1], time[2], time[3])} - ${clock(time[4], time[5], time[6])}`);
    const last = /^Fri/i.test(days[2]) ? 5 : 4;
    const hours = createUnknownWeek();
    DAYS.slice(0, last).forEach((day) => { hours[day] = schedule; });
    const captured = collectedAt.slice(0, 10);
    const term = terms.filter((window) => window.until >= captured).sort((a, b) => a.from.localeCompare(b.from))[0];
    if (!term) throw new Error(`No academic calendar semester dates the office hours for ${name}`);
    const year = term.until.slice(0, 4);
    return { name, hours, notes: `${lines[index].match(label)![0]} ${text} Applies during ${term.name} `
        + `per the academic calendar (${shortDate(term.from)} - ${shortDate(term.until)}, ${year}).` };
}

export function campusHoursFromCaptures(captures: HoursSourceCapture[], requireGeneralSource = false,
    terms?: TermWindow[]): LocationHours[] {
    const source = (url: string, parser: (text: string) => LocationHours[]): LocationHours[] => {
        const found = captures.filter((capture) => capture.sourceUrl === url);
        if (found.length !== 1) throw new Error(`Expected exactly one hours capture from ${url}`);
        const capture = found[0];
        if (!Number.isFinite(Date.parse(capture.collectedAt)) || typeof capture.html !== 'string'
            || !capture.html.trim()) throw new Error(`Invalid hours source capture from ${url}`);
        return parser(hoursPageText(capture.html)).map((record) => {
            const window = readValidityFromNotes(record.notes).window;
            return { ...record, sourceUrl: url, collectedAt: capture.collectedAt,
                ...(window ? { validFrom: window.validFrom, validUntil: window.validUntil } : {}) };
        });
    };
    // Replay older two-source captures faithfully. Every new collection below
    // requires and archives the primary parent page as its third source.
    const general = requireGeneralSource || captures.some(capture => capture.sourceUrl === GENERAL_CAMPUS_HOURS_URL)
        ? source(GENERAL_CAMPUS_HOURS_URL, parseGeneralCampusHours) : [];
    // Captures from before office pages were collected replay without them; the
    // collector checks that every office page was parsed.
    const offices = OFFICE_HOURS_PAGES.filter((office) =>
        captures.some((capture) => capture.sourceUrl === office.url));
    const windows = offices.length ? terms ?? readTermWindows() : [];
    return [...source(ATHLETICS_HOURS_URL, parseAthleticsFacilityHours),
        ...source(LIBRARY_HOURS_URL, parseLibraryHours), ...general,
        ...offices.flatMap((office) => source(office.url, (text) => [parseOfficeHours(office.name, office.label, text,
            captures.find((capture) => capture.sourceUrl === office.url)!.collectedAt, windows)]))];
}

export function campusHoursPublication(records: LocationHours[], now = new Date()) {
    const ambiguous = records.filter((record) => record.availabilityIssue);
    const resolved = partitionHoursForPublication(records.filter((record) => !record.availabilityIssue), now);
    const omitted = [
        ...resolved.omitted,
        ...ambiguous.map((record) => ({ record, reason: record.availabilityIssue! })),
    ];
    return { publishable: [...resolved.publishable, ...omitted.map(withheldHoursRecord)], omitted };
}

export function buildCampusHourLocations(locations: LocationHours[], now = new Date()): LocationHours[] {
    return campusHoursPublication(locations, now).publishable;
}

async function fetchCampusHours() {
    const captures = await Promise.all([
        fetchHoursSource(ATHLETICS_HOURS_URL), fetchHoursSource(LIBRARY_HOURS_URL),
        fetchHoursSource(GENERAL_CAMPUS_HOURS_URL),
    ]);
    for (const office of OFFICE_HOURS_PAGES) captures.push(await fetchHoursSource(office.url));
    const fetchedAt = new Date(Math.min(...captures.map((capture) => Date.parse(capture.collectedAt)))).toISOString();
    const capturedSources = { version: 1, captures };
    const locations = campusHoursFromCaptures(captures, true);
    const publication = campusHoursPublication(locations);
    // Every expected source section is parsed or the collector fails. Count alone
    // cannot distinguish a source disappearance from honest applicability omissions.
    if (locations.length !== 13 + OFFICE_HOURS_PAGES.length) throw new Error('Hours source section coverage changed');
    writeJsonFile(SOURCE_CAPTURE_PATH, capturedSources);
    writeRawProvenance('hours-sources', { sourceUrl: GENERAL_CAMPUS_HOURS_URL,
        fetchedAt, recordCount: captures.length, payload: capturedSources });
    writeJsonFile(RAW_JSON_PATH, locations);
    writeRawProvenance('hours', { sourceUrl: GENERAL_CAMPUS_HOURS_URL,
        fetchedAt, recordCount: locations.length, payload: locations });
    for (const omitted of publication.omitted) console.warn(`Withheld hours for ${omitted.record.name}: ${omitted.reason}`);
    if (isRawOnlyMode()) return;
    const normalizedHours = validateCampusHours(publication.publishable);
    writeJsonFile(PUBLIC_JSON_PATH, normalizedHours);
    writeJsonFile(RAG_JSON_PATH, normalizedHours);
    writeJsonFile(OMISSIONS_PATH, { version: 1, collectedAt: fetchedAt, omitted: publication.omitted });
    runGeneratorScript(MARKDOWN_GENERATOR_PATH);
}

if (process.argv[1]?.endsWith('campus-hours.ts')) {
    void fetchCampusHours().catch((error: unknown) => {
        console.error('Error fetching campus hours:', error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
