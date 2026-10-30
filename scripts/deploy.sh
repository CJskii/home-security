#!/usr/bin/env bash
set -Eeuo pipefail
# Never enable xtrace: Compose, migrations and metrics may handle credentials.
set +x
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$ROOT"
MODE=full
case "${1:-}" in
  '') ;;
  --quick) MODE=quick ;;
  --check) MODE=check ;;
  --status) MODE=status ;;
  *) printf 'Usage: %s [--quick|--check|--status]\n' "$0" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { printf 'Only one mode is permitted.\n' >&2; exit 2; }
STEP=initialisation
WORK=''
PREVIOUS='none'
cleanup() { [[ -z "$WORK" ]] || rm -rf -- "$WORK"; }
failed() {
  local code=$1
  trap - ERR
  # ERR is inherited by command substitutions: only the parent reports failure.
  [[ "$BASHPID" == "$$" ]] || exit "$code"
  printf 'Deployment failed at step: %s (exit %s).\n' "$STEP" "$code" >&2
  printf 'Previous API image: %s. No automatic rollback performed.\n' "$PREVIOUS" >&2
  exit "$code"
}
trap cleanup EXIT
trap 'failed "$?"' ERR
trap 'STEP="interrupted ($STEP)"; failed 130' INT
trap 'STEP="terminated ($STEP)"; failed 143' TERM
say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; failed 1; }
compose() { docker compose --project-name home-security --project-directory "$ROOT" --env-file "$ROOT/.env.local" -f "$ROOT/compose.local.yaml" --profile tools "$@"; }
helper() { node "$ROOT/scripts/deploy-diagnostics.mjs" "$@"; }
STEP=preflight
# Status does not need Compose, .env.local, npm, tsx, Zod, Node 24 or a build.
for cmd in docker curl; do command -v "$cmd" >/dev/null || fail "Preflight executable $cmd missing; install it or fix PATH."; done
WORK=$(mktemp -d "${TMPDIR:-/tmp}/home-security-deploy.XXXXXXXX")
docker info >"$WORK/output" 2>&1 || fail 'Docker daemon unavailable or access denied; check Docker service and operator permissions.'
NODE_AVAILABLE=false
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' >"$WORK/output" 2>&1; then NODE_AVAILABLE=true; fi
if [[ "$MODE" != status ]]; then
  HEALTH_TIMEOUT=${DEPLOY_HEALTH_TIMEOUT_SECONDS:-120}
  for value in "$HEALTH_TIMEOUT"; do
    [[ "$value" =~ ^[1-9][0-9]{0,2}$ ]] && (( value <= 600 )) || fail 'Deployment timeouts must be whole seconds in 1..600.'
  done
  for cmd in node npm git flock timeout; do command -v "$cmd" >/dev/null || fail "Preflight executable $cmd missing; install it or fix PATH."; done
  [[ -f .env.local && ! -L .env.local ]] || fail '.env.local must be a protected regular file.'
  [[ -f compose.local.yaml ]] || fail 'Compose file missing; restore compose.local.yaml.'
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || fail 'Preflight Node runtime: Node 24 required for configuration validation/deployment. Select Node 24 with nvm use 24 or fix PATH; --status can run independently.'
  PERMISSIONS=$(stat -c '%a' .env.local)
  (( (8#$PERMISSIONS & 077) == 0 )) || fail '.env.local must not be readable/writable by group or others (use chmod 600).'
  node --import tsx --input-type=module -e 'await import("zod")' >"$WORK/output" 2>&1 || fail 'Preflight TypeScript dependencies: tsx/Zod could not load. Run npm ci under Node 24; source helpers do not require compiled dist files.'
  if [[ "$MODE" == full || "$MODE" == quick ]]; then
    mkdir -p runtime/deploy
    exec 9>runtime/deploy/deploy.lock
    flock -n 9 || fail 'Another deployment holds the repository lock.'
  fi
  docker compose version >"$WORK/output" 2>&1 || fail 'Docker Compose v2 unavailable; install the Docker Compose plugin.'
  for network in coolify infrastructure-net; do
    docker network inspect "$network" >"$WORK/output" 2>&1 || fail "Required external network missing: $network; review the existing infrastructure networks."
  done
  compose config --format json >"$WORK/config" 2>"$WORK/output" || fail 'Compose configuration invalid; review compose.local.yaml and protected environment syntax. Raw output withheld.'
  STEP='preflight Compose/application helper'
  # Conditional assignment handles errors once in the parent; helper errors are safe.
  if ! FLAGS=$(node --import tsx "$ROOT/scripts/deploy-tools.ts" config <"$WORK/config" 2>"$WORK/helper-error"); then
    cat "$WORK/helper-error" >&2
    fail 'Compose/application validation failed; follow the component-specific remedy above.'
  fi
  [[ "$FLAGS" == valid ]] || fail 'Application configuration validation failed.'
  STEP=preflight
  REVISION=$(git rev-parse HEAD)
  DIRTY=$(git status --porcelain)
  say "Git revision: $REVISION"
  [[ -z "$DIRTY" ]] || say 'Notice: working tree has changes; the build includes those changes.'
  say 'Preflight passed: Docker, Compose, private environment, networks and application configuration.'
  if [[ "$MODE" == check ]]; then
    say 'Read-only check complete. Database/migration status is checked only during deployment.'
    exit 0
  fi
fi
inspect_api() { docker inspect --format "$1" home-security-api 2>"$WORK/output"; }
check_networks() {
  local networks
  networks=$(inspect_api '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}') || return 1
  grep -Fxq coolify <<<"$networks" && grep -Fxq infrastructure-net <<<"$networks"
}
probe_host() {
  local endpoint=$1 expected=$2
  curl --noproxy '*' --silent --fail --connect-timeout 2 --max-time 5 "http://127.0.0.1:3000/$endpoint" >"$WORK/probe" 2>"$WORK/output" || return 1
  # Response bodies are never echoed. Match the implemented probe contract.
  if [[ "$NODE_AVAILABLE" == true ]]; then
    helper probe "$expected" <"$WORK/probe"
  else
    # HTTP success remains useful without a host-side JSON parser.
    say "Host /$endpoint: HTTP success (JSON validation unavailable; install Node >=18)."
  fi
}
read_logs() { docker logs --tail 500 home-security-api >"$WORK/logs" 2>&1; }
if [[ "$MODE" == status ]]; then
  STEP=status
  if command -v git >/dev/null && REVISION=$(git rev-parse HEAD 2>"$WORK/output"); then say "Checkout Git revision: $REVISION"; else say 'Checkout Git revision unavailable (install Git or use a Git checkout).'; fi
  STATE=$(inspect_api '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}') || fail 'API container not found.'
  IMAGE=$(inspect_api '{{.Image}}')
  say "API state/health: $STATE"
  say "Deployed image: $IMAGE"
  say "Previous image record: runtime/deploy/previous-image.txt (if a deployment has run)."
  STATUS_OK=true
  [[ "$STATE" == "running healthy" ]] || STATUS_OK=false
  if check_networks; then say 'API networks: coolify and infrastructure-net present.'; else say 'API networks: required attachment missing.'; STATUS_OK=false; fi
  if probe_host health ok; then say 'Host /health: ok'; else say 'Host /health: failed'; STATUS_OK=false; fi
  if probe_host ready ready; then say 'Host /ready: ready'; else say 'Host /ready: failed'; STATUS_OK=false; fi
  read_logs || fail 'Cannot read API logs.'
  say 'Recent allowlisted application state/outcome/error entries (other logs omitted):'
  if [[ "$NODE_AVAILABLE" == true ]]; then
    helper logs <"$WORK/logs"
  else
    say 'Log summary unavailable: install Node >=18. Raw logs withheld; container/probe status remains available.'
  fi
  [[ "$STATUS_OK" == true ]] || fail 'Status reports API degradation.'
  exit 0
fi
if [[ "$MODE" == full ]]; then
  STEP='local validation (npm run check)'
  say 'Running Prisma validation/generation, lint, strict typecheck, tests and production build.'
  # Same cwd/PATH/environment as manual npm, but retain the protective umask.
  # Capture both streams privately; preserve npm's status and report once.
  if npm run check >"$WORK/validation" 2>&1; then
    say 'Local validation passed.'
  else
    VALIDATION_CODE=$?
    helper validation <"$WORK/validation" >&2 || printf 'Validation diagnostic parser unavailable; reproduce with (umask 077; npm run check) under Node 24.\n' >&2
    failed "$VALIDATION_CODE"
  fi
fi
STEP='image build'
say 'Building Security API image.'
compose build api >"$WORK/output" 2>&1 || fail 'Image build failed; raw output withheld.'
STEP='previous image preservation'
if PREVIOUS=$(inspect_api '{{.Image}}'); then
  [[ "$PREVIOUS" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Unexpected API image identifier.'
  RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  # A unique tag retains the old image when the Compose build tag is replaced.
  PREVIOUS_TAG="home-security-api-previous:$RELEASE"
  docker image tag "$PREVIOUS" "$PREVIOUS_TAG" >"$WORK/output" 2>&1 || fail 'Could not preserve previous API image.'
  printf 'image=%s\ntag=%s\nrevision=%s\n' "$PREVIOUS" "$PREVIOUS_TAG" "$REVISION" >"runtime/deploy/previous-$RELEASE.txt"
  cp "runtime/deploy/previous-$RELEASE.txt" runtime/deploy/previous-image.txt
  say "Previous image retained: $PREVIOUS ($PREVIOUS_TAG)"
else
  PREVIOUS=none
  # Distinguish an absent container from a Docker inspect/daemon failure.
  docker container ls -a --filter name=^/home-security-api$ --format '{{.ID}}' >"$WORK/containers" 2>"$WORK/output" || fail 'Cannot inspect existing API.'
  [[ ! -s "$WORK/containers" ]] || fail 'Existing API could not be inspected.'
fi
STEP='database compatibility guard'
# Existing PostgreSQL only: no migration job, Prisma status or schema writes.
"$ROOT/scripts/check-db-compatibility.sh" "$WORK/config" || fail 'Compatibility guard blocked API recreation. Run ./scripts/check-db-compatibility.sh; see docs/OPERATIONS.md for manual migrations.'
STEP='API recreation'
compose up -d --no-deps --force-recreate --no-build api >"$WORK/output" 2>&1 || fail 'API recreation failed.'
STEP='Docker health and host verification'
DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  STATE=$(inspect_api '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}') || fail 'API container missing after recreation.'
  [[ "$STATE" == 'running healthy' ]] && break
  [[ "$STATE" != *no-healthcheck* && "$STATE" != exited* && "$STATE" != dead* ]] || fail 'API exited or has no Docker healthcheck.'
  (( SECONDS < DEADLINE )) || fail "Timed out waiting for Docker health ($HEALTH_TIMEOUT seconds)."
  sleep 2
done
probe_host health ok || fail 'Host /health verification failed.'
probe_host ready ready || fail 'Host /ready verification failed.'
STEP='API network verification'
check_networks || fail 'API is not attached to both required external networks.'
IMAGE=$(inspect_api '{{.Image}}')
say "Deployment verified. Git revision: $REVISION; API image: $IMAGE"
say 'Only the Security API was built/recreated; database compatibility was checked read-only. No automatic rollback.'
