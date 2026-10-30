import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';

// Compose config only: no Docker daemon, network, database or container access.
function compose(overrides: Record<string, string> = {}) {
  const example = parse(readFileSync('deploy/coolify/environment.example'));
  return spawnSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.coolify.yaml', '--profile', 'capture', '--profile', 'notifications', 'config', '--format', 'json'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...example,
      LAN_IP: '192.168.50.90', DASHBOARD_ALLOWED_CIDRS: '192.168.50.0/24,127.0.0.1/32',
      COOLIFY_NETWORK: 'installation-database', INFRASTRUCTURE_NETWORK: 'installation-proxy',
      AI_ENABLEMENT_CUTOFF: '2026-01-01T00:00:00Z', NOTIFICATION_ACTIVATED_AT: '2026-01-01T00:00:00Z',
      NOTIFICATION_AI_UPDATES_FROM: '2026-01-01T00:00:00Z', ...overrides },
  });
}
it('resolves installation-specific routing from operator variables without enabling delivery', () => {
  const result = compose(); expect(result.status).toBe(0);
  const config = JSON.parse(result.stdout);
  expect(config.networks.coolify.name).toBe('installation-database');
  expect(config.networks.infrastructure.name).toBe('installation-proxy');
  expect(config.services.dashboard.labels['traefik.docker.network']).toBe('installation-proxy');
  expect(config.services.dashboard.labels['traefik.http.middlewares.home-security-lan.ipallowlist.sourcerange']).toBe('192.168.50.0/24,127.0.0.1/32');
  expect(config.services.receiver.ports[0].host_ip).toBe('192.168.50.90');
  const worker = config.services['notification-worker'].environment;
  expect(String(worker.NOTIFICATION_WORKER_ENABLED)).toBe('false');
  expect(String(worker.NOTIFICATION_DELIVERY_ENABLED)).toBe('false');
  expect(config.services.gateway.ports).toBeUndefined();
});
it.each(['LAN_IP', 'DASHBOARD_ALLOWED_CIDRS'])('refuses a missing %s instead of applying another installation default', (key) => {
  const result = compose({ [key]: '' }); expect(result.status).not.toBe(0); expect(result.stderr).toContain(key);
});
