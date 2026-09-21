# rockygpt-data

Campus data for RockyGPT: the repository layer the brain reads through, the
scrapers that collect from Ramapo sources, the publication pipeline, and the
artifacts they produce.

Nothing here knows about the web app or the answering engine. This is the
bottom of the dependency graph.

## Layout

    src/         repository layer, schemas, Postgres access, static data
    ingestion/   per-source scrapers and the markdown generators
    pipeline/    validation, quality gates, and publication
    scripts/     database maintenance and one-off utilities
    data/        the artifacts themselves (mostly gitignored, rebuilt)

## Running

    npm install
    cp .env.example .env      # set DATABASE_URL
    npm run data:bootstrap    # restore the active release
    npm run data:quality      # gates that must pass before publishing

Scripts resolve paths against this repository root, so run them from here.

## Contact normalization

`src/directory/contact-normalizer.ts` owns the meaning and formatting of contact
fields. The publisher uses it for every new release: `title` is the supplied role,
`department` is the supplied organizational unit, and `offices` is an array.
Only explicit retirement markers set `status: retired`; an absent marker does not
establish active employment. Existing phone entries keep their numbers, labels,
extensions, and contact preferences.

To preview or update an existing active release using `DATABASE_URL` from `.env`:

```sh
npm run normalize:contacts -- --report /tmp/contact-review.json
npm run normalize:contacts -- --apply --backup /tmp/contacts-before.json --report /tmp/contact-review.json
```

The default is read-only. Applying requires a new backup file, applies migration
018, and updates only the active release in one transaction. IDs and contact
methods remain unchanged. A second preview should report zero changed records.
Original strings and review flags live in `normalization_metadata`; source and
collection timestamps remain ingestion metadata, separate from the clean export.
Shared numbers involving retired people, missing contact methods, unfinished
titles, and unusual trailing name accents are flagged for source review, never
silently corrected or merged.

## Campus opening intervals

`src/data-v2/opening-hours.ts` converts full source schedules into `hours` arrays
with `open`/`close` clocks in `HH:MM` format. Split intervals keep their gaps;
next-day closings have `close_day_offset: 1`. An empty array means explicitly
closed. Missing, ambiguous, overlapping, or partially parsed text stays NULL
(unknown), never closed. Original `schedule` text and effective dates are retained.

```sh
npm run normalize:campus-hours -- --report /tmp/campus-hours-review.json
npm run normalize:campus-hours -- --apply --backup /tmp/campus-hours-before.json --report /tmp/campus-hours-review.json
```

The default is read-only; applying migration 019 and backfilling the active
release requires a new backup file and happens in one transaction. It preserves
IDs, facility/day rows, source schedules, timestamps, and validity bounds. Future
publication uses the same parser. This describes weekly hours; it does not verify
holiday exceptions or establish that a weekly schedule applies to a given date.

## Campus identity links

`src/reference/campus-identities.json` assigns persistent UUIDs to curated campus
identities and links them to existing records by collection, source key, and
source record key. The publisher validates it and stores it as the
`campus-identities` artifact in every new dataset release. The Brain's
`lookup_profile` tool reads that artifact and the linked records from the same
release. No schema migration or record consolidation is needed.

CSI is the first entry. Its contact link matches the directory's published key;
its seven schedule links match the existing campus-hours keys. The CSI schedule
does not distinguish staff, desk, or facility availability. The collector's note
says it includes Roadrunner Central, J. Lee's, and the Women's Center; linking it
does not establish phone-answering hours for any of them. The identity artifact
contains no copied contact facts, schedules, or invented verification dates.

To add another verified entity, assign a UUID once, add its published name and
verified aliases, and list its exact source record keys. Preserve the UUID through
renames, and update aliases/links after reviewing changed source keys; never
regenerate the UUID from a name or a release's row IDs. Shared aliases deliberately
remain ambiguous. The same source record cannot belong to multiple identities:
sharing a location or schedule is a relationship, not proof of shared identity.
Missing linked records are handled as unavailable information at retrieval, not
silently rematched by name. Older releases without this artifact continue serving
existing tools; profile lookup reports unavailable until a new release includes it.

## Service boundary

**This repository no longer runs a deployed service.** Ingestion and
publication are what it is for: scrapers collect, the pipeline validates, and
`npm run data:publish` writes the result into PostgreSQL. Nothing here is
deployed, and no client reaches this package over HTTP in production.

The brain reads the published dataset straight from PostgreSQL and serves the
campus reads the web app used to take from here. The Render service that
answered `/v1/...` was deleted on 2026-08-28 once those endpoints reached
parity, and its blueprint was removed with it so applying one cannot bring it
back. Restoring it would mean writing a new blueprint deliberately.

The HTTP server in `api/` stays for local development only. It backs the web
app's `/ids`, `/data-explorer` and collector-status pages, which read further
into the database than the brain exposes, and it registers those routes only
when `NODE_ENV=development`. Its contract is
[`api/openapi.yaml`](api/openapi.yaml).

**Nothing starts it for you.** `run-local.sh` brings up the brain and the web
app only, so those three pages report that they cannot connect until you run
`npm run dev` here as well, on :8100. Whether that gap is worth closing or the
pages are worth retiring is an open question — until it is answered, this
server is the only reason the `api/` directory exists.

This package stays private on purpose: nothing should import repository or
ingestion source across application boundaries.

Browser-shaped artifacts are staged under this repository's ignored `public/`
directory and published into PostgreSQL. The pipeline never writes into a
client repository.

The rest of the surface — `POST /v2/capabilities/shuttle/query`,
`POST /v2/retrieve`, and the structured `/v1/search` routes for menus, events,
campus and dining hours, and courses — is the retired public contract. It still
runs when this server is started, and the `rockygpt-evals` suites still read
their expected values from it, but no deployed client reaches any of it. The
behaviour below is recorded for whoever decides what happens to that surface.

DATA, rather than the caller, owned repository matching, dataset identity, and
public source records. Retrieved document text is explicitly marked
`contentTrust: "untrusted"`.

Shuttle entity misses are distinct from an authoritative empty time window:
unknown route/stop constraints use `no_match` with `entity_no_match`, while no
remaining or currently active service uses `empty` with `no_remaining` or
`not_current`. A `current/at_time` query checks only its service date and, when
needed, the immediately prior date for a cross-midnight trip; the response
lists both under `appliedFilters.serviceDatesConsidered`.
