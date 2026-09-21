/** Occurrence-level normalization; never infer diet, serving size or item type. */
export function menuCalories(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 2147483647 ? number : undefined;
}

/** Exact known source message, retained in raw snapshots for audit. */
export function isMenuArtifact(name: string): boolean {
  return name.trim().replace(/\s+/g, ' ').toLowerCase() === 'have a nice day';
}

/** Remove the exact known message and its description from released menu prose. */
export function filterMenuMarkdown(content: string): string {
  return content.replace(/^- \*\*Have a Nice Day\*\*[^\n]*(?:\n[ \t]+>[^\n]*)?\n?/gmi, '');
}
