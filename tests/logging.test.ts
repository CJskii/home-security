import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { eventContextLogger, loggerOptions } from '../src/logging.js';

it('emits JSON logs without credentials, error details or request query strings', async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) {
    lines.push(String(chunk));
    callback();
  } });
  const config = loadConfig({ DATABASE_URL: 'postgresql://test:unit-secret@db/security' });
  const app = Fastify({ logger: { ...loggerOptions(config), stream } });
  app.get('/health', async () => ({ status: 'ok' }));
  try {
    app.log.error({
      err: new Error('unit-secret'), DATABASE_URL: config.DATABASE_URL,
      password: 'unit-secret', authorization: 'unit-secret', cookie: 'unit-secret',
    }, 'Safe error');
    await app.inject({
      url: '/health?token=unit-secret',
      headers: { authorization: 'Bearer unit-secret', cookie: 'unit-secret' },
    });
    const output = lines.join('');
    expect(output).not.toContain('unit-secret');
    const entries = output.trim().split('\n').map((line) => JSON.parse(line) as { msg: string; level: number });
    expect(entries.some((entry) => entry.msg === 'Safe error' && entry.level === 50)).toBe(true);
    expect(entries.some((entry) => entry.msg === 'incoming request')).toBe(true);
  } finally {
    await app.close();
  }
});

it('redacts nested credentials, tokens, bodies, media and prompts in production JSON', () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) {
    lines.push(String(chunk)); callback();
  } });
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:unit-secret@invalid/security',
    NODE_ENV: 'production', SERVICE_NAME: 'security-test',
  });
  const logger = pino(loggerOptions(config), stream);
  logger.info({
    NOTIFICATION_CREDENTIAL_KEY:'unit-secret', signingSecret:'unit-secret', deliverySecret:'unit-secret', confirmation:'unit-secret', CAMERA_SYNC_TOKEN:'unit-secret', METRICS_TOKEN: 'unit-secret', access_token: 'unit-secret', apiKey: 'unit-secret',
    credentials: { user: 'unit-secret', password: 'unit-secret' },
    context: { token: 'unit-secret', nested: { refreshToken: 'unit-secret' } },
    body: { person: 'unit-secret' }, payload: { anything: 'unit-secret' },
    prompt: 'unit-secret', imageUrl: 'unit-secret', selectedPayload: 'unit-secret',
    req: { method: 'GET', routeOptions: { url: '/health' }, url: 'unit-secret', headers: { authorization: 'unit-secret' }, body: 'unit-secret' },
    res: { statusCode: 200, headers: { 'set-cookie': 'unit-secret' }, body: 'unit-secret' },
    err: new Error('unit-secret'),
  }, 'Safe diagnostic');
  expect(lines.join('')).not.toContain('unit-secret');
  const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  expect(entry.service).toBe('security-test');
  expect(entry.environment).toBe('production');
  expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(entry.METRICS_TOKEN).toBe('[REDACTED]');
  expect(entry.body).toBe('[REDACTED]');
});

it('honors configurable logging levels', () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) {
    lines.push(String(chunk)); callback();
  } });
  const logger = pino(loggerOptions(loadConfig({
    DATABASE_URL: 'postgresql://test:unit-secret@invalid/security', LOG_LEVEL: 'warn',
  })), stream);
  logger.info('Suppressed');
  logger.warn('Recorded');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('Recorded');
});

it('adds validated event context without accepting a payload object', () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) {
    lines.push(String(chunk)); callback();
  } });
  const logger = pino(loggerOptions(loadConfig({ DATABASE_URL: 'postgresql://test:unit-secret@invalid/security' })), stream);
  const eventId = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
  const correlationId = '6671fd89-38ba-4a6e-a76b-50f376321a60';
  eventContextLogger(logger.child({ reqId: 'request-1' }), { eventId, correlationId }).info('Future event context');
  const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  expect(entry).toMatchObject({ eventId, correlationId, reqId: 'request-1' });
  expect(() => eventContextLogger(logger, { eventId: 'unit-secret', correlationId })).toThrow('Invalid event log context');
});

it('includes correlation in automatic and error request logs without exposing metrics credentials', async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) {
    lines.push(String(chunk)); callback();
  } });
  const token = 'a'.repeat(64);
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:unit-secret@invalid/security', NODE_ENV: 'production',
    METRICS_ENABLED: 'true', METRICS_TOKEN: token,
  });
  const { app } = buildApp(config, {
    checkReady: vi.fn(async () => { throw new Error('unit-secret database failure'); }),
    disconnect: vi.fn(async () => {}),
  }, pino(loggerOptions(config), stream));
  const correlationId = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
  try {
    const response = await app.inject({
      url: '/ready', headers: { 'x-correlation-id': correlationId, authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    const entries = lines.join('').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const requestEntries = entries.filter((entry) => entry.reqId === response.headers['x-request-id']);
    expect(requestEntries.length).toBeGreaterThanOrEqual(3);
    expect(requestEntries.every((entry) => entry.correlationId === correlationId)).toBe(true);
    expect(requestEntries.some((entry) => entry.errorCode === 'DATABASE_NOT_READY')).toBe(true);
    await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${'b'.repeat(64)}`, 'x-correlation-id': 'unit-secret' } });
    expect(lines.join('')).not.toContain('unit-secret');
    expect(lines.join('')).not.toContain(token);
    expect(lines.join('')).not.toContain('b'.repeat(64));
  } finally {
    await app.close();
  }
});

it('redacts AI origins, bearer credentials and structured personal observations', () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const logger = pino(loggerOptions(loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security' })), stream);
  logger.info({ OLLAMA_BEARER_TOKEN: 'private-value',
    OLLAMA_BASE_URL: 'private-value',
    shortDescription: 'private-value', detailedDescription: 'private-value', people: ['private-value'],
    context: { vehicles: ['private-value'], uncertainties: ['private-value'], supplementary: { personal: 'private-value' } },
  }, 'Safe diagnostic');
  expect(lines.join('')).not.toContain('private-value');
});
