# Isolated development office refresh

This narrow workflow prepares public office contact evidence for the Brain's
office slice. It does not refresh the whole campus dataset or publish production.
Do not run `data:publish` for this task: that command rebuilds and activates a full
release using the configured database and storage.

From the Data repository, capture every supporting page named in the reviewed
directory into a new folder (no credentials or database connection required):

```bash
node_modules/.bin/tsx pipeline/commands/capture-development-offices.ts \
  --out-directory /private/tmp/rocky-office-capture-NEW
```

The collector keeps original HTML, hashes, parsed sections and actual fetch
timestamps. A failed capture remains available for inspection. Use a new folder
for the next attempt; never overwrite an earlier capture.

Stage a separate local database using an explicit loopback owner connection:

```bash
node_modules/.bin/tsx pipeline/commands/stage-development-offices.ts \
  --source-url postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_SOURCE \
  --candidate rockygpt_profiles_dev_offices_NEW \
  --version dev-offices-NEW \
  --capture-directory /private/tmp/rocky-office-capture-NEW \
  --report /private/tmp/rocky-office-candidate-NEW.json
```

Replace the example names with new development identifiers. The source database
must have a unique active publication and no other sessions when PostgreSQL
clones it. This command never disconnects existing sessions, replaces a database,
activates a release, uses a production connection, or writes to object storage.

It replays captured HTML, checks the exact published contact values and structured
projections against their cited sections, and copies the existing release with
new row IDs while preserving canonical entity IDs and remapping original-record
pins. Unrelated values and capture times must remain unchanged.

Verification is per field. The original row's `collected_at` remains unchanged.
Only freshly supported `email`, `phones`, and `offices` receive
`normalization_metadata.contact_observations`. Each entry binds its full raw
projection hash to captured page timestamps, sections and HTML hashes and to a
same-release evidence artifact. No new observation is inferred for labels,
preferences, notes, missing values or unrelated source data. The Brain's shared
entity-fact reader validates this contract and preserves the original observation.

Before using the candidate, review the staging report and provenance, verify all
canonical office links through the shared fact reader, and keep the original
database as rollback. Activation is a separate local operation; staging alone
does not change any consumer's configured database. Freeze a factual oracle and
runtime before running the prospective chat suite. Successful HTTP responses do
not by themselves establish useful or grounded answers.

This is a development validation workflow. Production still needs a reviewed
source-scoped publication/rollback process; this helper is not that process.

## October 1, 2026 evidence

The [first candidate report](audits/2026-10-01-office-candidate-rejected.json) is
preserved with its [rejection](audits/2026-10-01-office-candidate-rejection.json):
renewing a whole record incorrectly refreshed labels that had not been observed.
That candidate release is marked failed and was never activated.

The [corrected staging report](audits/2026-10-01-office-candidate-v2.json) records
50 freshly checked pages, unchanged original row capture times, 40 email, 47 phone
and 31 location observations across 50 directory contacts. A full phone backed only
by an extension remains unverified; its independently supported location is fresh.
All 34 canonical offices have exact linked records and at least one fresh contact
field. Their coverage is 28 emails, 33 phones and 25 locations; missing values
remain unknown. Unrelated rows and original metadata are unchanged. This report
describes staging; a later evaluation may activate only this isolated candidate.
