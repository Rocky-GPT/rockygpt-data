/**
 * Recommended graduation plans as the identity compiler reads them: each plan's record ID
 * and the catalog codes of the programs the plan index links it to. The plans themselves
 * are published whole as the `graduation-plans` release artifact.
 *
 * @module data-v2/graduation-plans
 */

export const GRADUATION_PLANS_SOURCE_KEY = 'graduation-plans';

export interface GraduationPlanLink { id: string; programCodes: string[]; limitations: string[] }

/** The plans a captured artifact publishes; anything else is refused rather than half-read. */
export function graduationPlansInput(value: unknown): GraduationPlanLink[] {
  if (value === undefined || value === null) return [];
  const plans = value && typeof value === 'object' ? (value as { plans?: unknown }).plans : undefined;
  if (!Array.isArray(plans)) throw new Error('Expected the graduation plans artifact.');
  return plans.map(plan => {
    const record = plan && typeof plan === 'object' ? plan as Record<string, unknown> : {};
    const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string') ? items as string[] : null;
    const programCodes = strings(record.programCodes);
    const limitations = strings(record.limitations ?? []);
    if (typeof record.id !== 'string' || !record.id || !programCodes || !limitations) throw new Error('A graduation plan has no ID or program links.');
    return { id: record.id, programCodes, limitations };
  });
}
