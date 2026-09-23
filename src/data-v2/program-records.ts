type Program = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Historical releases used a display key that can collide across degrees. */
export function legacyProgramRecordKey(program: Program, school: unknown): string {
  return `${text(school)}:${text(program.name).replace(/\s+/g, ' ')}`;
}

/** Catalog codes distinguish separate programs with the same school and name. */
export function programRecordKey(program: Program, school: unknown): string {
  return text(program.catalogCode) ? `catalog:${text(program.catalogCode)}` : legacyProgramRecordKey(program, school);
}
