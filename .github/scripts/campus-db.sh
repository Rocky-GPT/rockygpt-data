#!/usr/bin/env bash
# The daily job's campus database: a Postgres inside the runner, carried from one production run
# to the next as one dump in the file store (campus-db/ in the raw-archive bucket). The job reads
# and writes no campus table in Neon; Neon keeps only the Brain's ledger, feedback and chat logs.
#
#   campus-db.sh start          start the job's database (127.0.0.1:5432, database campus)
#   campus-db.sh load           load production's newest dump from the file store, if there is one
#                               (writes loaded=true|false to $GITHUB_OUTPUT)
#   campus-db.sh dump FILE      dump the campus schema to FILE
#   campus-db.sh restore FILE   load a dump made by `dump`
#   campus-db.sh save           dump the database, upload it, then move the pointer to it, and keep
#                               the newest $CAMPUS_DB_KEEP dumps (production only)
#
# The file store settings come from BUCKET, ENDPOINT and the AWS_* key variables, as in the plan job.
set -euo pipefail

PREFIX="${CAMPUS_DB_PREFIX:-campus-db/}"
KEEP="${CAMPUS_DB_KEEP:-7}"
POINTER="active.json"

s3() { aws s3 "$@" --endpoint-url "${ENDPOINT:?ENDPOINT is required}" --only-show-errors; }
sql() { docker exec campus-db psql -v ON_ERROR_STOP=1 -tAq -U postgres -d campus -c "$1"; }

dump() {
  docker exec campus-db pg_dump -U postgres -d campus -Fc --schema=rockygpt_v2 --no-owner \
    --no-privileges > "$1"
}

restore() {
  docker exec -i campus-db pg_restore -U postgres -d campus --no-owner --no-privileges \
    --exit-on-error < "$1"
}

case "${1:-}" in
  start)
    docker run -d --name campus-db -e POSTGRES_PASSWORD=job-build -e POSTGRES_DB=campus \
      -p 127.0.0.1:5432:5432 postgres:17 >/dev/null
    # The image first runs a setup server on the socket only, then restarts. Wait on TCP, which
    # only the final server listens on, so the checks below never meet the restart.
    for _ in $(seq 60); do
      docker exec campus-db pg_isready -h 127.0.0.1 -U postgres -d campus -q && break
      sleep 1
    done
    docker exec campus-db pg_isready -h 127.0.0.1 -U postgres -d campus
    # The campus schema's one extension lives outside the dumped schema.
    sql 'CREATE EXTENSION IF NOT EXISTS pgcrypto'
    ;;

  load)
    if ! s3 cp "s3://${BUCKET:?}/${PREFIX}${POINTER}" campus-db-active.json 2>/dev/null; then
      echo "No campus database in the file store yet (${PREFIX}${POINTER}); this run starts the chain."
      echo loaded=false >> "${GITHUB_OUTPUT:-/dev/null}"
      exit 0
    fi
    file="$(jq -er .file campus-db-active.json)"
    s3 cp "s3://$BUCKET/${PREFIX}${file}" campus.dump
    want="$(jq -er .sha256 campus-db-active.json)"
    got="$(sha256sum campus.dump | cut -d' ' -f1)"
    if [[ "$want" != "$got" ]]; then
      echo "${PREFIX}${file} does not match its pointer's sha256." >&2
      exit 1
    fi
    restore campus.dump
    echo "Loaded $(jq -r .dataset_version campus-db-active.json) from ${PREFIX}${file} ($(du -h campus.dump | cut -f1))."
    echo loaded=true >> "${GITHUB_OUTPUT:-/dev/null}"
    ;;

  dump)
    dump "${2:?dump FILE}"
    ls -lh "$2"
    ;;

  restore)
    restore "${2:?restore FILE}"
    ;;

  save)
    version="$(sql "SELECT version FROM rockygpt_v2.dataset_versions WHERE status = 'active'")"
    if [[ -z "$version" ]]; then
      echo "The job's database has no active release; nothing is saved." >&2
      exit 1
    fi
    file="campus-${version}-run${GITHUB_RUN_ID:-local}.dump"
    dump "$file"
    sha="$(sha256sum "$file" | cut -d' ' -f1)"
    bytes="$(stat -c %s "$file")"
    s3 cp "$file" "s3://${BUCKET:?}/${PREFIX}${file}"
    jq -n --arg file "$file" --arg version "$version" --arg sha "$sha" --argjson bytes "$bytes" \
      --arg run "${RUN_URL:-}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{file: $file, dataset_version: $version, sha256: $sha, bytes: $bytes, run: $run, saved_at: $at}' \
      > campus-db-active.json
    # The pointer last: a run that stops before this line leaves the last good dump in charge.
    s3 cp campus-db-active.json "s3://$BUCKET/${PREFIX}${POINTER}"
    echo "Saved ${version} as ${PREFIX}${file} ($(du -h "$file" | cut -f1))."
    # Names start with the dataset version (v2-YYYYMMDDhhmmss), so name order is age order.
    aws s3 ls "s3://$BUCKET/${PREFIX}" --endpoint-url "$ENDPOINT" | awk '{print $4}' \
      | grep -E '^campus-.*\.dump$' | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
        [[ "$old" == "$file" ]] && continue
        s3 rm "s3://$BUCKET/${PREFIX}${old}" && echo "Removed old dump ${old}."
      done
    ;;

  *)
    echo "usage: $0 start | load | dump FILE | restore FILE | save" >&2
    exit 2
    ;;
esac
