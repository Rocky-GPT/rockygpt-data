/**
 * @module api/dining-hours/route
 * Resolved dining-location hours endpoint.
 *
 * Reads the Sodexo-normalised `dining-hours.json`, applies seasonal
 * overrides for the current date, and returns per-location open/close
 * times for both "today" and "general" weekly schedules.
 */

import { loadReleaseArtifact } from '../../src/data-v2/release-artifacts';
import { DINING_HOURS_UNKNOWN, formatDiningRange } from '../../src/data-v2/dining-seasons';

import type { DiningHoursResponse } from '../contract';
import { fail, ok, type ApiHandler } from '../http';
import { parseIsoDate, validateQueryLengths } from '../query';


/**
 * Forces this route to read fresh generated data instead of using static rendering.
 */

interface DiningTime {
  hour: string;
  minute: string;
  period: string;
}

interface DiningHoursRange {
  allDay: boolean;
  closed?: boolean;
  startTime?: DiningTime;
  finishTime?: DiningTime;
  label?: string;
}

interface DiningHoursGroup {
  days: { value: string }[];
  hours: DiningHoursRange[];
}

interface DiningSeason {
  from: string;
  to: string;
  openingHours: DiningHoursGroup[];
}

interface DiningFragment {
  type: string;
  content: {
    main: {
      name: string;
      slug?: string;
      openingHours: {
        standardHours: DiningHoursGroup[];
        seasonalHours: DiningSeason[];
      };
    };
  };
}

interface DiningData {
  composition: {
    subject: {
      regions: { fragments: DiningFragment[] }[];
    };
  };
}

// --- Resolver logic ---

const EMOJI_MAP: Record<string, string> = {
  'birch tree inn': '🍽️',
  "dunkin'": '☕',
  'the atrium': '🥗',
};

function isDateInSeason(now: Date, from: string, to: string): boolean {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  return now >= fromDate && now <= toDate;
}

function findTodayDayName(now: Date, timezone: string): string {
  const dayIndex = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' })
    .format(now);
  return dayIndex; // e.g. "Wednesday"
}

interface ResolvedLocation {
  name: string;
  emoji: string;
  todayLabel: string;
  isOverride: boolean;
  overrideNote?: string;
  hours: { label?: string; time: string }[];
}

export function resolveLocationHoursForToday(
  fragment: DiningFragment,
  now: Date,
  timezone: string
): ResolvedLocation {
  const { name, openingHours } = fragment.content.main;
  const today = findTodayDayName(now, timezone);
  const emoji = EMOJI_MAP[name.toLowerCase()] || (name.toLowerCase().includes('starbucks') ? '☕' : '🏢');
  const season = openingHours.seasonalHours.find(s => isDateInSeason(now, s.from, s.to));
  const groups = (season ? season.openingHours : openingHours.standardHours)
    .filter(group => group.days.some(day => day.value === today));
  const hours = groups.flatMap(group => group.hours.map(range => ({
    label: range.label,
    time: formatDiningRange({ ...range }),
  })));
  const explicitlyClosed = hours.length > 0 && hours.every(hour => hour.time === 'Closed');
  return {
    name, emoji, todayLabel: today, isOverride: Boolean(season),
    overrideNote: season && explicitlyClosed ? 'Seasonal closure' : season ? 'Seasonal schedule' : undefined,
    hours: hours.length ? hours : [{ time: DINING_HOURS_UNKNOWN }],
  };
}

interface GeneralHoursSchedule {
  days: string;
  hours: { label?: string; time: string }[];
}

interface GeneralLocation {
  name: string;
  emoji: string;
  schedule: GeneralHoursSchedule[];
}

export function resolveGeneralHours(fragment: DiningFragment): GeneralLocation {
  const { name, openingHours } = fragment.content.main;
  const emoji = EMOJI_MAP[name.toLowerCase()] || (name.toLowerCase().includes('starbucks') ? '☕' : '🏢');

  const schedule: GeneralHoursSchedule[] = openingHours.standardHours.map((group) => {
    const days = group.days.map((d) => d.value).join(', ');
    const hours = group.hours.map(range => ({
      label: range.label,
      time: formatDiningRange({ ...range }, false),
    }));
    return { days, hours: hours.length ? hours : [{ time: DINING_HOURS_UNKNOWN }] };
  });

  if (schedule.length === 0) {
    schedule.push({
      days: 'Schedule unavailable',
      hours: [
        {
          label: 'Status',
          time: DINING_HOURS_UNKNOWN,
        },
      ],
    });
  }

  return { name, emoji, schedule };
}

/**
 * Returns normalized dining location hours for the menu and hours UI.
 */
export const getDiningHours: ApiHandler = async (request) => {
  const invalidLength = validateQueryLengths(request, { date: 10 });
  if (invalidLength) return invalidLength;

  const dateParam = request.url.searchParams.get('date');
  const parsedDate = dateParam ? parseIsoDate(dateParam) : null;
  if (dateParam && !parsedDate) {
    return fail(400, 'INVALID_REQUEST', '`date` must be a real date in YYYY-MM-DD form.');
  }

  try {
    const loaded = await loadReleaseArtifact('dining-hours');
    const data = loaded.payload as DiningData;

    const timezone = 'America/New_York';
    const targetDate = parsedDate ?? new Date();

    const fragments = data.composition.subject.regions.flatMap((r) => r.fragments);
    const locationFragments = fragments.filter((f) => f.type === 'Location');

    const locations = locationFragments.map((f) => resolveLocationHoursForToday(f, targetDate, timezone));
    const generalHours = locationFragments.map((f) => resolveGeneralHours(f));

    // Sort helper
    const sortByBirchFirst = <T extends { name: string }>(a: T, b: T) => {
      if (a.name.toLowerCase().includes('birch')) return -1;
      if (b.name.toLowerCase().includes('birch')) return 1;
      return a.name.localeCompare(b.name);
    };

    locations.sort(sortByBirchFirst);
    generalHours.sort(sortByBirchFirst);

    return ok({
      success: true,
      today: findTodayDayName(targetDate, timezone),
      dateFormatted: targetDate.toLocaleDateString('en-US', {
        timeZone: timezone,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
      locations,
      generalHours,
      releaseVersion: loaded.releaseVersion,
    } satisfies DiningHoursResponse);
  } catch (error) {
    console.error('Error resolving dining hours:', error);
    return fail(503, 'UNAVAILABLE', 'Dining hours are unavailable.', true);
  }
}
