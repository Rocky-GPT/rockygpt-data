import { assertQualityV2, validateCurrentDatasetV2 } from '../quality/validate';

// The release's must-have facts are checked on the built graph (.github/scripts/graph_check.py):
// the hand-typed list that stood here still required a spring 2026 date in November 2026.
if (process.argv[1]?.endsWith('check-quality.ts')) {
  try {
    const summary = validateCurrentDatasetV2();
    assertQualityV2(summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
