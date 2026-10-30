import { expect, it, vi } from 'vitest';
import { createDeliveryStore, configuredTarget } from '../src/notifications/destination.js';
import { credentialCipher } from '../src/notifications/destination-crypto.js';
import { approvedDestinations } from '../src/notifications/destination-contract.js';
import { createNotificationPipeline } from '../src/notifications/pipeline.js';
import { ledgerFixture, installation, id } from './helpers/notification-ledger.js';
import { webhookPayload } from '../src/notifications/delivery-contract.js';
import type { DeliveryResult } from '../src/notifications/delivery-contract.js';
const pin = { url: 'http://192.168.50.20:8123/api/webhook/home-security', address: '192.168.50.20', allowLanHttp: true }, key = 'b'.repeat(64), secret = 's'.repeat(48), result: DeliveryResult = { outcome: 'accepted', code: 'acknowledged', status: 200, durationMs: 20, receipt: 'accepted', mayHaveReached: true };
function setup() { const f = ledgerFixture(); (f.configuration.configuration as {
    deliveryEnabled: boolean;
}).deliveryEnabled = false; f.configuration.producerEnabled = false; f.configuration.liveFromAt = null; const options = { key, approved: [pin], dashboardOrigin: 'https://dashboard.example' }, send = vi.fn(async () => result), store = createDeliveryStore(f.prisma, options, { now: f.now, send }); const save = () => store.save(installation, { expectedRevision: 0, url: pin.url, signingSecret: secret, acknowledgeHttp: true }); return { ...f, options, store, send, save }; }
it('requires an exact operator pin and explicit LAN HTTP consent; no blanket private-network access', async () => {
    const f = setup();
    await expect(f.store.save(installation, { expectedRevision: 0, url: 'http://192.168.50.21:8123/api/webhook/home-security', signingSecret: secret, acknowledgeHttp: true })).rejects.toThrow('destination_not_approved');
    await expect(f.store.save(installation, { expectedRevision: 0, url: pin.url, signingSecret: secret, acknowledgeHttp: false })).rejects.toThrow('explicit_lan_http_approval_required');
    for (const url of ['http://127.0.0.1/webhook', 'https://[::1]/webhook', 'http://169.254.169.254/webhook', 'https://192.168.50.20/webhook?secret=x'])
        expect(() => approvedDestinations(JSON.stringify([{ ...pin, url }]))).toThrow();
    expect(approvedDestinations(JSON.stringify([pin]))).toEqual([pin]);
    expect(f.send).not.toHaveBeenCalled();
});
it('encrypts per installation, masks credentials and keeps all rule/AI/source tables untouched on save', async () => {
    const f = setup(), rules = structuredClone(f.configuration.configuration), updatedAt = f.configuration.updatedAt;
    const saved = await f.save();
    expect(saved.secretConfigured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(saved)).not.toContain(String(f.configuration.deliverySecret));
    expect(f.configuration.deliverySecret).not.toBe(secret);
    expect(credentialCipher(key).open(String(f.configuration.deliverySecret), installation)).toBe(secret);
    expect(() => credentialCipher(key).open(String(f.configuration.deliverySecret), id(90))).toThrow();
    expect(() => credentialCipher('c'.repeat(64)).open(String(f.configuration.deliverySecret), installation)).toThrow();
    expect(f.configuration.configuration).toEqual(rules);
    expect(f.configuration.updatedAt).toEqual(updatedAt);
    expect(f.configuration.producerEnabled).toBe(false);
    expect(f.configuration.liveFromAt).toBeNull();
    expect(f.tables.securityEvent).toHaveLength(0);
    expect(f.tables.notificationEvaluation).toHaveLength(0);
    expect(f.tables.notificationIntent).toHaveLength(0);
    expect(f.send).not.toHaveBeenCalled();
});
it('retains hidden secrets on blank replacement, rejects stale saves, and does not rewrite unchanged settings', async () => {
    const f = setup();
    await f.save();
    const encrypted = f.configuration.deliverySecret;
    const r = await f.store.save(installation, { expectedRevision: 1, url: pin.url, acknowledgeHttp: true });
    expect(r.revision).toBe(1);
    expect(f.configuration.deliverySecret).toBe(encrypted);
    await expect(f.save()).rejects.toThrow('settings_changed_reload');
});
it('rotation disarms an armed producer without changing rules or global preference, fencing old sender revisions', async () => {
    const f = setup();
    await f.save();
    const previous = configuredTarget(f.configuration as never, f.options).id;
    f.configuration.producerEnabled = true;
    f.configuration.liveFromAt = f.now();
    await f.store.save(installation, { expectedRevision: 1, url: pin.url, signingSecret: 'x'.repeat(48), acknowledgeHttp: true });
    expect(f.configuration.producerEnabled).toBe(false);
    expect(f.configuration.liveFromAt).toBeNull();
    expect(configuredTarget(f.configuration as never, f.options).id).not.toBe(previous);
    expect((f.configuration.configuration as {
        deliveryEnabled: boolean;
    }).deliveryEnabled).toBe(false);
});
it('preview is an exact canonical TEST body without a job, credential or side effect', async () => {
    const f = setup();
    await f.save();
    const before = structuredClone(f.tables), p = await f.store.preview(installation);
    expect(f.tables).toEqual(before);
    expect(p.payload).toMatchObject({ type: 'security.test', action: 'test', test: true, eventId: null, images: [], rules: [], notification: { title: 'Home Security · TEST' } });
    expect(JSON.parse(p.body)).toEqual(p.payload);
    expect(p.headers['X-Home-Security-Signature']).toContain('<HMAC-SHA256');
    expect(JSON.stringify(p)).not.toContain(secret);
    expect(f.send).not.toHaveBeenCalled();
});
it('sends once with global OFF, shares concurrent confirmation replays and records only TEST attempts', async () => {
    const f = setup();
    await f.save();
    const p = await f.store.preview(installation);
    const [a, b] = await Promise.all([f.store.test(installation, p.confirmation), f.store.test(installation, p.confirmation)]);
    expect(a.id).toBe(b.id);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.store.test(installation, p.confirmation)).toMatchObject({ id: a.id, state: 'DELIVERED', httpStatus: 200, receipt: 'accepted' });
    expect(f.tables.notificationIntent).toHaveLength(1);
    expect(f.tables.notificationIntent![0]).toMatchObject({ mode: 'TEST', eventId: null, evaluationId: null, state: 'DELIVERED' });
    expect(f.tables.notificationAttempt).toHaveLength(1);
    expect(f.tables.notificationEvaluation).toHaveLength(0);
    expect(f.tables.notificationCooldown).toHaveLength(0);
    expect(f.configuration.producerEnabled).toBe(false);
    expect(f.configuration.configuration).toMatchObject({ deliveryEnabled: false });
});
it('rejects tampered, expired, cross-installation and stale-revision confirmations before HTTP', async () => {
    const f = setup();
    await f.save();
    const p = await f.store.preview(installation);
    await expect(f.store.test(installation, p.confirmation + 'x')).rejects.toThrow('invalid_test_confirmation');
    await expect(f.store.test(id(90), p.confirmation)).rejects.toThrow('invalid_test_confirmation');
    f.advance(120001);
    await expect(f.store.test(installation, p.confirmation)).rejects.toThrow('test_confirmation_expired');
    const next = await f.store.preview(installation);
    await f.store.save(installation, { expectedRevision: 1, url: pin.url, signingSecret: 'y'.repeat(48), acknowledgeHttp: true });
    await expect(f.store.test(installation, next.confirmation)).rejects.toThrow('destination_changed_preview_again');
    expect(f.send).not.toHaveBeenCalled();
});
it('enforces one test per minute and never schedules automatic retries for rejection/uncertainty', async () => {
    for (const response of [{ ...result, outcome: 'retry' as const, code: 'remote_rejected_retryable', status: 503, receipt: 'rejected' as const }, { ...result, outcome: 'uncertain' as const, code: 'invalid_receipt', receipt: null }]) {
        const f = setup();
        f.send.mockResolvedValue(response);
        await f.save();
        const p = await f.store.preview(installation);
        const a = await f.store.test(installation, p.confirmation);
        expect(a.state).toBe(response.outcome === 'retry' ? 'FAILED' : 'UNCERTAIN');
        const next = await f.store.preview(installation);
        await expect(f.store.test(installation, next.confirmation)).rejects.toThrow('test_rate_limit_one_per_minute');
        await f.store.test(installation, p.confirmation);
        expect(f.send).toHaveBeenCalledTimes(1);
        f.advance(60001);
        const later = await f.store.preview(installation);
        await f.store.test(installation, later.confirmation);
        expect(f.send).toHaveBeenCalledTimes(2);
    }
});
it('records interrupted sends as uncertain; restarting/replaying never repeats them', async () => {
    const f = setup();
    f.send.mockRejectedValueOnce(Error('Secret external error'));
    await f.save();
    const p = await f.store.preview(installation);
    expect(await f.store.test(installation, p.confirmation)).toMatchObject({ state: 'UNCERTAIN', code: 'test_network_outcome_unknown' });
    const restarted = createDeliveryStore(f.prisma, f.options, { now: f.now, send: f.send });
    await restarted.test(installation, p.confirmation);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await restarted.read(installation))).not.toContain('Secret external error');
});
it('LIVE worker claims/recovery cannot touch TEST rows, including an expired TEST lease', async () => {
    const f = setup();
    await f.save();
    const p = await f.store.preview(installation);
    await f.store.test(installation, p.confirmation);
    const row = f.tables.notificationIntent![0]!;
    row.state = 'SENDING';
    row.leaseUntil = new Date(f.now().getTime() - 1);
    const pipeline = createNotificationPipeline(f.prisma, { installation, deliveryEnabled: true, activatedAt: f.now(), destinationId: row.destinationId as string, destinationRevision: 1, dashboardOrigin: f.options.dashboardOrigin }, f.now);
    await pipeline.recover();
    expect(row.state).toBe('SENDING');
    expect(await pipeline.claim()).toBeNull();
    expect((await f.store.read(installation)).tests[0]).toMatchObject({ state: 'UNCERTAIN', code: 'test_process_outcome_unknown' });
});
it('requires a separate server key, rejects existing service credentials, and detects lost approval', async () => {
    const f = setup(), unconfigured = createDeliveryStore(f.prisma, { approved: [pin], dashboardOrigin: 'https://dashboard.example' });
    expect((await unconfigured.read(installation)).writable).toBe(false);
    await expect(unconfigured.preview(installation)).rejects.toThrow('credential_key_required');
    const forbidden = createDeliveryStore(f.prisma, { ...f.options, forbiddenSecrets: [secret] });
    await expect(forbidden.save(installation, { expectedRevision: 0, url: pin.url, signingSecret: secret, acknowledgeHttp: true })).rejects.toThrow('use_a_separate_signing_secret');
    await f.save();
    const revoked = createDeliveryStore(f.prisma, { ...f.options, approved: [] });
    await expect(revoked.preview(installation)).rejects.toThrow('destination_approval_required');
});

