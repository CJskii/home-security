import { createServer, type ServerResponse, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ledgerFixture, installation } from './helpers/notification-ledger.js';
import { createDeliveryStore } from '../src/notifications/destination.js';
import { webhookTarget, webhookSignature } from '../src/notifications/webhook.js';
const servers: Server[] = [], secret = 's'.repeat(48), key = 'b'.repeat(64);
afterEach(async () => { for (const s of servers)
    await new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }); servers.length = 0; });
async function setup(respond: (res: ServerResponse, id: string) => void) {
    const requests: {
        body: string;
        signature: string;
        timestamp: string;
        key: string;
        test: string;
    }[] = [], server = createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', b => chunks.push(Buffer.from(b))); req.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); requests.push({ body, signature: String(req.headers['x-home-security-signature']), timestamp: String(req.headers['x-home-security-timestamp']), key: String(req.headers['idempotency-key']), test: String(req.headers['x-home-security-test']) }); respond(res, JSON.parse(body).notificationId); }); });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    if (!a || typeof a === 'string')
        throw Error('Missing mock port');
    const pin = { url: `http://127.0.0.1:${a.port}/api/webhook/home-security`, address: '127.0.0.1', allowLanHttp: true }, f = ledgerFixture();
    (f.configuration.configuration as {
        deliveryEnabled: boolean;
    }).deliveryEnabled = false;
    f.configuration.producerEnabled = false;
    const store = createDeliveryStore(f.prisma, { key, approved: [pin], dashboardOrigin: 'https://dashboard.example' }, { now: f.now, targetFactory: input => webhookTarget({ ...input, connectTimeoutMs: 100, requestTimeoutMs: 250 }, true) });
    await store.save(installation, { expectedRevision: 0, url: pin.url, signingSecret: secret, acknowledgeHttp: true });
    return { f, store, requests };
}
it('POSTs the exact preview JSON/HMAC to a mock only, marked TEST while global live delivery is OFF', async () => {
    const f = await setup((res, id) => res.end(JSON.stringify({ version: 1, notificationId: id, outcome: 'accepted' }))), p = await f.store.preview(installation), r = await f.store.test(installation, p.confirmation);
    expect(r).toMatchObject({ state: 'DELIVERED', httpStatus: 200, receipt: 'accepted' });
    expect(f.requests).toHaveLength(1);
    const req = f.requests[0]!;
    expect(req.body).toBe(p.body);
    expect(req.test).toBe('true');
    expect(req.signature).toBe('sha256=' + webhookSignature(secret, req.timestamp, req.key, req.body));
    expect(JSON.parse(req.body)).toMatchObject({ test: true, eventId: null, action: 'test' });
    await f.store.test(installation, p.confirmation);
    expect(f.requests).toHaveLength(1);
    expect(f.f.tables.notificationEvaluation).toHaveLength(0);
});
it('reports a bare HTTP 200 as uncertain, not phone delivery; never follows redirect responses', async () => {
    for (const status of [200, 302]) {
        const f = await setup(res => { res.statusCode = status; res.setHeader('location', 'http://169.254.169.254/latest/meta-data'); res.end('OK'); }), p = await f.store.preview(installation);
        expect(await f.store.test(installation, p.confirmation)).toMatchObject({ state: 'UNCERTAIN', httpStatus: status, code: 'invalid_receipt' });
        await f.store.test(installation, p.confirmation);
        expect(f.requests).toHaveLength(1);
    }
});
it('records authentication and post-send timeout failures without retries or a live job', async () => {
    for (const kind of ['auth', 'timeout']) {
        const f = await setup(res => { if (kind === 'auth') {
            res.statusCode = 401;
            res.end();
        } }), p = await f.store.preview(installation);
        expect(await f.store.test(installation, p.confirmation)).toMatchObject(kind === 'auth' ? { state: 'FAILED', httpStatus: 401, code: 'authentication_rejected' } : { state: 'UNCERTAIN', code: 'request_timeout_unknown' });
        expect(f.requests).toHaveLength(1);
        expect(f.f.tables.notificationCooldown).toHaveLength(0);
    }
});
it('keeps HTTPS certificate verification enabled even for an approved pinned LAN-style endpoint', async () => {
    const privateKey = execFileSync('openssl', ['genrsa', '2048'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(), dir = mkdtempSync(join(tmpdir(), 'webhook-synthetic-cert-'));
    let cert: string;
    try {
        const path = join(dir, 'key.pem');
        writeFileSync(path, privateKey, { mode: 0o600 });
        cert = execFileSync('openssl', ['req', '-new', '-x509', '-key', path, '-days', '1', '-subj', '/CN=localhost'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
    let requests = 0;
    const s = httpsServer({ key: privateKey, cert }, (_q, res) => { requests++; res.end(); });
    servers.push(s);
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
    const a = s.address();
    if (!a || typeof a === 'string')
        throw Error('No mock port');
    const f = ledgerFixture(), pin = { url: `https://localhost:${a.port}/webhook`, address: '127.0.0.1', allowLanHttp: false }, store = createDeliveryStore(f.prisma, { key, approved: [pin], dashboardOrigin: 'https://dashboard.example' }, { now: f.now, targetFactory: input => webhookTarget(input, true) });
    await store.save(installation, { expectedRevision: 0, url: pin.url, signingSecret: secret, acknowledgeHttp: false });
    const p = await store.preview(installation);
    expect(await store.test(installation, p.confirmation)).toMatchObject({ state: 'FAILED', code: 'connection_failed' });
    expect(requests).toBe(0);
});
