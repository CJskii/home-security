import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { webhookTarget, webhookSignature, createWebhookSender } from '../src/notifications/webhook.js';
import type { WebhookPayload } from '../src/notifications/delivery-contract.js';
import { id } from './helpers/notification-ledger.js';
const secret = 'a'.repeat(48), servers: Server[] = [];
const payload: WebhookPayload = { version: 1, type: 'security.event', notificationId: id(1), eventId: id(2), idempotencyKey: 'notification:v1:' + id(3) + ':' + id(2), camera: { channel: 1, name: 'Camera 1' }, timestamps: { receivedAt: '2026-10-21T12:00:00.000Z', occurredAt: null }, rules: [{ id: id(4), name: 'Driveway people', reason: 'source_category_and_zone' }], objects: [{ id: id(5), category: 'PERSON', zoneIds: [id(6)], zoneVersionIds: [id(7)], basis: 'stored_geometry_projection', locationReason: 'anchor_consensus', uncertain: false }], ai: { status: 'skipped', revision: null, summary: null }, images: [], dashboardUrl: 'https://dashboard.example/explore?event=' + id(2) };
async function receiver(handler: (req: IncomingMessage, res: ServerResponse) => void) { const server = createServer(handler); servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string')
    throw Error('Missing test port'); return 'http://127.0.0.1:' + address.port + '/notification'; }
function target(url: string, extra: Partial<Parameters<typeof webhookTarget>[0]> = {}) { return webhookTarget({ url, address: '127.0.0.1', secret, allowLanHttp: true, ...extra }, true); }
const receipt = (res: ServerResponse, outcome = 'accepted', retryable = false, notificationId = payload.notificationId) => res.end(JSON.stringify({ version: 1, notificationId, outcome, retryable }));
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
it('authenticates the exact JSON/event key and receives a versioned acceptance from a local mock only', async () => {
    let received = 0;
    const url = await receiver((req, res) => { const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => { received++; const body = Buffer.concat(chunks).toString(), timestamp = String(req.headers['x-home-security-timestamp']), key = String(req.headers['idempotency-key']); expect(req.headers['x-home-security-signature']).toBe('sha256=' + webhookSignature(secret, timestamp, key, body)); expect(JSON.parse(body)).toEqual(payload); receipt(res); }); });
    expect(await createWebhookSender(target(url))(payload)).toMatchObject({ outcome: 'accepted', code: 'acknowledged', status: 200, receipt: 'accepted', mayHaveReached: true });
    expect(received).toBe(1);
});
it('never interprets a bare 200, mismatched identity, oversized body or redirect as acceptance', async () => {
    for (const behavior of ['empty', 'wrong_id', 'oversize', 'redirect']) {
        let count = 0;
        const url = await receiver((_req, res) => { count++; if (behavior === 'empty')
            res.end('OK');
        else if (behavior === 'wrong_id')
            receipt(res, 'accepted', false, id(999));
        else if (behavior === 'oversize')
            res.end('x'.repeat(5000));
        else {
            res.statusCode = 302;
            res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
            res.end();
        } });
        expect(await createWebhookSender(target(url))(payload)).toMatchObject({ outcome: 'uncertain', code: 'invalid_receipt' });
        expect(count).toBe(1);
    }
});
it('treats authentication rejection as terminal and only retries explicit rejection receipts', async () => {
    for (const status of [401, 403, 429, 500, 503, 400]) {
        const url = await receiver((_req, res) => { res.statusCode = status; res.setHeader('retry-after', '20'); receipt(res, 'rejected', true); });
        const result = await createWebhookSender(target(url))(payload);
        expect(result.outcome).toBe([429, 500, 503].includes(status) ? 'retry' : 'failed');
        if ([401, 403].includes(status))
            expect(result.code).toBe('authentication_rejected');
        if (result.outcome === 'retry')
            expect(result.retryAfterMs).toBe(20000);
    }
    const denied = await receiver((_req, res) => { res.statusCode = 401; res.flushHeaders(); });
    expect(await createWebhookSender(target(denied, {connectTimeoutMs:100,requestTimeoutMs:200}))(payload)).toMatchObject({outcome:'failed',code:'authentication_rejected'});
    const url = await receiver((_req, res) => { res.statusCode = 500; res.end('maybe delivered'); });
    expect(await createWebhookSender(target(url))(payload)).toMatchObject({ outcome: 'uncertain' });
});
it('holds a post-send timeout and connection reset as uncertain without an automatic second HTTP request', async () => {
    let requests = 0;
    const url = await receiver(req => { requests++; req.resume(); });
    const send = createWebhookSender(target(url, { connectTimeoutMs: 100, requestTimeoutMs: 200 }));
    expect(await send(payload)).toMatchObject({ outcome: 'uncertain', code: 'request_timeout_unknown', mayHaveReached: true });
    expect(requests).toBe(1);
    const reset = await receiver(req => { req.destroy(); });
    expect(await createWebhookSender(target(reset))(payload)).toMatchObject({ outcome: 'uncertain', mayHaveReached: true });
});
it('can retry pre-connect refusal and cancels before sending without a side effect', async () => {
    const reserve = createNetServer();
    await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
    const a = reserve.address();
    if (!a || typeof a === 'string')
        throw Error('Missing port');
    await new Promise<void>(done => reserve.close(() => done()));
    const send = createWebhookSender(target(`http://127.0.0.1:${a.port}/notification`));
    expect(await send(payload)).toMatchObject({ outcome: 'retry', code: 'connection_failed', mayHaveReached: false });
    expect(await send(payload, AbortSignal.abort())).toMatchObject({ outcome: 'failed', code: 'cancelled_before_send', mayHaveReached: false });
});
it('pins an explicitly trusted LAN target and rejects unsafe destinations, secrets, redirects and timeouts', () => {
    const valid = { url: 'https://automation.example/notification', address: '192.168.50.30', secret };
    expect(webhookTarget(valid).id).toHaveLength(64);
    expect(webhookTarget({ ...valid, url: 'http://192.168.50.30/notification', allowLanHttp: true }).address).toBe('192.168.50.30');
    const invalid = [{ address: '127.0.0.1' }, { address: '169.254.169.254' }, { address: '0.0.0.0' }, { address: '224.0.0.1' }, { address: '100.64.0.1' }, { address: '::1' }, { url: 'http://192.168.50.30/notification' }, { url: 'file:///etc/passwd' }, { url: 'https://user:secret@automation.example/notification' }, { url: 'https://automation.example/notification?secret=x' }, { url: 'https://automation.example/notification#secret' }, { url: 'https://127.0.0.1/notification' }, { url: 'https://[::1]/notification' }, { secret: 'short' }, { connectTimeoutMs: 20000 }, { requestTimeoutMs: 100 }, { url: 'https://automation.example/' }];
    for (const values of invalid)
        expect(() => webhookTarget({ ...valid, ...values })).toThrow('Invalid trusted notification webhook configuration');
});
it('uses the approved socket IP rather than resolving the URL hostname', async () => {
    const url = await receiver((_req, res) => receipt(res));
    const spoof = new URL(url);
    spoof.hostname = 'does-not-resolve.invalid';
    const send = createWebhookSender(target(spoof.href));
    expect(await send(payload)).toMatchObject({ outcome: 'accepted' });
});
