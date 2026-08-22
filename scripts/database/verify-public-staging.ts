import 'dotenv/config';
import { Pool } from 'pg';

type VerificationRow = {
  active_datasets: number;
  active_releases: number;
  matching_active_releases: number;
  sources: number;
  critical_facts: number;
  contacts: number;
  programs: number;
  documents: number;
  document_chunks: number;
  release_artifacts: number;
  legacy_feedback: number;
};

const MINIMUMS: ReadonlyArray<[keyof VerificationRow, number]> = [
  ['active_datasets', 1],
  ['active_releases', 1],
  ['matching_active_releases', 1],
  ['sources', 1],
  ['critical_facts', 1],
  ['contacts', 1],
  ['programs', 1],
  ['documents', 10],
  ['document_chunks', 10],
  ['release_artifacts', 1],
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await pool.query<VerificationRow>(
      `WITH active_dataset AS (
         SELECT id FROM rockygpt_v2.dataset_versions WHERE status = 'active'
       ), active_release AS (
         SELECT dataset_version_id FROM rockygpt_v2.releases WHERE status = 'active'
       )
       SELECT
         (SELECT count(*)::int FROM active_dataset) AS active_datasets,
         (SELECT count(*)::int FROM active_release) AS active_releases,
         (SELECT count(*)::int
            FROM active_release release
            JOIN active_dataset dataset ON dataset.id = release.dataset_version_id) AS matching_active_releases,
         (SELECT count(*)::int FROM rockygpt_v2.sources) AS sources,
         (SELECT count(*)::int FROM rockygpt_v2.critical_facts fact
            JOIN active_dataset dataset ON dataset.id = fact.dataset_version_id) AS critical_facts,
         (SELECT count(*)::int FROM rockygpt_v2.campus_contacts contact
            JOIN active_dataset dataset ON dataset.id = contact.dataset_version_id) AS contacts,
         (SELECT count(*)::int FROM rockygpt_v2.programs program
            JOIN active_dataset dataset ON dataset.id = program.dataset_version_id) AS programs,
         (SELECT count(*)::int FROM rockygpt_v2.documents document
            JOIN active_dataset dataset ON dataset.id = document.dataset_version_id) AS documents,
         (SELECT count(*)::int FROM rockygpt_v2.document_chunks chunk
            JOIN rockygpt_v2.documents document ON document.id = chunk.document_id
            JOIN active_dataset dataset ON dataset.id = document.dataset_version_id) AS document_chunks,
         (SELECT count(*)::int FROM rockygpt_v2.release_artifacts artifact
            JOIN active_dataset dataset ON dataset.id = artifact.dataset_version_id) AS release_artifacts,
         (SELECT count(*)::int FROM rockygpt_v2.feedback) AS legacy_feedback`
    );
    const row = result.rows[0];
    if (!row) throw new Error('Staging verification returned no result.');

    const errors = MINIMUMS.flatMap(([key, minimum]) =>
      row[key] < minimum ? [`${key} must be at least ${minimum}; found ${row[key]}.`] : []
    );
    if (row.active_datasets !== 1) errors.push(`Expected exactly one active dataset; found ${row.active_datasets}.`);
    if (row.active_releases !== 1) errors.push(`Expected exactly one active release; found ${row.active_releases}.`);
    if (row.legacy_feedback !== 0) {
      errors.push(`Legacy feedback must not be copied into staging; found ${row.legacy_feedback} rows.`);
    }
    if (errors.length > 0) throw new Error(`Staging database verification failed:\n- ${errors.join('\n- ')}`);

    console.log(JSON.stringify(row, null, 2));
    console.log('Staging public database verification passed.');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
