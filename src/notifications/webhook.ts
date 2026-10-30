import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { webhookPayload, type DeliveryResult, type WebhookPayload } from './delivery-contract.js';
export interface WebhookTarget {
    url: URL;
    address: string;
    secret: string;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    id: string;
}
const privateAddress = (ip: string) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
export function webhookTarget(input: {
    url: string;
    address: string;
    secret: string;
    allowLanHttp?: boolean;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
}, testLoopback = false): WebhookTarget {
    try {
        const url = new URL(input.url), ip = input.address, n = ip.split('.').map(Number), loopback = n[0] === 127;
        if (isIP(ip) !== 4 || (!testLoopback && loopback) || n[0] === 0 || n[0]! >= 224 || n[0] === 169 && n[1] === 254 || n[0] === 100 && n[1]! >= 64 && n[1]! <= 127)
            throw Error();
        if (url.username || url.password || url.search || url.hash || !url.hostname || url.pathname === '/' || !['http:', 'https:'].includes(url.protocol))
            throw Error();
        if (url.hostname.startsWith('[') || isIP(url.hostname) && url.hostname !== ip)
            throw Error();
        if (url.protocol === 'http:' && !(input.allowLanHttp && (privateAddress(ip) || testLoopback && loopback)))
            throw Error();
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(input.secret))
            throw Error();
        const connectTimeoutMs = z.number().int().min(100).max(5000).parse(input.connectTimeoutMs ?? 2000), requestTimeoutMs = z.number().int().min(200).max(15000).parse(input.requestTimeoutMs ?? 10000);
        if (connectTimeoutMs >= requestTimeoutMs)
            throw Error();
        return { url, address: ip, secret: input.secret, connectTimeoutMs, requestTimeoutMs, id: createHash('sha256').update(url.href + '|' + ip).digest('hex') };
    }
    catch {
        throw new Error('Invalid trusted notification webhook configuration');
    }
}
const receiptSchema = z.object({ version: z.literal(1), notificationId: z.uuid(), outcome: z.enum(['accepted', 'rejected']), retryable: z.boolean().optional() }).strict();
export function webhookSignature(secret: string, timestamp: string, key: string, body: string) { return createHmac('sha256', secret).update(timestamp + '.' + key + '.' + body).digest('hex'); }
export function createWebhookSender(target: WebhookTarget) {
    return async (payloadInput: WebhookPayload, signal?: AbortSignal): Promise<DeliveryResult> => {
        const started = Date.now(), payload = webhookPayload.parse(payloadInput), body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
        const result = (outcome: DeliveryResult['outcome'], code: string, status: number | null, mayHaveReached: boolean, receipt: DeliveryResult['receipt'] = null, retryAfterMs?: number): DeliveryResult => ({ outcome, code, status, mayHaveReached, receipt, durationMs: Date.now() - started, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
        if (Buffer.byteLength(body) > 65536)
            return result('failed', 'payload_limit', null, false);
        if (signal?.aborted)
            return result('failed', 'cancelled_before_send', null, false);
        return new Promise(resolve => {
            let connected = false, done = false, status: number | null = null;
            const finish = (value: DeliveryResult) => { if (done)
                return; done = true; clearTimeout(connectTimer); clearTimeout(totalTimer); signal?.removeEventListener('abort', abort); resolve(value); };
            const req = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
                method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
                    'x-home-security-timestamp': timestamp, 'x-home-security-signature': 'sha256=' + webhookSignature(target.secret, timestamp, payload.idempotencyKey, body), 'idempotency-key': payload.idempotencyKey,...(payload.type==='security.test'?{'x-home-security-test':'true'}:{}) },
                // Pin the approved literal IP for the entire request; no DNS resolution or
                // redirect can change the destination. TLS still validates the URL hostname.
                lookup: (_host, options, callback) => { if (options.all)
                    callback(null, [{ address: target.address, family: 4 }]);
                else
                    callback(null, target.address, 4); },
            }, res => {
                status = res.statusCode ?? null;
                if (status === 401 || status === 403) {
                    finish(result('failed', 'authentication_rejected', status, true, 'rejected'));
                    res.destroy();
                    return;
                }
                let size = 0;
                const chunks: Buffer[] = [];
                const rejectBody = () => { finish(result('uncertain', 'invalid_receipt', status, true)); res.destroy(); };
                res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) {
                    rejectBody();
                    return;
                } chunks.push(chunk); });
                res.on('error', () => finish(result('uncertain', 'response_interrupted', status, true)));
                res.on('end', () => {
                    if (done)
                        return;
                    // Authentication failures are terminal rejections. Other outcomes require an
                    // explicit versioned receipt; a 200/500 alone does not prove side effects.
                    let receipt: z.infer<typeof receiptSchema> | null = null;
                    try {
                        receipt = receiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    }
                    catch { /* Never retain arbitrary response bodies. */ }
                    if (!receipt || receipt.notificationId !== payload.notificationId) {
                        finish(result('uncertain', 'invalid_receipt', status, true));
                        return;
                    }
                    if (receipt.outcome === 'accepted' && status !== null && status >= 200 && status < 300) {
                        finish(result('accepted', 'acknowledged', status, true, 'accepted'));
                        return;
                    }
                    if (receipt.outcome === 'rejected') {
                        const retryable = receipt.retryable === true && (status === 429 || status !== null && status >= 500 && status <= 599), raw = res.headers['retry-after'];
                        const seconds = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Math.min(300, Number(raw)) : 0;
                        finish(result(retryable ? 'retry' : 'failed', retryable ? 'remote_rejected_retryable' : 'remote_rejected', status, true, 'rejected', seconds * 1000));
                        return;
                    }
                    finish(result('uncertain', 'conflicting_receipt', status, true));
                });
            });
            const abort = () => { finish(result(connected ? 'uncertain' : 'failed', connected ? 'cancelled_after_connect' : 'cancelled_before_send', status, connected)); req.destroy(); };
            req.on('socket', socket => socket.once(target.url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(connectTimer); }));
            req.on('error', () => finish(result(connected ? 'uncertain' : 'retry', connected ? 'network_outcome_unknown' : 'connection_failed', status, connected)));
            const connectTimer = setTimeout(() => { finish(result('retry', 'connect_timeout', status, false)); req.destroy(); }, target.connectTimeoutMs);
            const totalTimer = setTimeout(() => { finish(result(connected ? 'uncertain' : 'retry', connected ? 'request_timeout_unknown' : 'connect_timeout', status, connected)); req.destroy(); }, target.requestTimeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            req.end(body);
        });
    };
}
