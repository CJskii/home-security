import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://test:unit-secret@db:5432/security', LOG_LEVEL: 'silent',
  DB_CHECK_TIMEOUT_MS: '30',
});

const instances: ReturnType<typeof buildApp>[] = [];
function setup(checkReady = vi.fn(async () => {})) {
  const database = { checkReady, disconnect: vi.fn(async () => {}) };
  const service = buildApp(config, database);
  instances.push(service);
  return { ...service, database };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map(({ app }) => app.close()));
});

describe('M1 HTTP contracts', () => {
  it('liveness does not query the database', async () => {
    const { app, database } = setup();
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(database.checkReady).not.toHaveBeenCalled();
  });

  it('reports ready only after a successful database check', async () => {
    const { app, database } = setup();
    const response = await app.inject('/ready');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    expect(database.checkReady).toHaveBeenCalledOnce();
  });

  it('returns a safe 503 when database or migration is unavailable', async () => {
    const { app, database } = setup(vi.fn(async () => { throw new Error('unit-secret SQL failed'); }));
    const response = await app.inject('/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready' });
    expect(response.body).not.toContain('unit-secret');
    database.checkReady.mockResolvedValueOnce();
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });

  it('bounds stalled probes and shares the in-flight check', async () => {
    let resolveCheck!: () => void;
    const { app, database } = setup(vi.fn(() => new Promise<void>((resolve) => { resolveCheck = resolve; })));
    const responses = await Promise.all([app.inject('/ready'), app.inject('/ready')]);
    expect(responses.map((response) => response.statusCode)).toEqual([503, 503]);
    expect(database.checkReady).toHaveBeenCalledOnce();
    resolveCheck();
  });

  it('is unready immediately when shutdown begins', async () => {
    const { app, markStopping, database } = setup();
    markStopping();
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect(database.checkReady).not.toHaveBeenCalled();
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('does not become ready if shutdown starts during a check', async () => {
    const service = setup();
    service.database.checkReady.mockImplementationOnce(async () => { service.markStopping(); });
    expect((await service.app.inject('/ready')).statusCode).toBe(503);
  });

  it('rejects unknown query parameters with Zod', async () => {
    const { app } = setup();
    const response = await app.inject('/health?secret=unit-secret');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid request' });
  });

  it('exposes no business routes', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/events', payload: {} })).statusCode).toBe(404);
    expect((await app.inject('/unknown?secret=unit-secret')).json()).toEqual({ error: 'Not found' });
  });

  it('disconnects exactly once on close', async () => {
    const { app, database } = setup();
    await app.ready();
    await app.close();
    await app.close();
    expect(database.disconnect).toHaveBeenCalledOnce();
  });

  it('returns generated request IDs and validated correlation IDs', async () => {
    const { app } = setup();
    const correlationId = '17B01E57-CC3D-4DB5-9BDD-F7D89E8149BB';
    const first = await app.inject({
      url: '/health', headers: { 'x-request-id': 'client-secret', 'x-correlation-id': correlationId },
    });
    expect(first.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.headers['x-correlation-id']).toBe(correlationId.toLowerCase());
    const second = await app.inject({ url: '/missing', headers: { 'x-correlation-id': 'private-person-details' } });
    expect(second.statusCode).toBe(404);
    expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
    expect(second.headers['x-correlation-id']).toBe(second.headers['x-request-id']);
  });

  it('contains unexpected handler exceptions', async () => {
    const { app } = setup();
    app.get('/test-failure', async () => { throw new Error('private-prompt-unit-secret'); });
    const response = await app.inject('/test-failure');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(response.headers['x-request-id']).toBeDefined();
    expect((await app.inject('/health')).statusCode).toBe(200);
  });
});