it('refuses live authorization at an old destination revision even if an operator later rearms the producer',async()=>{
 const f=ledgerFixture(),pipeline=createNotificationPipeline(f.prisma,{installation,deliveryEnabled:true,activatedAt:new Date('2026-10-21T12:00:00Z'),destinationId:'a'.repeat(64),destinationRevision:0,dashboardOrigin:'https://dashboard.example'},f.now);
 f.event(1);await pipeline.reconcile();while(await pipeline.evaluateNext()){/* Drain synthetic work. */}
 const claim=await pipeline.claim();expect(claim).not.toBeNull();expect(await pipeline.authorize(claim!)).toBe(true);
 f.configuration.deliveryRevision=1;
 expect(await pipeline.authorize(claim!)).toBe(false);
});

it('freezes crop TEST preview bytes exactly as the sender validates/serializes them, with no live event job',async()=>{
 const f=setup();await f.save();const event=f.event(1);Object.assign(event.objects[0]!,{cropSnapshotId:event.snapshots[0]!.id});const store=createDeliveryStore(f.prisma,{...f.options,media:{key:'c'.repeat(64),origin:'http://192.168.50.10:3000'}},{now:f.now,send:f.send});const preview=await store.preview(installation,event.id);expect(preview.payload.sampleEventId).toBe(event.id);expect(preview.payload.eventId).toBeNull();expect(preview.payload.images[0]?.delivery?.url).toContain('/api/notification-media/');expect(preview.body).toBe(JSON.stringify(webhookPayload.parse(preview.payload)));await store.test(installation,preview.confirmation);expect(JSON.stringify(webhookPayload.parse((f.send.mock.calls as unknown as [unknown,unknown][])[0]![1]))).toBe(preview.body);expect(f.tables.notificationEvaluation).toHaveLength(0);expect(f.configuration.producerEnabled).toBe(false);
});
it('previews and sends one same-tag accepted-sample TEST enrichment with live gates off, without replaying canonical events',async()=>{
 const f=setup();await f.save();const event=f.event(1);f.tables.eventAnalysis!.push({eventId:event.id,revision:1,completedAt:new Date('2026-10-21T12:00:02Z'),objectAnalyses:[{objectId:event.objects[0]!.id,verification:'supported',observedType:'person',actions:['walking'],shortDescription:'A person appears to be walking.'}]});
 const store=createDeliveryStore(f.prisma,{...f.options,media:{key:'c'.repeat(64),origin:'http://192.168.50.10:3000'}},{now:f.now,send:f.send});const first=await store.preview(installation,event.id);await store.test(installation,first.confirmation);const update=await store.preview(installation,undefined,first.payload.notificationId);expect(update.payload).toMatchObject({type:'security.test',test:true,action:'update',eventId:null,sampleEventId:event.id,notificationId:first.payload.notificationId,ai:{summary:'A person appears to be walking.'}});expect(update.payload.idempotencyKey).not.toBe(first.payload.idempotencyKey);
 const sent=await store.test(installation,update.confirmation);expect(sent.state).toBe('DELIVERED');expect(sent.id).not.toBe(first.payload.notificationId);await store.test(installation,update.confirmation);expect(f.send).toHaveBeenCalledTimes(2);expect(f.tables.notificationIntent).toHaveLength(2);expect(f.tables.notificationIntent![1]!.parentId).toBe(first.payload.notificationId);expect(f.tables.notificationCooldown).toHaveLength(0);expect(f.configuration.producerEnabled).toBe(false);expect(f.tables.notificationEvaluation).toHaveLength(0);
 Object.assign(f.tables.eventAnalysis![0]!,{revision:2,objectAnalyses:[{objectId:event.objects[0]!.id,verification:'supported',observedType:'person',actions:['standing'],shortDescription:'A person is standing.'}]});const newer=await store.preview(installation,undefined,first.payload.notificationId);await expect(store.test(installation,newer.confirmation)).rejects.toThrow('test_identity_conflict');expect(f.send).toHaveBeenCalledTimes(2);
 f.advance(120001);await expect(store.preview(installation,undefined,first.payload.notificationId)).rejects.toThrow('fresh_test_with_useful_accepted_sample_required');
});
