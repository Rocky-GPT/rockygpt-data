/**
 * @module pipeline/development-reviewed-aliases
 * Apply the committed reviewed aliases to an existing release's identity artifacts.
 *
 * The identity registry and its coverage report are compiled together at publish time. A reviewed
 * alias that was approved after a release was published is missing from it. This applies exactly
 * those aliases with the compiler's own rule (`applyReviewedAliases`), keeps every alias's recorded
 * source, and changes nothing else: no identity, link or relationship is added or removed.
 */
import type { CampusIdentities } from '../src/data-v2/campus-identities';
import type { IdentityCoverageIssue, IdentityCoverageReport } from '../src/data-v2/compile-campus-identities';
import { aliasRecords, applyReviewedAliases, noteAlias, type AliasLedger, type ReviewedAlias } from '../src/data-v2/identity-aliases';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** The only database this tooling may write: a local copy named rockygpt_profiles_dev_*, with no
 * connection options in the URL (a `?host=` option would send pg to another machine). */
export function localDevelopmentTarget(value: string): { host: string; port: number; user: string; password?: string; database: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('The database must be a postgresql:// URL.'); }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('The database must be a postgresql:// URL.');
  if (url.search || url.hash) throw new Error('Refusing a database URL with connection options.');
  const hostname = url.hostname.toLowerCase();
  if (!LOOPBACK.includes(hostname)) throw new Error('Refusing a database that is not on this machine.');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^rockygpt_profiles_dev_[a-z0-9_]+$/.test(database)) throw new Error('Refusing a database whose name is not rockygpt_profiles_dev_*.');
  return { host: hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 5432, user: decodeURIComponent(url.username) || 'postgres', ...(url.password ? { password: decodeURIComponent(url.password) } : {}), database };
}

/** The same JSON whatever the key order (jsonb stores keys in its own order). */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item);

export interface AliasOverlay {
  registry: CampusIdentities;
  report: IdentityCoverageReport;
  /** The aliases this run added, as `entity: alias`. */
  added: string[];
  /** Reviewed aliases that could not be applied, and why. */
  unresolved: IdentityCoverageIssue[];
}

export function overlayReviewedAliases(registry: CampusIdentities, report: IdentityCoverageReport, reviewed: ReviewedAlias[]): AliasOverlay {
  const next: CampusIdentities = structuredClone(registry);
  const nextReport: IdentityCoverageReport = structuredClone(report);
  const ledger: AliasLedger = new Map();
  for (const record of nextReport.alias_sources) for (const source of record.sources) noteAlias(ledger, record.entity_id, record.alias, source);
  const had = new Set(next.entities.flatMap(entity => entity.aliases.map(alias => `${entity.id}\u0000${alias}`)));
  const { applied, unresolved } = applyReviewedAliases(next.entities, reviewed, ledger);
  for (const [key, sources] of ledger) {
    const seen = new Set<string>();
    ledger.set(key, sources.filter(source => !seen.has(canonical(source)) && seen.add(canonical(source))));
  }
  const known = new Set((nextReport.human_reviewed_aliases ?? []).map(alias => `${alias.entity_id}\u0000${alias.alias}`));
  nextReport.human_reviewed_aliases = [
    ...(nextReport.human_reviewed_aliases ?? []),
    ...applied.filter(alias => !known.has(`${alias.entity_id}\u0000${alias.alias}`)),
  ];
  nextReport.alias_sources = aliasRecords(next.entities, ledger);
  nextReport.unresolved = [...nextReport.unresolved, ...unresolved];
  return {
    registry: next,
    report: nextReport,
    added: applied.filter(alias => !had.has(`${alias.entity_id}\u0000${alias.alias}`)).map(alias => `${alias.entity}: ${alias.alias}`),
    unresolved,
  };
}
