import { fail, type ApiRequest, type ApiResponse } from './http';

/** Returns a 400 response when a supplied query value exceeds its route limit. */
export function validateQueryLengths(
  request: ApiRequest,
  limits: Readonly<Record<string, number>>
): ApiResponse | null {
  for (const [name, maxLength] of Object.entries(limits)) {
    const values = request.url.searchParams.getAll(name);
    if (values.length > 1) {
      return fail(400, 'INVALID_REQUEST', `\`${name}\` may be supplied only once.`);
    }
    if (values[0] !== undefined && values[0].length > maxLength) {
      return fail(
        400,
        'INVALID_REQUEST',
        `\`${name}\` must be at most ${maxLength} characters.`
      );
    }
  }
  return null;
}

/** Strictly parses the date-only form used by the dining UI. */
export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

/** The search contract requires a timestamp with an explicit timezone. */
export function parseIsoInstant(value: string): Date | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  ) {
    return null;
  }
  if (!parseIsoDate(value.slice(0, 10))) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
