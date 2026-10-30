# Operations

## Runtime layout

The production Compose file, `compose.coolify.yaml`, runs five roles: API, receiver,
notification worker, static React dashboard edge and a private go2rtc gateway.
PostgreSQL, Ollama and Traefik are external resources. Configure their addresses
and networks in protected environment settings using `deploy/coolify/environment.example`.

`compose.local.yaml` is the host-managed deployment/recovery option. Use
`docker-compose.dev.yml` for an isolated disposable database. Do not attach that
database to an existing production installation.

## Environment and secrets

Use `.env.example` for development and `deploy/coolify/environment.example` for
production. Filled files must have mode 600 and remain outside Git and build contexts.
Never pass secrets through `VITE_*` or Docker build arguments.

Key production settings:

| Settings | Purpose |
|---|---|
| `DATABASE_URL`, `WORKER_DATABASE_URL` | Existing application and restricted worker database logins |
| `UNIVIEW_INSTALLATION_ID`, `UNIVIEW_CAMERA_MAP` | Stable installation/channel identities |
| `UNIVIEW_NVR_IP`, `UNIVIEW_USERNAME`, `UNIVIEW_PASSWORD` | Server-side NVR access |
| `API_IMAGE`, `RECEIVER_IMAGE`, `WORKER_IMAGE` | Verified local image tags or immutable image IDs |
| `DASHBOARD_HOST`, `LAN_IP`, `DASHBOARD_ALLOWED_CIDRS` | Domain, bind address and trusted client networks |
| `COOLIFY_NETWORK`, `INFRASTRUCTURE_NETWORK` | Existing Docker networks |
| `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_KEY`, `EVENTS_TOKEN` | Separate browser/session and service credentials |
| `CAMERA_SYNC_TOKEN` | API-to-receiver refresh authorization |
| `AI_*` | Ollama model, enablement, historical cutoff and timeout |
| `AI_ZONE_SELECTION_ENABLED` | Receiver-side activation of saved AI zone selection |
| `NOTIFICATION_*` | Sender switches, cutoffs, destination pinning, encryption and signed-media keys |
| `HA_HISTORY_TOKEN` | Scoped read-only Home Assistant summary/history access |
| `SECURITY_GATEWAY_*`, `NVR_C1_SUB_RTSP`, `NVR_C2_SUB_RTSP` | Private gateway authentication and H.264 sources |

Generate a separate session/media/encryption key with `openssl rand -hex 32` and
separate random credentials for each token. Preserve existing keys, installation
identities, live cutoffs and saved policies when upgrading an installation.

Operator-only preparation variables are documented in `.env.example`:
`DEPLOY_POSTGRES_CONTAINER`, `DEPLOY_DATABASE_HOST`, `HA_CONFIG_ROOT` and the
`NODE_RED_*` flow/recipient identifiers. Export these when running their scripts;
they are not browser settings. Configure operator Coolify credentials privately.

## Database and migration workflow

Migrations run as an explicit release operation, never application startup. Back up
PostgreSQL before a migration and rehearse the pending migration on an isolated
restore. Check table counts, constraints, representative reads, old-role compatibility
and index/lock behavior before applying it to production.

The compatibility guard compares every checked-in migration checksum against the
selected database's migration history in a bounded read-only transaction:

```sh
export DEPLOY_POSTGRES_CONTAINER='<existing-postgres-container>'
./scripts/check-db-compatibility.sh
```

The guard uses protected `.env.local` and `compose.local.yaml` to verify the target.
Pass a protected resolved Compose JSON file as its optional argument for another
layout. Keep that JSON private because Compose interpolation includes credentials.

For a reviewed pending migration, build the explicit migrations target and run it
on the existing database network with a protected env file:

```sh
docker build --target migrations -t home-security-migrations:release .
docker run --rm --network '<database-network>' --env-file .env.local home-security-migrations:release
```

Coordinate application-role stops when a migration is incompatible with running
code. Retain database backups and historical migration files; recovery must account
for writes committed after a backup.

## Build and Coolify deployment

Build backend images from the reviewed release and record their immutable IDs:

```sh
docker build --target runtime -t home-security-backend:release .
```

Set `API_IMAGE`, `RECEIVER_IMAGE` and `WORKER_IMAGE` to the reviewed images for each
role. Existing installations may keep different role revisions during targeted
fixes. Keep their role images and rollback tags in a private release manifest.

The existing build command prepares the dashboard and gateway:

```sh
bash scripts/build-coolify.sh
```

Set Coolify's raw Compose source to `compose.coolify.yaml`. Its start command is:

```sh
docker compose --project-name home-security-coolify -f compose.coolify.yaml --env-file .env --project-directory . --profile capture --profile notifications up -d --no-build --pull never
```

Receiver and worker have explicit `capture` and `notifications` profiles. During a
cutover, stop the previous receiver/worker owners before starting their replacements.
Keep the NVR push listener address/port and notification activation cutoffs stable.
Enable automatic deployment only after that ownership transition has been verified.

