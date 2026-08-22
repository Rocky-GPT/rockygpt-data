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

Browser-shaped artifacts are staged under this repository's ignored `public/`
directory, published into PostgreSQL, and served through
`GET /v1/data/:artifact`. The pipeline never writes into a client repository.
