// Offline Compose/environment validation using a protected read-only snapshot.
// Does not start containers, contact upstream services or output resolved secrets.
import process from 'node:process';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parse } from 'dotenv';
import { loadConfig } from '../../dist/config.js';
import { notificationRuntime } from '../../dist/notifications/runtime.js';
import { productionOptions } from '../../web/edge-dist/server.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const base = resolve(root, 'runtime/coolify');
function secure(file) {
  assert.equal(realpathSync(file), file);
  assert.equal(statSync(file).mode & 0o077, 0);
  return readFileSync(file, 'utf8');
}
try {
  const last = readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map(entry => entry.name).sort().at(-1);
  assert(last, 'Run snapshot-environment.mjs first');
  const manifest = JSON.parse(secure(resolve(base, last, 'release.json')));
  const old = Object.fromEntries(Object.keys(manifest).map(role => [role,
    Object.fromEntries(secure(manifest[role].envFile).trimEnd().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }))]));
  const example = parse(readFileSync(resolve(root, 'deploy/coolify/environment.example')));
  const dashboard = parse(secure(resolve(root, '.env.dashboard.local')));
  const live = old.gateway ?? parse(secure(resolve(root, '.env.live.local')));
  const env = { ...process.env, ...example, ...old.api, ...old.receiver,
    ...Object.fromEntries(Object.entries(old.worker).filter(([key]) => key !== 'DATABASE_URL')),
    WORKER_DATABASE_URL: old.worker.DATABASE_URL, API_AI_MODEL: old.api.AI_MODEL,
    API_IMAGE: manifest.api.image, RECEIVER_IMAGE: manifest.receiver.image, WORKER_IMAGE: manifest.worker.image,
    DASHBOARD_PASSWORD: dashboard.DASHBOARD_PASSWORD, DASHBOARD_SESSION_KEY: dashboard.DASHBOARD_SESSION_KEY,
    SECURITY_GATEWAY_USER: dashboard.SECURITY_GATEWAY_USER, SECURITY_GATEWAY_PASSWORD: dashboard.SECURITY_GATEWAY_PASSWORD,
    NVR_C1_SUB_RTSP: live.NVR_C1_SUB_RTSP, NVR_C2_SUB_RTSP: live.NVR_C2_SUB_RTSP };
  const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.coolify.yaml',
    '--profile', 'capture', '--profile', 'notifications', 'config', '--format', 'json'],
  { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }));
  assert.deepEqual(Object.keys(config.services).sort(), ['api', 'dashboard', 'gateway', 'notification-worker', 'receiver']);
  for (const [role, service] of [['receiver','receiver'], ['worker','notification-worker']]) {
    const important = Object.keys(old[role]).filter(key => /^(AI_|NOTIFICATION_)/.test(key) ||
      ['DATABASE_URL','UNIVIEW_INSTALLATION_ID','UNIVIEW_CAMERA_MAP','UNIVIEW_MAX_ACTIVE_WINDOWS','UNIVIEW_MEMORY_BYTES','UNIVIEW_PROCESSING_TIMEOUT_MS','UNIVIEW_REQUEST_TIMEOUT_MS'].includes(key));
    for (const key of important) assert.equal(String(config.services[service].environment[key]), old[role][key], `${role}: ${key}`);
  }
  loadConfig(config.services.api.environment);
  loadConfig(config.services.receiver.environment);
  notificationRuntime(config.services['notification-worker'].environment);
  productionOptions(config.services.dashboard.environment);
  assert.deepEqual(config.services.receiver.profiles, ['capture']);
  assert.deepEqual(config.services['notification-worker'].profiles, ['notifications']);
  assert.deepEqual(config.services['notification-worker'].healthcheck.test, ['CMD', 'node', 'dist/notifications/worker-health.js']);
  assert.equal(config.services['notification-worker'].healthcheck.disable, undefined);
  assert.equal(config.services.dashboard.environment.SECURITY_GATEWAY_ORIGIN, 'http://gateway:1984');
  assert.deepEqual(Object.keys(config.services.gateway.networks), ['app']);
  assert.equal(config.services.gateway.ports, undefined);
  assert.equal(config.networks.coolify.external, true);
  assert.equal(config.networks.gateway, undefined);
  for (const role of ['api','receiver','notification-worker','gateway']) assert.equal(config.services[role].labels['traefik.enable'], 'false');
  process.stdout.write('PASS: five-role Compose, Zod/runtime configuration, existing database/network targets, exact receiver AI/worker cutoffs and keys, disabled-by-default role profiles. No services started.\n');
} catch {
  process.stderr.write('Preparation validation failed; resolved private configuration withheld. No services started.\n');
  process.exitCode = 1;
}
