#!/usr/bin/env bash
# Standalone read-only guard; usable even when the API is stopped.
set -Eeuo pipefail
set +x
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$ROOT"
WORK=''
trap '[[ -z "$WORK" ]] || rm -rf -- "$WORK"' EXIT
fail() {
  printf 'Database compatibility unavailable: %s. API must not be recreated.\n' "$1" >&2
  printf 'Manual read-only check: ./scripts/check-db-compatibility.sh\nSee docs/OPERATIONS.md for connection prerequisites and manual migration commands.\n' >&2
  exit 1
}
[[ $# -le 1 ]] || fail 'unexpected arguments'
for cmd in docker node timeout; do command -v "$cmd" >/dev/null || fail "required executable $cmd missing"; done
[[ -f .env.local && ! -L .env.local ]] || fail 'protected .env.local missing'
PERMISSIONS=$(stat -c '%a' .env.local)
(( (8#$PERMISSIONS & 077) == 0 )) || fail '.env.local requires chmod 600'
CONTAINER=${DEPLOY_POSTGRES_CONTAINER:-}
[[ -n "$CONTAINER" ]] || fail 'set DEPLOY_POSTGRES_CONTAINER to the existing database container'
[[ "$CONTAINER" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || fail 'invalid DEPLOY_POSTGRES_CONTAINER identifier'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/home-security-db-check.XXXXXXXX")
CONFIG=${1:-$WORK/config}
if [[ $# == 0 ]]; then
  timeout -k 1s 3s docker compose --project-name home-security --project-directory "$ROOT" --env-file "$ROOT/.env.local" -f "$ROOT/compose.local.yaml" --profile tools config --format json >"$CONFIG" 2>"$WORK/error" || fail 'Compose configuration could not be resolved within 3 seconds'
fi
# Inspect network identity only, never container Env or other credential metadata.
timeout -k 1s 3s docker inspect --format '{"name":{{json .Name}},"networks":{{json .NetworkSettings.Networks}}}' "$CONTAINER" >"$WORK/identity" 2>"$WORK/error" || fail 'existing PostgreSQL container unavailable or Docker inspection timed out'
node "$ROOT/scripts/database-compatibility.mjs" target "$CONFIG" "$WORK/identity" || fail 'database target verification failed'
node "$ROOT/scripts/database-compatibility.mjs" sql >"$WORK/query" 2>"$WORK/error" || fail 'read-only SQL helper unavailable'
# Use the existing server's local socket/user. Secrets remain inside that container.
# Server timeouts bound SQL/locks; outer timeout bounds Docker/psql, with kill grace.
timeout -k 1s 5s docker exec -i "$CONTAINER" sh -c 'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; exec psql -X --no-password --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --username="${POSTGRES_USER:-postgres}" --dbname=security_events' <"$WORK/query" >"$WORK/history" 2>"$WORK/error" || fail 'read-only SQL unavailable or timed out (5 seconds); check local psql, socket authentication, security_events and migration-history SELECT permission'
node "$ROOT/scripts/database-compatibility.mjs" history <"$WORK/history" || fail 'migration history incompatible or unreadable; apply reviewed migrations manually'
printf 'Database compatibility verified; no schema writes performed.\n'