`deploy/coolify/snapshot-environment.mjs` makes a new protected role-environment
snapshot without changing services. Set `DEPLOY_DATABASE_HOST` to the expected
existing host first. `validate-preparation.mjs` validates the snapshot and Compose
configuration offline after backend and edge builds. Set domain, LAN allowlist and
network variables explicitly; examples do not supply an installation's routing.

### Routing and health

The dashboard edge serves static Vite assets and proxies same-origin `/api/*` and
restricted live WebSockets. Traefik routes `https://security.example.com` using the
configured host, infrastructure network and client CIDR allowlist. API/receiver/
worker/gateway have no public Traefik routers. API port 3000 is limited to loopback
and the configured LAN address for HA and signed media; receiver uses LAN port 18080.
PostgreSQL and the gateway have no published ports.

API/receiver have HTTP health probes. The worker's healthcheck observes a successful
local work-loop heartbeat, with a 180-second deadline. The gateway has an authenticated
local stream-list probe. Verify each container's health, restart policy and single
ownership after release.

### Targeted changes and rollback

Back up the materialized Coolify Compose file, runtime environment, role image IDs
and container configuration before changing a role. For an API-only fix, replace
only its image and use `up -d --no-deps --no-build --pull never api`. Verify all other
container IDs and start times are unchanged. Apply the same approach to dashboard-only
changes. Preserve the receiver, worker policies, credentials and cutoffs.

Rollback restores the affected role's previous image and environment, then recreates
that role only. Restore the corresponding materialized Compose and Coolify settings
so a later deployment cannot reapply the failed configuration. Keep backup copies
outside Git. Do not run `compose down -v` or reset the production schema.

The optional `deploy/api/Dockerfile.media` and
`deploy/notifications/Dockerfile.health` support one-module overlays on an existing
verified base image. Supply the intended base image explicitly and compare untouched
modules before using an overlay. Full release builds use the root Dockerfile.

## NVR configuration and geometry

The single receiver owner synchronizes names, stream metadata and EnterArea polygons
at startup and every 600 seconds. Manual refresh goes through the authenticated API
to that owner. Multi-vertex polygons are versioned; unchanged settings do not create
new versions. A failed read retains the previous verified configuration.

Local zone preferences use stable camera/channel/slot identity. Keep local names,
interest, AI selection and notification selection independent. Use source rectangles
and original scene anchors for geometric membership. Historical evaluation requires
the appropriate stored version; ambiguous/missing geometry remains explicit.

Immediate notifications can use the bounded latest-confirmed-geometry path. It does
not query the NVR on every event. Gallery historical attribution currently uses the
stricter observation bracket and may show unknown locations for events newer than
the last successful observation. Inspect sync status before changing zone data.

## Notifications and media

Delivery, producer activation and the worker are separate switches. New installations
start disabled. Set an explicit live start cutoff before enabling production delivery,
so historical events cannot be replayed. AI enrichment has its own switch/cutoff and
uses the same Android tag without another cooldown or sound.

Configure an exact destination allowlist with pinned address and URL. Private HTTP
is allowed only for an explicitly approved LAN destination. Keep TLS verification
for HTTPS. Reuse the versioned payload, HMAC signature/timestamp headers and receipt
contract in `src/notifications/`. Node-RED must preserve its durable idempotency journal
across restarts. Back up flows/revision and preserve the separate credential recovery
path before modifying a flow.

Set `NODE_RED_HOME_SECURITY_FLOW_ID` and the primary/previous/secondary phone service
variables before using `scripts/node-red-live-flow.ts`. Preparation functions do not
deploy flows. Existing installations retain their deployed flow/environment names
until a separately reviewed flow update; source-template changes never rename live
Home Assistant entities.

Signed media URLs are event-specific and expiring. The renderer retrieves and verifies
original NVR media, then produces the focused/full-frame annotated derivative in RAM.
An unavailable image leaves the text alert usable. No notification image archive is
created. Delivery history distinguishes webhook receipts, errors, uncertain attempts,
cooldown suppressions and rule exclusions.

## Home Assistant templates

`integrations/home-assistant/` contains integration examples and optional dashboard
preparation tools. Replace example camera/person/zone names with your own local values.
Set `HA_CONFIG_ROOT` to the protected live mirror root before running preparation
scripts. Prepare diffs outside that root; validate YAML and the full HA configuration
before applying reviewed changes. Keep a timestamped backup and return an SSHFS mirror
to read-only after edits.

Store `home_security_history_authorization`, `home_security_summary_url`,
`home_security_zone_history_url_template` and `home_security_event_url_template` in HA's
server-side `secrets.yaml`. The last two are complete URL templates using the query
variables shown in the integration snippets. Never put service credentials in Lovelace
or frontend JavaScript. The REST integration uses the scoped `HA_HISTORY_TOKEN`.

## Public release preparation

Run gitleaks against a tracked-file export and the complete intended publication
history. Scan addresses, entity identifiers, household names and infrastructure IDs
separately: credential scanners do not detect all of these. Private runtime evidence,
backups, filled environments and generated builds stay ignored.

When a repository has a private operational history, prepare an independently scanned
clean-root release snapshot and publish only that reviewed branch after approval.
Keep the original history private for recovery. Do not publish old branches/tags,
force-push, change repository visibility or rotate live credentials as a side effect
of a documentation cleanup.
