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
        .replace(/[\u2010-\u2012\u2212–—]/g, '-')
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
            help.derivation = 'A repeated schedule on the page gives the same hours under an older year.';
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
 * Offices whose own page publishes their hours. Each name is the office's campus identity.
 * Three kinds, each reviewed against the page:
 * - regular (no `kind`): a regular (Fall/Spring) schedule beside a separate summer one. The
 *   label is the line that starts the regular schedule (read 2026-09-28). Summer schedules
 *   stay out: no page dates them.
 * - `always`: the page says the office is open every hour of every day. The label is the
 *   sentence that says so. Nothing in it is seasonal, so the record names no dates.
 * - `week`: the page prints its weekly schedule as day-and-time segments that differ by day
 *   ("Monday - Thursday, 10 AM - 8 PM", "Friday 10 AM - 4 PM", "Saturday Closed"). The label is
 *   the line before the first segment (or the line the schedule starts on). Read by
 *   parseWeeklyHours, which refuses anything it cannot fully account for.
 * - `conflict`: the page states two schedules that disagree (read 2026-10-06). Both
 *   statements must still be on the page, or the collector stops for a person to look: a
 *   fixed page must not stay withheld, and a changed one must not be guessed.
 */
export interface OfficeHoursPage {
    name: string;
    url: string;
    label: RegExp;
    kind?: 'always' | 'conflict' | 'week';
    /** For `conflict`: the other statement the label's line disagrees with. */
    against?: RegExp;
}
export const OFFICE_HOURS_PAGES: ReadonlyArray<OfficeHoursPage> = [
    { name: 'Registrar', url: 'https://www.ramapo.edu/registrar/', label: /^Fall\s*\/\s*Spring Hours:/i },
    { name: 'Student Accounts', url: 'https://www.ramapo.edu/student-accounts/', label: /^Academic Year:/i },
    { name: 'Financial Aid', url: 'https://www.ramapo.edu/finaid/', label: /^Academic Year:/i },
    { name: 'Cahill Career Development Center', url: 'https://www.ramapo.edu/careercenter/', label: /^Office Hours:/i },
    { name: 'Dean of Students', url: 'https://www.ramapo.edu/student-affairs/', label: /^Regular Office Hours:/i },
    { name: 'Educational Opportunity Fund (EOF) Program', url: 'https://www.ramapo.edu/eof-program/',
        label: /^Academic Year Hours:/i },
    { name: 'Office of Student Conduct', url: 'https://www.ramapo.edu/student-conduct/',
        label: /^Fall and Spring Semester Hours:/i },
    // Read 2026-10-07. These pages name no season or print one schedule beside an undated summer
    // one; the academic calendar dates the regular schedule, as for the offices above.
    { name: 'Anisfield School of Business', url: 'https://www.ramapo.edu/asb/', label: /^Hours:/i },
    // The page prints the days on one line and the times on the next, under no label of its own:
    // the label is the day line, kept (zero width) so the parser still reads the days from it.
    { name: 'Center for Student Success (Academic Advising)', url: 'https://www.ramapo.edu/studentsuccess/',
        label: /^(?=Monday-Friday$)/i },
    { name: 'Office of Specialized Services', url: 'https://www.ramapo.edu/oss/',
        label: /^MAIN OFFICE:.*?Office Hours Typically/i },
    { name: 'Payroll', url: 'https://www.ramapo.edu/payroll/', label: /^Fall\s*\/\s*Spring,/i },
    { name: 'Testing Center', url: 'https://www.ramapo.edu/testing/', label: /^Fall and Spring$/i },
    // The schedule is one sentence in the middle of a paragraph, after the appointment sentence.
    { name: 'ID Card Room', url: 'https://www.ramapo.edu/publicsafety/id-cards/',
        label: /^In order to get a new identification card, please contact the ID room at publicsafety@ramapo\.edu and make an appointment\.\s*The ID room is open/i },
    { name: 'Nursing Programs Office', url: 'https://www.ramapo.edu/nursing/', label: /^Hours:/i },
    // Different times on different days (read 2026-10-07).
    { name: 'Center for Reading and Writing', url: 'https://www.ramapo.edu/crw/', kind: 'week', label: /^Hours$/i },
    { name: 'Center for Student Involvement', url: 'https://www.ramapo.edu/csi/', kind: 'week',
        label: /^CSI Hours of Operation$/i },
    { name: 'Roadrunner Central', url: 'https://www.ramapo.edu/csi/roadrunner-central/', kind: 'week',
        label: /^Please visit the Center for Student Involvement Main Office, located in SC202, for assistance during the following hours during the semester:$/i },
    // The page's heading names the term, so the label does too: a new term's page stops the collector.
    { name: 'Photography Lab', url: 'https://www.ramapo.edu/photolab/hours/', kind: 'week', label: /^FALL 2026$/i },
    { name: 'Counseling Center', url: 'https://www.ramapo.edu/counseling/', label: /^Academic Year Hours:/i },
    // One page states it for the whole department, so both Public Safety offices share the sentence.
    { name: 'Public Safety (Emergency)', url: 'https://www.ramapo.edu/publicsafety/get-support/', kind: 'always',
        label: /The Public Safety Department is available 24 hours a day, 7 days a week(?:, 365 days a year)?\./i },
    { name: 'Public Safety (Non-Emergency)', url: 'https://www.ramapo.edu/publicsafety/get-support/', kind: 'always',
        label: /The Public Safety Department is available 24 hours a day, 7 days a week(?:, 365 days a year)?\./i },
    // The hours table and the paragraph beneath it give different Fall/Spring hours.
    { name: 'IT Help Desk', url: 'https://www.ramapo.edu/its/help-desk/', kind: 'conflict',
        label: /Fall \/ Spring\nMonday-Thursday\nFriday\n8:30 AM - 8:00 PM\n8:30 AM - 6:00 PM/,
        against: /Fall\/Spring: Monday-Friday 8:00am-8:00pm/i },
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
    if (lines.filter((line) => label.test(line)).length > 1) throw new Error(`The hours label for ${name} matches more than one line`);
    const range = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*(?:-|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i;
    // The schedule follows its label on the same line, or on the next line (Registrar).
    const rest = lines[index].replace(label, '').trim();
    const text = range.test(rest) ? rest : `${rest} ${lines[index + 1] ?? ''}`.trim();
    const days = text.match(/\b(Monday|Mon\.?)\s*(?:-|to|through|thru)\s*(Thursday|Thurs?\.?|Friday|Fri\.?)(?![a-z])/i);
    const time = text.match(range);
    if ([...text.matchAll(new RegExp(range.source, 'gi'))].length > 1) {
        throw new Error(`Office hours state more than one time range for ${name}: "${text}"`);
    }
    if (!days || !time) throw new Error(`Office hours are unrecognized for ${name}: "${text}"`);
    const clock = (hour: string, minute: string | undefined, half: string) => `${hour}:${minute ?? '00'} ${half}M`;
    const schedule = scheduleFromLine(`${clock(time[1], time[2], time[3])} - ${clock(time[4], time[5], time[6])}`);
    const last = /^Fri/i.test(days[2]) ? 5 : 4;
    const hours = createUnknownWeek();
    DAYS.slice(0, last).forEach((day) => { hours[day] = schedule; });
    // Notes carry only the page's own words; the dating is the collector's, so it stays apart.
    return { name, hours, notes: `${lines[index].match(label)![0]} ${text}`.trim(),
        ...datedByTerm(name, collectedAt, terms) };
}

/** The semester the capture falls in (or the next one). */
function termFor(name: string, collectedAt: string, terms: TermWindow[]): TermWindow {
    const captured = collectedAt.slice(0, 10);
    const term = terms.filter((window) => window.until >= captured).sort((a, b) => a.from.localeCompare(b.from))[0];
    if (!term) throw new Error(`No academic calendar semester dates the office hours for ${name}`);
    return term;
}

/** The semester the capture falls in (or the next one) dates a schedule that names no dates. */
function datedByTerm(name: string, collectedAt: string, terms: TermWindow[]):
    { validFrom: string; validUntil: string; derivation: string } {
    const term = termFor(name, collectedAt, terms);
    return { validFrom: term.from, validUntil: term.until,
        derivation: `Applies during ${term.name} per the academic calendar `
            + `(${shortDate(term.from)} - ${shortDate(term.until)}, ${term.until.slice(0, 4)}).` };
}

const DAY_WORD = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|weekdays|weekends)s?`;
const CLOCK_WORD = String.raw`(?:noon|midnight|\d{1,2}(?::\d{2})?(?:\s*[ap]\.?\s*m\.?)?)`;
// One day-and-time segment: days (one, a range, or weekdays/weekends), then a time range, "closed"
// or "by (virtual) appointment".
const SEGMENT = new RegExp(String.raw`\b(${DAY_WORD})\.?(?:\s*(?:-|to|through|thru)\s*(${DAY_WORD})\.?)?`
    + String.raw`\s*[:,-]?\s*(?:from\s+)?(?:(${CLOCK_WORD})\s*(?:-|to|until)\s*(${CLOCK_WORD})`
    + String.raw`|(closed)|(by\s+(?:virtual\s+)?appointment(?:\s+only)?))`, 'gi');

/** A clock time in minutes after midnight, with its text; a missing am/pm is only filled in by `inherit`. */
function clockTime(token: string, inherit?: string): { minutes: number; text: string } {
    const word = token.trim().toLowerCase().replace(/\./g, '');
    if (word === 'noon') return { minutes: 720, text: '12:00pm' };
    if (word === 'midnight') return { minutes: 0, text: '12:00am' };
    const match = word.match(/^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])m)?$/);
    const meridiem = match?.[3] ?? inherit;
    if (!match || !meridiem || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2] ?? '0') > 59) {
        throw new Error(`Unable to read the time "${token}"`);
    }
    const hour = Number(match[1]) % 12 + (meridiem === 'p' ? 12 : 0);
    const minute = match[2] ?? '00';
    return { minutes: hour * 60 + Number(minute), text: `${Number(match[1])}:${minute}${meridiem}m` };
}

function segmentSchedule(start: string, end: string): string {
    const endMeridiem = end.trim().toLowerCase().replace(/\./g, '').match(/([ap])m$/)?.[1];
    const last = clockTime(end);
    // Only a start with no am/pm of its own borrows the end's, and only when that puts it first.
    const first = clockTime(start, endMeridiem);
    const closes = /midnight/i.test(end) || (last.minutes === 0) ? 1440 : last.minutes;
    if (first.minutes >= closes) throw new Error(`The times "${start} - ${end}" do not run forward within one day`);
    return `${first.text}-${last.text}`;
}

function weekdaySet(first: string, second?: string): DayName[] {
    const key = (word: string) => word.toLowerCase().slice(0, 3);
    if (/^weekdays/i.test(first)) return DAYS.slice(0, 5);
    if (/^weekends/i.test(first)) return DAYS.slice(5);
    const order = DAYS.map((day) => day.slice(0, 3).toLowerCase());
    const from = order.indexOf(key(first));
    const to = second ? order.indexOf(key(second)) : from;
    if (from < 0 || to < from || (second && /^week/i.test(second))) throw new Error(`Unable to read the days "${first}${second ? ' - ' + second : ''}"`);
    return DAYS.slice(from, to + 1);
}

const SEASON_OR_CLOSURE = /\b(?:summer|winter|spring|fall|term|semester|break|holiday|holidays|closed|appointment|except)\b/i;
const UNACCOUNTED = /\d|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(?:closed|except|appointment|only|summer|winter|break|holiday|holidays|until|till|from|by)\b/i;

/** The segments a line states, and whether the line states nothing but segments. */
function segmentsIn(line: string): { found: RegExpMatchArray[]; pure: boolean } {
    const found = [...line.matchAll(SEGMENT)];
    const rest = found.reduce((text, match) => text.replace(match[0], ' '), line);
    return { found, pure: found.length > 0 && !/[a-z0-9]/i.test(rest.replace(/\b(?:and)\b/gi, '')) };
}

/**
 * An office's weekly schedule when its page prints a separate time (or "closed", or "by
 * appointment") for different days. The block starts at the label line (or the first segment after
 * it, skipping at most three other lines) and ends at the first line that is not purely segments;
 * a first line that mixes prose and segments is the whole block. Anything it cannot account for
 * stops the collector: a day stated twice with different schedules, a time with no am/pm it cannot
 * place, a span that does not run forward within one day. Dated by the semester, like the others.
 */
export function parseWeeklyHours(name: string, label: RegExp, pageText: string, collectedAt: string,
    terms: TermWindow[]): LocationHours {
    const lines = pageText.split('\n').map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) throw new Error(`Office hours line is unavailable for ${name}`);
    if (lines.filter((line) => label.test(line)).length > 1) throw new Error(`The hours label for ${name} matches more than one line`);
    // A page that names its own term must name the one the calendar dates this capture to.
    const term = termFor(name, collectedAt, terms);
    const named = lines[index].match(/\b(fall|spring|winter|summer)\s+(20\d{2})\b/i);
    if (named && `${named[1]} ${named[2]}`.toLowerCase() !== term.name.toLowerCase()) {
        throw new Error(`The page for ${name} says "${named[0]}" but the academic calendar dates this schedule to ${term.name}`);
    }
    const candidates = [lines[index].replace(label, '').trim(), ...lines.slice(index + 1)].filter(Boolean);
    const block: string[] = [];
    let skipped = 0;
    let ending: string | undefined;
    for (let at = 0; at < candidates.length; at += 1) {
        const line = candidates[at];
        const { found, pure } = segmentsIn(line);
        if (!block.length) {
            if (!found.length) {
                // Prose between the label and the schedule must not be about another season or a closure.
                if (SEASON_OR_CLOSURE.test(line)) throw new Error(`${name} has a line before its schedule that the reader cannot account for: "${line}"`);
                if (++skipped > 3) break;
                continue;
            }
            block.push(line);
            if (!pure) { ending = candidates[at + 1]; break; }
        } else if (pure) block.push(line);
        else { ending = line; break; }
    }
    // The line that ends the schedule must not itself talk about a day: that is a piece not understood.
    if (ending && new RegExp(String.raw`\b${DAY_WORD}\b`, 'i').test(ending)) {
        throw new Error(`${name} has a line after its schedule that mentions a day and that the reader cannot account for: "${ending}"`);
    }
    // Whatever the segments did not consume must be plain prose: no time, no day, no exception.
    for (const line of block) {
        const left = segmentsIn(line).found.reduce((text, match) => text.replace(match[0], ' '), line);
        if (UNACCOUNTED.test(left)) throw new Error(`${name} has schedule text the reader cannot account for: "${line}"`);
    }
    if (!block.length) throw new Error(`Office hours are unrecognized for ${name}: no day-and-time lines follow the label`);
    const hours = createUnknownWeek();
    const assigned = new Set<string>();
    for (const match of block.flatMap((line) => [...line.matchAll(SEGMENT)])) {
        const schedule = match[5] ? 'CLOSED'
            : match[6] ? match[6].charAt(0).toUpperCase() + match[6].slice(1).toLowerCase().replace(/\s+/g, ' ')
                : segmentSchedule(match[3], match[4]);
        for (const day of weekdaySet(match[1], match[2])) {
            if (assigned.has(day) && hours[day] !== schedule) throw new Error(`${name} states two schedules for ${day}`);
            hours[day] = schedule;
            assigned.add(day);
        }
    }
    return { name, hours, notes: `${lines[index].match(label)![0]} ${block.join(' ')}`.trim(),
        validFrom: term.from, validUntil: term.until,
        derivation: `Applies during ${term.name} per the academic calendar `
            + `(${shortDate(term.from)} - ${shortDate(term.until)}, ${term.until.slice(0, 4)}).` };
}

/** An office the page says is open every hour of every day. The page's sentence is the note. */
export function parseAlwaysOpenHours(name: string, label: RegExp, pageText: string): LocationHours {
    const sentence = pageText.match(label)?.[0];
    if (!sentence) throw new Error(`Always-open statement is unavailable for ${name}`);
    const hours = createUnknownWeek();
    DAYS.forEach((day) => { hours[day] = '24 hours'; });
    return { name, hours, notes: sentence.replace(/\s+/g, ' ') };
}

/**
 * An office whose page states two schedules that disagree. Neither is published: the record
 * is withheld, and its note keeps both statements as written so a person can compare them.
 * It fails when either statement is gone, so a corrected page is noticed, not ignored.
 */
export function parseConflictingOfficeHours(name: string, label: RegExp, against: RegExp, pageText: string): LocationHours {
    const first = pageText.match(label)?.[0];
    const second = pageText.match(against)?.[0];
    if (!first || !second) throw new Error(`The reviewed conflict in the hours of ${name} is no longer on its page; review it`);
    return { name, hours: createUnknownWeek(), availabilityIssue: 'conflicting-source-schedules',
        notes: `${first.replace(/\s+/g, ' ')}\n${second.replace(/\s+/g, ' ')}` };
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
        ...offices.flatMap((office) => source(office.url, (text) => [
            office.kind === 'always' ? parseAlwaysOpenHours(office.name, office.label, text)
                : office.kind === 'week' ? parseWeeklyHours(office.name, office.label, text,
                    captures.find((capture) => capture.sourceUrl === office.url)!.collectedAt, windows)
                : office.kind === 'conflict' ? parseConflictingOfficeHours(office.name, office.label, office.against!, text)
                    : parseOfficeHours(office.name, office.label, text,
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
    // Two offices can share one page; it is fetched and archived once.
    for (const url of new Set(OFFICE_HOURS_PAGES.map((office) => office.url))) captures.push(await fetchHoursSource(url));
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
