import type { LocationHours } from './schema';

export function hoursUncertaintyReason(reason: string): string {
  if (reason === 'conflicting-source-validity') return 'The official source contains conflicting applicability dates.';
  if (reason === 'unbounded-term') return 'The official source gives a semester label without explicit start and end dates.';
  if (reason === 'missing-schedule') return 'The official source does not publish a schedule for this facility.';
  if (reason === 'source-update-only') return 'The source supplies an update date but no current applicability period.';
  if (reason === 'ambiguous-source-season') return 'The official source lists seasonal schedules without enough dates to select the current one.';
  return 'The captured schedule could not be verified as applicable to the current date.';
}

/** A verified place remains discoverable even when its schedule is withheld.
 * Never copy rejected clocks, closures, qualifiers or old validity into the
 * current-hours projection. The complete source record stays in the manifest.
 */
export function withheldHoursRecord({ record, reason }: { record: LocationHours; reason: string }): LocationHours {
  return {
    name: record.name,
    hours: Object.fromEntries(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      .map(day => [day, 'Hours unavailable'])),
    notes: `Current hours are unverified. ${hoursUncertaintyReason(reason)} Consult the official source for clarification; this does not establish that the facility is closed.`,
    sourceUrl: record.sourceUrl,
    collectedAt: record.collectedAt,
    availabilityIssue: 'unverified-hours',
  };
}
