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

Run the read-only HTTP service with `npm run dev` locally or `npm start` after
`npm run build`. Its contract is [`api/openapi.yaml`](api/openapi.yaml). This
package is private on purpose: the UI, brain, and native clients must use HTTP
instead of importing repository or ingestion source across application
boundaries.

Browser-shaped artifacts are staged under this repository's ignored `public/`
directory, published into PostgreSQL, and served through
`GET /v1/data/:artifact`. The pipeline never writes into a client repository.
