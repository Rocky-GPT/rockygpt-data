/**
 * The public catalog's page layouts and department names, read from the page data
 * that catalog.ramapo.edu embeds in every server-rendered page. A layout says which
 * fields a program or course page displays, in which tab and under which label, so
 * a capture keeps what students see rather than every field the catalog stores.
 */

import { load } from 'cheerio';

// Reactive wrappers around a single value; they carry no data of their own.
const WRAPPERS = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef']);

/** The page data, revived from its serialized form: every value is an index into one table. */
export function catalogPageData(html: string): unknown {
  const text = load(html)('script#__NUXT_DATA__').text();
  if (!text.trim()) throw new Error('The catalog page has no embedded page data.');
  const table = JSON.parse(text) as unknown[];
  if (!Array.isArray(table) || !table.length) throw new Error('The catalog page data is empty.');
  const revived = new Map<number, unknown>();
  const revive = (index: unknown): unknown => {
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('Unexpected catalog page data reference.');
    // Negative references are constants; -1 is undefined and the rest have no JSON form.
    if (index < 0) return index === -1 ? undefined : null;
    if (revived.has(index)) return revived.get(index);
    const value = table[index];
    if (value === null || typeof value !== 'object') {
      revived.set(index, value);
      return value;
    }
    if (Array.isArray(value)) {
      const [type, ...rest] = value;
      if (typeof type === 'string') {
        if (WRAPPERS.has(type)) {
          const inner = rest.length ? revive(rest[0]) : undefined;
          revived.set(index, inner);
          return inner;
        }
        if (type === 'Date') {
          revived.set(index, rest[0]);
          return rest[0];
        }
        if (type === 'Set') {
          const items: unknown[] = [];
          revived.set(index, items);
          for (const item of rest) items.push(revive(item));
          return items;
        }
        if (type === 'Map' || type === 'null') {
          const entries: Record<string, unknown> = {};
          revived.set(index, entries);
          for (let i = 0; i + 1 < rest.length; i += 2) entries[String(revive(rest[i]))] = revive(rest[i + 1]);
          return entries;
        }
        throw new Error(`Unsupported catalog page data type ${type}.`);
      }
      const items: unknown[] = [];
      revived.set(index, items);
      for (const item of value) items.push(revive(item));
      return items;
    }
    const entries: Record<string, unknown> = {};
    revived.set(index, entries);
    for (const [key, item] of Object.entries(value)) entries[key] = revive(item);
    return entries;
  };
  return revive(0);
}

export interface PageField { key: string; label: string }
export interface PageTab { title: string; fields: PageField[] }
export interface PageLayout { tabs: PageTab[]; labels: Record<string, string> }
export interface CatalogSettings { program: PageLayout; course: PageLayout }
export interface CatalogDepartment { id: string; name: string }

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function pageLayout(value: unknown, name: string): PageLayout {
  const template = record(value);
  const questions = record(template?.questions) ?? {};
  const labels = Object.fromEntries(Object.entries(questions).flatMap(([key, question]) => {
    const label = record(question)?.label;
    return typeof label === 'string' && label.trim() ? [[key, label.trim()]] : [];
  }));
  const tabs = list(template?.template).flatMap(card => {
    const fields = list(record(card)?.children).flatMap(row => list(record(row)?.children))
      .map(record).filter((question): question is Json => question?.type === 'question' && typeof question.id === 'string')
      .map(question => ({ key: question.id as string, label: labels[question.id as string] ?? (question.id as string) }));
    const title = record(record(card)?.config)?.title;
    return fields.length ? [{ title: typeof title === 'string' ? title.trim() : '', fields }] : [];
  });
  if (!tabs.length) throw new Error(`The catalog ${name} page layout lists no fields.`);
  return { tabs, labels };
}

/** The program and course page layouts every catalog page carries. */
export function catalogSettings(html: string): CatalogSettings {
  const settings = record(record(record(catalogPageData(html))?.pinia)?.settings);
  if (!settings) throw new Error('The catalog page data has no catalog settings.');
  return { program: pageLayout(settings.programPageTemplate, 'program'), course: pageLayout(settings.coursePageTemplate, 'course') };
}

/** Every department the catalog's department listing names, by the ID programs and courses cite. */
export function catalogDepartments(html: string): CatalogDepartment[] {
  const departments = new Map<string, string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 60) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const item = record(value);
    if (!item) return;
    if (typeof item.id === 'string' && typeof item.displayName === 'string' && item.displayName.trim()
      && record(item.customFields)?.educationInstitutionUnitType !== undefined) {
      const previous = departments.get(item.id);
      if (previous && previous !== item.displayName.trim()) throw new Error(`Conflicting catalog department ${item.id}.`);
      departments.set(item.id, item.displayName.trim());
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(catalogPageData(html), 0);
  if (!departments.size) throw new Error('The catalog department listing names no departments.');
  return [...departments].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
