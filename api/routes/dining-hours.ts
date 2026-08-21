/**
 * @module api/dining-hours/route
 * Resolved dining-location hours endpoint.
 *
 * Reads the Sodexo-normalised `dining-hours.json`, applies seasonal
 * overrides for the current date, and returns per-location open/close
 * times for both "today" and "general" weekly schedules.
 */

import { loadReleaseArtifact } from '../../src/data-v2/release-artifacts';

import { ok, type ApiHandler, type ApiResponse } from '../http';

/**
 * Mirrors the response helper these handlers were written against, so the
 * logic below is the same code that ran inside the web app.
 */
const json = (body: unknown, init?: { status?: number }): ApiResponse =>
  init?.status && init.status !== 200 ? { status: init.status, body } : ok(body);


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

function formatTime(t: DiningTime): string {
  return `${t.hour}:${t.minute} ${t.period}`;
}

function formatRange(r: DiningHoursRange): string {
  if (!r.startTime || !r.finishTime) return 'Closed';
  const time = `${formatTime(r.startTime)} - ${formatTime(r.finishTime)}`;
  return r.label ? `${r.label}: ${time}` : time;
}

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

function resolveLocationHoursForToday(
  fragment: DiningFragment,
  now: Date,
  timezone: string
): ResolvedLocation {
  const { name, openingHours } = fragment.content.main;
  const today = findTodayDayName(now, timezone);
  const emoji = EMOJI_MAP[name.toLowerCase()] || (name.toLowerCase().includes('starbucks') ? '☕' : '🏢');

  // Check if any seasonal override applies for today
  for (const season of openingHours.seasonalHours) {
    if (!isDateInSeason(now, season.from, season.to)) continue;

    // Found an active seasonal override
    if (season.openingHours.length === 0) {
      // Empty openingHours in a seasonal override = closed
      return {
        name,
        emoji,
        todayLabel: today,
        isOverride: true,
        overrideNote: 'Seasonal closure',
        hours: [{ time: 'Closed' }],
      };
    }

    // Find today's hours within the seasonal override
    for (const group of season.openingHours) {
      const matchesDay = group.days.some((d) => d.value === today);
      if (!matchesDay) continue;

      const hours = group.hours
        .map((r) => ({
          label: r.label,
          time: formatRange(r),
        }))
        .filter((h) => h.time !== 'Closed' || group.hours.length === 1);

      if (hours.length === 0 || (hours.length === 1 && hours[0].time === 'Closed')) {
        return {
          name,
          emoji,
          todayLabel: today,
          isOverride: true,
          overrideNote: group.hours[0]?.label || 'Seasonal closure',
          hours: [{ time: 'Closed', label: group.hours[0]?.label }],
        };
      }

      return {
        name,
        emoji,
        todayLabel: today,
        isOverride: true,
        overrideNote: group.hours[0]?.label,
        hours,
      };
    }

    // Seasonal override active but no matching day entry = closed for today
    return {
      name,
      emoji,
      todayLabel: today,
      isOverride: true,
      overrideNote: 'Seasonal closure',
      hours: [{ time: 'Closed' }],
    };
  }

  // No seasonal override — use standard hours
  for (const group of openingHours.standardHours) {
    const matchesDay = group.days.some((d) => d.value === today);
    if (!matchesDay) continue;

    const hours = group.hours.map((r) => ({
      label: r.label,
      time: formatRange(r),
    }));

    if (hours.length === 0 || (hours.length === 1 && hours[0].time === 'Closed')) {
      const isSeasonal = openingHours.seasonalHours.length > 0;
      return {
        name,
        emoji,
        todayLabel: today,
        isOverride: isSeasonal,
        overrideNote: isSeasonal ? 'Seasonal closure' : undefined,
        hours: [{ time: 'Closed' }],
      };
    }

    return {
      name,
      emoji,
      todayLabel: today,
      isOverride: false,
      hours,
    };
  }

  const isSeasonal = openingHours.seasonalHours.length > 0;
  return {
    name,
    emoji,
    todayLabel: today,
    isOverride: isSeasonal,
    overrideNote: isSeasonal ? 'Seasonal closure' : undefined,
    hours: [{ time: 'Closed' }],
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

function resolveGeneralHours(fragment: DiningFragment): GeneralLocation {
  const { name, openingHours } = fragment.content.main;
  const emoji = EMOJI_MAP[name.toLowerCase()] || (name.toLowerCase().includes('starbucks') ? '☕' : '🏢');

  const schedule: GeneralHoursSchedule[] = openingHours.standardHours.map((group) => {
    const days = group.days.map((d) => d.value).join(', ');
    const hours = group.hours.map((r) => {
      if (!r.startTime || !r.finishTime) {
        return { label: r.label, time: 'Closed' };
      }
      const time = `${formatTime(r.startTime)} - ${formatTime(r.finishTime)}`;
      return { label: r.label, time };
    });
    return { days, hours };
  });

  if (schedule.length === 0) {
    schedule.push({
      days: 'Summer Schedule',
      hours: [
        {
          label: 'Status',
          time: 'Closed for seasonal break',
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
  try {
    const loaded = await loadReleaseArtifact('dining-hours');
    const data = loaded.payload as DiningData;

    const dateParam = request.url.searchParams.get('date');
    const timezone = 'America/New_York';
    const targetDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? new Date(dateParam + 'T12:00:00Z')
      : new Date();

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

    return json({
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
    });
  } catch (error) {
    console.error('Error resolving dining hours:', error);
    return json({ error: 'Dining hours unavailable' }, { status: 500 });
  }
}
