import type { DeliveryStore } from '../src/notifications/destination.js';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildDevelopmentApp } from '../src/dashboard/development.js';
import { developmentDeliveryClient } from '../src/dashboard/development-delivery.js';
import { loadConfig } from '../src/config.js';
import { samplePayload } from '../src/notifications/sample-payload.js';
import { DeliveryConfigurationError } from '../src/notifications/destination-contract.js';
const installation = '10000000-0000-4000-8000-000000000001', id = '10000000-0000-4000-8000-000000000002', origin = 'http://127.0.0.1:5173', config = loadConfig({ DATABASE_URL: 'postgresql://test:secret@invalid/security', UNIVIEW_INSTALLATION_ID: installation, EVENTS_TOKEN: 'e'.repeat(32), DASHBOARD_ORIGIN: origin, DASHBOARD_PASSWORD: 'p'.repeat(32), DASHBOARD_SESSION_KEY: 'a'.repeat(64), LOG_LEVEL: 'silent' }), at = '2026-10-21T12:00:00.000Z';
const pin = { url: 'http://192.168.50.20:8123/api/webhook/home-security', address: '192.168.50.20', allowLanHttp: true }, settings = { available: true, writable: true, revision: 0, updatedAt: null, configured: pin, secretConfigured: true, approved: [pin], globalDeliveryEnabled: false, producerEnabled: false, automaticDeliveryAvailable: false as const, tests: [] }, preview = { payload: samplePayload(id, installation, new Date(at), origin), body: '{}', confirmation: 'opaque', expiresAt: at, destination: pin.url, headers: {}, revision: 0 }, outcome = { id, state: 'FAILED' as const, at, httpStatus: 401, code: 'authentication_rejected', durationMs: 10, receipt: 'rejected', mayHaveReached: true };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const a of apps.splice(0))
    await a.app.close(); });
function setup(development = false) { const store = { read: vi.fn(async () => settings), save: vi.fn(async () => settings), preview: vi.fn(async () => preview), test: vi.fn<DeliveryStore['test']>(async () => outcome) }, db = { notificationDelivery: store, historicalImages: { load: async () => null, save: async () => true }, checkReady: async () => { }, disconnect: async () => { } }, service = development ? buildDevelopmentApp({ ...config, EVENTS_TOKEN: undefined }, db) : buildApp(config, db); apps.push(service); return { app: service.app, store }; }
const routes = [['PUT', '/api/notifications/delivery/settings', { expectedRevision: 0, url: pin.url, signingSecret: 's'.repeat(48), acknowledgeHttp: true }], ['POST', '/api/notifications/delivery/preview', {}], ['POST', '/api/notifications/delivery/test', { confirmation: 'opaque', confirmed: true }]] as const;
it('authenticates every action and requires matching session Origin/CSRF checks for save, preview and explicit test', async () => {
    const { app, store } = setup();
    expect((await app.inject('/api/notifications/delivery/settings')).statusCode).toBe(401);
    for (const [method, url, payload] of routes)
        expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { password: config.DASHBOARD_PASSWORD } }), cookie = login.headers['set-cookie'] as string;
    for (const headers of [{ cookie }, { cookie, origin: 'https://bad.example' }, { cookie, origin, 'sec-fetch-site': 'cross-site' }])
        for (const [method, url, payload] of routes)
            expect([401, 403]).toContain((await app.inject({ method, url, headers, payload })).statusCode);
    expect(store.test).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    for (const [method, url, payload] of routes)
        expect((await app.inject({ method, url, headers: { cookie, origin }, payload })).statusCode).toBe(200);
    expect(store.test).toHaveBeenCalledTimes(1);
    expect(store.test.mock.calls[0]?.[0]).toBe(installation);
});
it('rejects absent confirmation and attempts to arm live sending or change pins via browser payloads', async () => {
    const { app, store } = setup(), headers = { authorization: 'Bearer ' + 'e'.repeat(32) };
    for (const payload of [{ confirmation: 'opaque' }, { confirmation: 'opaque', confirmed: false }, { confirmation: 'opaque', confirmed: true, deliveryEnabled: true }])
        expect((await app.inject({ method: 'POST', url: '/api/notifications/delivery/test', headers, payload })).statusCode).toBe(400);
    for (const extra of [{ producerEnabled: true }, { address: '192.168.50.1' }, { disableTlsVerification: true }])
        expect((await app.inject({ method: 'PUT', url: '/api/notifications/delivery/settings', headers, payload: { ...routes[0][2], ...extra } })).statusCode).toBe(400);
    expect(store.test).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    store.test.mockRejectedValueOnce(new DeliveryConfigurationError(409, 'destination_changed_preview_again'));
    expect((await app.inject({ method: 'POST', url: '/api/notifications/delivery/test', headers, payload: routes[2][2] })).json()).toEqual({ error: 'destination_changed_preview_again' });
});
it('allows only fixed delivery operations in session-authenticated LAN development, not arbitrary writes', async () => {
    const { app } = setup(true), login = await app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { password: config.DASHBOARD_PASSWORD } }), cookie = login.headers['set-cookie'] as string;
    for (const [method, url, payload] of routes)
        expect((await app.inject({ method, url, payload, headers: { cookie, origin } })).statusCode).toBe(200);
});
it('forwards credentials only to fixed loopback API, validates masked responses and preserves sanitized failures', async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => Response.json(options?.method === 'PUT' ? settings : outcome)), bridge = developmentDeliveryClient(config, 'e'.repeat(32), request)!;
    await bridge.save(installation, routes[0][2]);
    await bridge.test(installation, 'opaque');
    expect(request.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:3000/api/notifications/delivery/settings', 'http://127.0.0.1:3000/api/notifications/delivery/test']);
    expect(request.mock.calls[1]?.[1]?.redirect).toBe('error');
    expect(request.mock.calls[1]?.[1]?.headers).toHaveProperty('authorization', 'Bearer ' + 'e'.repeat(32));
    await expect(bridge.read(id)).rejects.toThrow('Unknown delivery scope');
    request.mockResolvedValueOnce(Response.json({ error: 'test_rate_limit_one_per_minute' }, { status: 429 }));
    await expect(bridge.test(installation, 'opaque')).rejects.toMatchObject({ status: 429, code: 'test_rate_limit_one_per_minute' });
    expect(developmentDeliveryClient(config, undefined, request)).toBeUndefined();
});
