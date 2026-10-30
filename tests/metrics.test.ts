import { afterEach, describe, expect, it, vi } from 'vitest';
import { Registry } from '@prometheus-io/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const token = 'a'.repeat(64);
const headers = { authorization: `Bearer ${token}` };
const instances: ReturnType<typeof buildApp>[] = [];
function setup(checkReady = vi.fn(async () => {}), enabled = true) {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:unit-secret@invalid/security',
    NODE_ENV: 'production', LOG_LEVEL: 'silent', SERVICE_NAME: 'security-test',
    METRICS_ENABLED: String(enabled), METRICS_TOKEN: enabled ? token : '',
    DB_CHECK_TIMEOUT_MS: '30',
  });
  const database = { checkReady, disconnect: vi.fn(async () => {}) };
  const service = buildApp(config, database);
  instances.push(service);
  return { ...service, database };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(instances.splice(0).map(({ app }) => app.close()));
});

describe('metrics endpoint', () => {
  it('has no route by default, even with authorization', async () => {
    const { app, database } = setup(undefined, false);
    expect((await app.inject({ url: '/metrics', headers })).statusCode).toBe(404);
    expect(database.checkReady).not.toHaveBeenCalled();
  });

  it.each([
    undefined, 'Bearer wrong', `Bearer ${'b'.repeat(64)}`, `Basic ${token}`,
    `Bearer ${token} extra`, `Bearer ${token.slice(0, -1)}`, 'Bearer ' + 'a'.repeat(257),
  ])('rejects missing, wrong, or malformed credentials before checking DB', async (authorization) => {
    const { app, database } = setup();
    const response = await app.inject({
      url: '/metrics', headers: authorization === undefined ? {} : { authorization },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="metrics"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ error: 'Unauthorized' });
    expect(database.checkReady).not.toHaveBeenCalled();
  });

  it('does not accept token query parameters or spoofed internal headers', async () => {
    const { app, database } = setup();
    const response = await app.inject({
      url: `/metrics?token=${token}`,
      headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    });
    expect(response.statusCode).toBe(401);
    expect(database.checkReady).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/metrics?token=not-supported', headers })).statusCode).toBe(400);
  });

  it('serves prefixed Prometheus output with request and process metrics', async () => {
    const { app } = setup();
    await app.inject('/health');
    await app.inject('/health');
    const response = await app.inject({ url: '/metrics', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.body).toMatch(/security_http_requests_total\{[^\n]*method="GET"[^\n]*route="\/health"[^\n]*status_code="200"[^\n]*\} 2/);
    expect(response.body).toMatch(/security_http_request_duration_seconds_count\{[^\n]*route="\/health"[^\n]*\} 2/);
    expect(response.body).toContain('security_http_request_duration_seconds_bucket');
    expect(response.body).toContain('security_process_cpu_seconds_total');
    expect(response.body).toContain('security_process_resident_memory_bytes');
    expect(response.body).toContain('security_nodejs_heap_size_used_bytes');
    expect(response.body).toContain('service="security-test",environment="production"');
    expect(response.body).toMatch(/security_database_ready\{[^\n]*\} 1/);
    expect(response.body).toMatch(/security_database_readiness_last_check_timestamp_seconds\{[^\n]*\} [1-9]/);
    expect(response.body).not.toContain(token);
    for (const line of response.body.split('\n').filter((line) => line && !line.startsWith('#'))) {
      expect(line).toMatch(/^security_/);
    }
  });

  it('keeps labels bounded for unmatched paths and unsupported methods', async () => {
    const { app } = setup();
    for (let i = 0; i < 20; i++) {
      await app.inject(`/unknown/camera-person-${i}?trackingId=private-${i}`);
    }
    await app.inject({ method: 'PROPFIND', url: '/another-private-path' });
    const response = await app.inject({ url: '/metrics', headers });
    expect(response.body).not.toContain('camera-person');
    expect(response.body).not.toContain('trackingId');
    expect(response.body).not.toContain('private-');
    expect(response.body).not.toContain('PROPFIND');
    expect(response.body).toMatch(/security_http_requests_total\{[^\n]*method="GET"[^\n]*route="unmatched"[^\n]*status_code="404"[^\n]*\} 20/);
    expect(response.body).toContain('method="OTHER"');
  });

  it('keeps metric registries isolated across app instances', async () => {
    const first = setup();
    const second = setup();
    await first.app.inject('/health');
    const response = await second.app.inject({ url: '/metrics', headers });
    expect(response.body).not.toContain('route="/health"');
  });

  it('reports dependency failure while keeping liveness and metrics available, then recovers', async () => {
    const { app, database } = setup(vi.fn(async () => { throw new Error('unit-secret in driver error'); }));
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(503);
    const failed = await app.inject({ url: '/metrics', headers });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toMatch(/security_database_ready\{[^\n]*\} 0/);
    expect(failed.body).toMatch(/security_http_requests_total\{[^\n]*route="\/ready"[^\n]*status_code="503"[^\n]*\} 1/);
    expect(failed.body).not.toContain('unit-secret');
    database.checkReady.mockResolvedValueOnce();
    const recovered = await app.inject({ url: '/metrics', headers });
    expect(recovered.body).toMatch(/security_database_ready\{[^\n]*\} 1/);
  });

  it('shares and bounds stalled readiness checks between health probes and scrapes', async () => {
    let resolveCheck!: () => void;
    const { app, database } = setup(vi.fn(() => new Promise<void>((resolve) => { resolveCheck = resolve; })));
    const [ready, scrape] = await Promise.all([
      app.inject('/ready'), app.inject({ url: '/metrics', headers }),
    ]);
    expect(ready.statusCode).toBe(503);
    expect(scrape.statusCode).toBe(200);
    expect(scrape.body).toMatch(/security_database_ready\{[^\n]*\} 0/);
    expect(database.checkReady).toHaveBeenCalledOnce();
    resolveCheck();
  });

  it('never reports database ready after shutdown is marked', async () => {
    const { app, markStopping, database } = setup();
    expect((await app.inject('/ready')).statusCode).toBe(200);
    markStopping();
    const response = await app.inject({ url: '/metrics', headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/security_database_ready\{[^\n]*\} 0/);
    expect(database.checkReady).toHaveBeenCalledOnce();
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('contains collector errors without exposing secrets', async () => {
    const { app } = setup();
    vi.spyOn(Registry.prototype, 'metrics').mockRejectedValueOnce(new Error('private-prompt-unit-secret'));
    const response = await app.inject({ url: '/metrics', headers });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect((await app.inject('/health')).statusCode).toBe(200);
  });
});
