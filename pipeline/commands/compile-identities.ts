/** Offline review: compile the same artifact the publisher installs against a
 * read-only exported snapshot. Never changes the database. */
import fs from 'node:fs';
import path from 'node:path';
import { catalogConvenersArtifact, compileCampusIdentities, type IdentitySnapshot } from '../../src/data-v2/compile-campus-identities';
import type { CampusIdentities } from '../../src/data-v2/campus-identities';

const [snapshotPath, outputPath, rawProgramsPath, rawClubsPath, rawEventDetailsPath] = process.argv.slice(2);
if (!snapshotPath || !outputPath) throw new Error('Usage: tsx pipeline/commands/compile-identities.ts SNAPSHOT_JSON OUTPUT_DIR [CATALOG_RAW_JSON] [CLUBS_RAW_JSON] [EVENT_DETAILS_RAW_JSON]');
const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
const seed = read('src/reference/campus-identities.json') as CampusIdentities;
const rawPrograms = rawProgramsPath ? read(rawProgramsPath) : undefined;
const result = compileCampusIdentities(seed, read(snapshotPath) as IdentitySnapshot, rawPrograms, { clubs: rawClubsPath ? read(rawClubsPath) : undefined, eventDetails: rawEventDetailsPath ? read(rawEventDetailsPath) : undefined });
fs.mkdirSync(outputPath, { recursive: true });
fs.writeFileSync(path.join(outputPath, 'campus-identities.json'), JSON.stringify(result.registry, null, 2) + '\n');
fs.writeFileSync(path.join(outputPath, 'campus-identity-coverage.json'), JSON.stringify(result.report, null, 2) + '\n');
fs.writeFileSync(path.join(outputPath, 'catalog-conveners.json'), JSON.stringify(catalogConvenersArtifact(rawPrograms), null, 2) + '\n');
fs.writeFileSync(path.join(outputPath, 'event-organizers.json'), JSON.stringify(result.eventOrganizers, null, 2) + '\n');
console.log(JSON.stringify({ ...result.report, unresolved: result.report.unresolved.length }, null, 2));
