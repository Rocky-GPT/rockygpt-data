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
when `NODE_ENV=development` — which is why `run-local.sh` sets it. Its contract
is [`api/openapi.yaml`](api/openapi.yaml).

This package stays private on purpose: nothing should import repository or
ingestion source across application boundaries.

Browser-shaped artifacts are staged under this repository's ignored `public/`
directory and published into PostgreSQL. The pipeline never writes into a
client repository.

Hybrid clients use the additive typed endpoints
`POST /v2/capabilities/shuttle/query` and `POST /v2/retrieve`, plus structured
searches for menus, events, campus/dining hours, and courses under `/v1/search`.
DATA, rather than the caller, owns repository matching, dataset identity, and
public source records. Retrieved document text is explicitly marked
`contentTrust: "untrusted"`.

Shuttle entity misses are distinct from an authoritative empty time window:
unknown route/stop constraints use `no_match` with `entity_no_match`, while no
remaining or currently active service uses `empty` with `no_remaining` or
`not_current`. A `current/at_time` query checks only its service date and, when
needed, the immediately prior date for a cross-midnight trip; the response
lists both under `appliedFilters.serviceDatesConsidered`.
