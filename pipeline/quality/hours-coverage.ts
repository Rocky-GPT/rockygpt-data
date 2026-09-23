import { isDeepStrictEqual } from 'node:util';
import { campusHoursPublication, campusHoursFromCaptures, type HoursSourceCapture } from '../../ingestion/campus-hours';
import { validateCampusHours } from '../../ingestion/schema';

/** Bind the derived schedules to the exact archived pages, not just a clock. */
export function hoursSourceErrors(raw: unknown, sources: unknown): string[] {
  try {
    const capture = sources as { version?: number; captures?: HoursSourceCapture[] } | null;
    if (capture?.version !== 1 || !Array.isArray(capture.captures)) throw new Error('Missing hours source captures.');
    const parsed = campusHoursFromCaptures(capture.captures);
    return isDeepStrictEqual(validateCampusHours(raw), validateCampusHours(parsed)) ? []
      : ['Derived campus hours differ from the archived official source pages.'];
  } catch (error) {
    return [`Campus hours source replay failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** Every collected facility must be published faithfully or explicitly withheld. */
export function hoursCoverageErrors(raw: unknown, published: unknown, manifest: unknown, now: Date): string[] {
  try {
    const records = validateCampusHours(raw);
    if (records.some(record => !record.sourceUrl || !record.collectedAt || !Number.isFinite(Date.parse(record.collectedAt)))) {
      return ['Campus hours lack per-facility source capture provenance; refresh the hours collector.'];
    }
    const expected = campusHoursPublication(records, now);
    const omissions = manifest as { version?: number; omitted?: unknown } | null;
    const errors: string[] = [];
    if (!isDeepStrictEqual(validateCampusHours(published), expected.publishable)) {
      errors.push('Published campus hours differ from the applicable captured source records.');
    }
    if (omissions?.version !== 1 || !isDeepStrictEqual(omissions.omitted, expected.omitted)) {
      errors.push('Campus hours omissions do not account for every withheld source record and reason.');
    }
    return errors;
  } catch (error) {
    return [`Campus hours coverage cannot be verified: ${error instanceof Error ? error.message : String(error)}`];
  }
}
