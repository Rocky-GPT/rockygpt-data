import path from 'path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { fetchWithPolicy } from './http-client';
import {
    assertCollectionCount,
    isRawOnlyMode,
    runGeneratorScript,
    writeJsonFile,
    writeRawProvenance,
} from './pipeline-utils';
import { validateCampusHours, type LocationHours } from './schema';
import { publicPath } from '../src/paths';
import { partitionHoursForPublication } from '../src/data-v2/validity';

const RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'hours.raw.json');
const PUBLIC_JSON_PATH = publicPath('data', 'hours.json');
const RAG_JSON_PATH = path.join(process.cwd(), 'data', 'normalized', 'hours.json');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-hours-md.ts');
const ATHLETICS_HOURS_URL = 'https://ramapoathletics.com/sports/2008/1/21/bradleycenterhours.aspx';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
type DayName = (typeof DAYS)[number];

function createClosedWeek(): Record<string, string> {
    return DAYS.reduce<Record<string, string>>((acc, day) => {
        acc[day] = 'CLOSED';
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

function indexOfInsensitive(text: string, pattern: string, fromIndex: number = 0): number {
    return text.toLowerCase().indexOf(pattern.toLowerCase(), fromIndex);
}

function sectionBetween(text: string, startHeading: string, endHeading?: string): string {
    const startIndex = indexOfInsensitive(text, startHeading);
    if (startIndex === -1) {
        throw new Error(`Could not find heading "${startHeading}" in athletics hours page`);
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

function parseAthleticsFacilityHours(pageText: string): LocationHours[] {
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

    const bradleyHours = createClosedWeek();
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

    const sharpHours = createClosedWeek();
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

    const poolHours = createClosedWeek();
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

    const auxiliaryHours = createClosedWeek();
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

    const rockHours = createClosedWeek();
    assignDays(
        rockHours,
        ['Monday', 'Wednesday'],
        scheduleFromLine(findLine(rockSection, /Monday\s*(?:&|and)\s*Wednesday/i, 'Rock Climbing Wall'))
    );

    const lodgeHours = createClosedWeek();
    assignDays(
        lodgeHours,
        ['Monday', 'Wednesday', 'Friday'],
        scheduleFromLine(findLine(lodgeSection, /Monday,\s*Wednesday,\s*Friday/i, 'Lodge Fitness Center'))
    );

    return [
        {
            name: "Bradley Center (Student & Recreation Lounge)",
            hours: bradleyHours
        },
        {
            name: "Sharp Fitness Center (Weight Room)",
            hours: sharpHours
        },
        {
            name: "Swimming Pool",
            hours: poolHours,
            notes: "Saturday hours pending varsity swim practice"
        },
        {
            name: "Auxiliary Gym",
            hours: auxiliaryHours,
            notes: "Additional Open Recreation times may be available; check IMLeagues for details."
        },
        {
            name: "Rock Climbing Wall",
            hours: rockHours
        },
        {
            name: "Lodge Fitness Center (College Park Apartments)",
            hours: lodgeHours
        }
    ];
}

async function fetchAthleticsLocations(): Promise<LocationHours[]> {
    try {
        console.log(`Fetching athletics facility hours from ${ATHLETICS_HOURS_URL} with HTTP...`);
        const response = await fetchWithPolicy(
            ATHLETICS_HOURS_URL,
            { headers: { Accept: 'text/html,application/xhtml+xml' } },
            { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const $ = load(response.text());
        return parseAthleticsFacilityHours($('body').text());
    } catch (error: unknown) {
        console.warn(
            `HTTP facility-hours parsing failed; using browser fallback. ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(ATHLETICS_HOURS_URL, { waitUntil: 'networkidle' });
        const athleticsPageText = await page.locator('body').innerText();
        return parseAthleticsFacilityHours(athleticsPageText);
    } finally {
        await browser.close();
    }
}

export function buildCampusHourLocations(
    athleticsLocations: LocationHours[],
    now = new Date()
): LocationHours[] {
    // Library and research-help hours are deliberately absent: their only
    // verified schedules expired in Spring 2026, and no collector-compatible
    // current source is available. Never roll the year forward or guess times.
    const compiled: LocationHours[] = [
        {
            name: "Administrative Offices (Normal Hours)",
            hours: {
                "Monday": "8:30am-4:30pm",
                "Tuesday": "8:30am-4:30pm",
                "Wednesday": "8:30am-4:30pm",
                "Thursday": "8:30am-4:30pm",
                "Friday": "8:30am-4:30pm",
                "Saturday": "CLOSED",
                "Sunday": "CLOSED"
            },
            notes: "Summer hours: Mon-Thu 8:00am-5:15pm, Fri CLOSED"
        },
        {
            name: "Game Lab",
            hours: {
                "Monday": "9:00am-8:00pm",
                "Tuesday": "9:00am-8:00pm",
                "Wednesday": "9:00am-8:00pm",
                "Thursday": "9:00am-8:00pm",
                "Friday": "9:00am-6:00pm",
                "Saturday": "CLOSED",
                "Sunday": "CLOSED"
            },
            notes: "Gaming classes have priority 11am-2pm daily"
        },
        ...athleticsLocations,
        {
            name: "Center for Student Involvement (CSI)",
            hours: {
                "Monday": "8:00am-12:00am",
                "Tuesday": "8:00am-12:00am",
                "Wednesday": "8:00am-12:00am",
                "Thursday": "8:00am-12:00am",
                "Friday": "8:00am-12:00am",
                "Saturday": "4:00pm-10:00pm",
                "Sunday": "3:00pm-8:00pm"
            },
            notes: "Includes Roadrunner Central, J. Lee's, and Women's Center"
        },
        {
            name: "J. Lee's (Student Lounge & Game Room)",
            hours: {
                "Monday": "9:00am-10:00pm",
                "Tuesday": "9:00am-10:00pm",
                "Wednesday": "9:00am-10:00pm",
                "Thursday": "9:00am-10:00pm",
                "Friday": "9:00am-9:00pm",
                "Saturday": "CLOSED",
                "Sunday": "1:00pm-6:00pm"
            },
            notes: "Also called jlees, jlee's, or student lounge. Part of the Bradley Center complex."
        },
        {
            name: "Ramapo Bookstore",
            hours: {
                "Monday": "9:00am-5:00pm",
                "Tuesday": "9:00am-5:00pm",
                "Wednesday": "9:00am-5:00pm",
                "Thursday": "9:00am-5:00pm",
                "Friday": "9:00am-4:00pm",
                "Saturday": "CLOSED",
                "Sunday": "CLOSED"
            },
            notes: "Summer hours: Mon-Fri 10:00am-3:00pm"
        }
    ];

    const availability = partitionHoursForPublication(compiled, now);
    for (const omitted of availability.omitted) {
        const name = typeof omitted.record.name === 'string' ? omitted.record.name : 'unnamed schedule';
        console.warn(`Omitting unavailable hours for ${name}: ${omitted.reason}.`);
    }
    return availability.publishable;
}

async function fetchCampusHours() {
    try {
        const athleticsLocations = await fetchAthleticsLocations();

        const locations = buildCampusHourLocations(athleticsLocations);

        console.log(`Successfully compiled hours for ${locations.length} locations`);
        const normalizedHours = validateCampusHours(locations);
        assertCollectionCount({
            dataset: 'campus hours',
            count: normalizedHours.length,
            minimum: 10,
            previousFilePath: RAW_JSON_PATH,
            minimumPreviousRatio: 0.8,
        });

        writeJsonFile(RAW_JSON_PATH, locations);
        writeRawProvenance('hours', { sourceUrl: ATHLETICS_HOURS_URL, recordCount: locations.length, payload: locations });
        console.log(`Saved raw hours data to ${RAW_JSON_PATH}`);

        if (isRawOnlyMode()) {
            console.log('RAW_ONLY enabled: skipping normalization and context generation.');
            return;
        }

        writeJsonFile(PUBLIC_JSON_PATH, normalizedHours);
        writeJsonFile(RAG_JSON_PATH, normalizedHours);
        console.log(`Saved normalized hours to ${PUBLIC_JSON_PATH} and ${RAG_JSON_PATH}`);

        runGeneratorScript(MARKDOWN_GENERATOR_PATH);

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Error fetching campus hours:', message);
        throw error;
    }
}

if (process.argv[1]?.endsWith('campus-hours.ts')) {
    void fetchCampusHours().catch(() => {
        process.exitCode = 1;
    });
}
