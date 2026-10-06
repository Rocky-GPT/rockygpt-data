/**
 * Isolated development step: apply the committed reviewed aliases to the active release of a LOCAL
 * database, by rewriting its identity registry and coverage report together.
 *
 * Run it on a copy (pg_dump into a new database), never on a shared database. It refuses any host
 * that is not loopback, any URL with connection options, and any database not named
 * rockygpt_profiles_dev_*. Without --apply it prints what would change and rolls back. It never
 * activates a release, so the old database stays as the rollback. See
 * docs/development-office-refresh.md.
 *
 *   tsx pipeline/commands/apply-reviewed-aliases-development.ts \
 *     --database postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_NEW [--apply]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Client } from 'pg';
import type { CampusIdentities } from '../../src/data-v2/campus-identities';
import type { IdentityCoverageReport } from '../../src/data-v2/compile-campus-identities';
import type { ReviewedAlias } from '../../src/data-v2/identity-aliases';
import { localDevelopmentTarget, overlayReviewedAliases } from '../development-reviewed-aliases';

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const url = arg('--database');
if (!url) throw new Error('Usage: --database postgresql://postgres@127.0.0.1:PORT/rockygpt_profiles_dev_NAME [--apply]');
const target = localDevelopmentTarget(url);

const reviewed = (JSON.parse(fs.readFileSync('src/reference/campus-identity-reviews.json', 'utf8')) as { aliases: ReviewedAlias[] }).aliases;
const sha = (content: string) => crypto.createHash('sha256').update(content).digest('hex');

async function main(): Promise<void> {
  const client = new Client(target);
  await client.connect();
  try {
    await client.query('BEGIN');
    const active = await client.query<{ id: string; version: string }>("SELECT id::text, version FROM rockygpt_v2.dataset_versions WHERE status = 'active'");
    if (active.rows.length !== 1) throw new Error(`Expected exactly one active release, found ${active.rows.length}.`);
    const { id: datasetId, version } = active.rows[0];
    const rows = await client.query<{ artifact_key: string; payload: unknown; content_hash: string }>(
      "SELECT artifact_key, payload, content_hash FROM rockygpt_v2.release_artifacts WHERE dataset_version_id = $1::uuid AND artifact_key IN ('campus-identities','campus-identity-coverage') FOR UPDATE", [datasetId]);
    const byKey = new Map(rows.rows.map(row => [row.artifact_key, row]));
    const registry = byKey.get('campus-identities'), coverage = byKey.get('campus-identity-coverage');
    if (!registry || !coverage) throw new Error('The active release has no identity registry or coverage report.');
    const overlay = overlayReviewedAliases(registry.payload as CampusIdentities, coverage.payload as IdentityCoverageReport, reviewed);
    const registryJson = JSON.stringify(overlay.registry), reportJson = JSON.stringify(overlay.report);
    const summary = { database: target.database, version, added: overlay.added, unresolved: overlay.unresolved.map(issue => issue.reason),
      identityHash: { before: registry.content_hash, after: sha(registryJson) }, applied: false };
    if (overlay.added.length > 0 && process.argv.includes('--apply')) {
      for (const [key, content] of [['campus-identities', registryJson], ['campus-identity-coverage', reportJson]] as const) {
        await client.query('UPDATE rockygpt_v2.release_artifacts SET payload = $3::jsonb, content_hash = $4 WHERE dataset_version_id = $1::uuid AND artifact_key = $2',
          [datasetId, key, content, sha(content)]);
      }
      summary.applied = true;
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
void main();
