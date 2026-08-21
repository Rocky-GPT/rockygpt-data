import 'dotenv/config';
import { restoreActiveRelease } from '../restore-active-release';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requireRawArtifacts = args.includes('--require-raw');
  const unknown = args.filter((arg) => arg !== '--require-raw');
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);

  const summary = await restoreActiveRelease({ requireRawArtifacts });
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
