/** Normalizes the catalog's scalar or min/max credit payload for the wire. */
export function courseCredits(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('{')) {
      try {
        return courseCredits(JSON.parse(trimmed) as unknown);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (!value || typeof value !== 'object') return undefined;
  const credits = value as { min?: unknown; max?: unknown };
  const min = typeof credits.min === 'number' ? credits.min : Number(credits.min);
  const max = typeof credits.max === 'number' ? credits.max : Number(credits.max);
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > min) {
    return `${min}-${max}`;
  }
  if (Number.isFinite(max) && max > 0) return String(max);
  if (Number.isFinite(min) && min > 0) return String(min);
  return undefined;
}
