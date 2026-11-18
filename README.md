# rockygpt-data

Campus data for RockyGPT: the repository layer the brain reads through, the
scrapers that collect from Ramapo sources, the publication pipeline, and the
artifacts they produce.

Nothing here knows about the web app or the answering engine. This is the
bottom of the dependency graph.

## Layout

    src/         repository layer, schemas, Postgres access, static data
    ingestion/   per-source scrapers
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

Contacts that are flagged for source review are never silently corrected or
merged. `npm run check:contacts` prints each captured contact's evidence (fields
withheld, extra contacts, absences) through the same builder the publisher uses.

## Campus opening intervals

`src/data-v2/opening-hours.ts` converts full source schedules into `hours` arrays
with `open`/`close` clocks in `HH:MM` format. Split intervals keep their gaps;
next-day closings have `close_day_offset: 1`. An empty array means explicitly
closed. Missing, ambiguous, overlapping, or partially parsed text stays NULL
(unknown), never closed. Original `schedule` text and effective dates are retained.

This describes weekly hours; it does not verify holiday exceptions or establish
that a weekly schedule applies to a given date.

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

## Page check

`npm run check:pages` asks Jev, TypeSafe's classifier, what kind of page each
published office and school site page is. Pages it calls a test copy, a past event,
out of date, a placeholder, about named students, a faculty list, "page not found"
or a login page are listed in `data/review/page-check.md` for a person to review.
Nothing is left out automatically: a page stays published until its line is added to
`skippedPages` in `src/reference/office-sites.json` or `academic-sites.json`. A flag
the person rejects goes in that list's `keptPages`, and the check skips those pages.

```sh
npm run check:pages -- --site berriecenter --dry-run   # count and cost, sends nothing
npm run check:pages -- --site berriecenter             # needs TYPESAFE_API_KEY in .env
```

Only new pages, changed pages and verdicts 30 days old are sent, about $0.0001 a page.
Past verdicts stay in `data/review/page-check-verdicts.json`. Without `TYPESAFE_API_KEY`
nothing is sent, and a run stops before spending more than `--max-usd` (default $1).
The daily refresh runs it after publishing and keeps the list in a "[Page check] Pages
to review" issue once the `TYPESAFE_API_KEY` repository secret is set.

## How-to tasks

`ingestion/howto-entries.ts` has gpt-6-luna read each office page (the office sites and
the catalog's academic policies) and list its how-to tasks, each step quoted from the
page. Publish checks every quote against the page and stores the tasks in
`office_sections.howto_entries`, which the Brain reads.

A page is read once, and again only when its own words or the reading instructions
change. Measured on 2026-11-10: about $0.00066 a page, about $1.70 for all 2,552 pages,
and 0 to about 35 changed pages a night (a few cents). The readings are kept between
runs in the file store under `raw/howto-entries/` (`pipeline/howto-store.ts`).

- The daily refresh restores the readings, reads the new and changed pages, and archives
  the result. A run stops sending before it could spend more than `HOWTO_MAX_USD`
  (repository variable, default $0.50); the pages left over wait for the next run.
- A dev build restores the readings and never calls the model.
- The first read of every page is a one-off: run Daily Data Update by hand with
  `howto_read_all` on and `howto_max_usd` raised. Until then a scheduled run reads
  nothing.
- A publish that would leave under half of the live release's pages with tasks is stopped
  (a dev build only warns). That happens when the readings could not be restored, or
  when most pages wait to be read again after a change to the reading instructions:
  run Daily Data Update by hand with `howto_max_usd` raised.

The "Measure how-to page reads" workflow counts the pages that changed between archived
captures and can read a small sample to re-measure the cost; it keeps no reading.

```sh
# The key is passed for the run only, never read from .env.
HOWTO_OPENAI_API_KEY=… DOTENV_CONFIG_PATH=/dev/null npx tsx ingestion/howto-entries.ts --limit 20 --spread --max-usd 0.10
```

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

The local HTTP server that used to live in `api/` (the retired `/v1` and `/v2`
contract, and the dev site's data-explorer pages) was removed on 2026-11-17 with
the rest of the code the nightly job never loads. Git keeps it.

This package stays private on purpose: nothing should import repository or
ingestion source across application boundaries.

Browser-shaped artifacts are staged under this repository's ignored `public/`
directory and published into PostgreSQL. The pipeline never writes into a
client repository.
