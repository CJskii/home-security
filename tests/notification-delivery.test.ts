import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNotificationPipeline, PIPELINE } from '../src/notifications/pipeline.js';
import { notificationTick } from '../src/notifications/worker.js';
import { notificationRuntime } from '../src/notifications/runtime.js';
import { notificationHistory } from '../src/notifications/history.js';
import type { DeliveryResult } from '../src/notifications/delivery-contract.js';
import type { NotificationConfiguration } from '../src/notifications/contracts.js';
import { ledgerFixture, id, installation, rule, zone } from './helpers/notification-ledger.js';
const outcome = (value: DeliveryResult['outcome']): DeliveryResult => ({ outcome: value, code: value === 'accepted' ? 'acknowledged' : value === 'uncertain' ? 'request_timeout_unknown' : 'connection_failed', status: value === 'accepted' ? 200 : null, mayHaveReached: ['accepted', 'uncertain'].includes(value), durationMs: 10, receipt: value === 'accepted' ? 'accepted' : null });
function setup(deliveryEnabled = true) {
    const f = ledgerFixture();
    const options = { installation, deliveryEnabled, activatedAt: new Date('2026-10-21T12:00:00Z'), destinationId: 'a'.repeat(64), dashboardOrigin: 'https://dashboard.example' };
    const pipeline = createNotificationPipeline(f.prisma, options, f.now);
    return { ...f, pipeline, options, config: f.configuration.configuration as NotificationConfiguration };
}
async function prepare(f: ReturnType<typeof setup>) { await f.pipeline.reconcile(); while (await f.pipeline.evaluateNext()) { /* Drain due work only. */ } }
it('deduplicates event work, reservations, attempts and initial identities across worker restarts', async () => {
    const f = setup();
    const source = f.event(1), before = structuredClone(source);
    await Promise.all([f.pipeline.reconcile(), f.pipeline.reconcile()]);
    await prepare(f);
    expect(f.tables.notificationEvaluation).toHaveLength(1);
    expect(f.tables.notificationIntent).toHaveLength(1);
    expect(source).toEqual(before);
    const claim = await f.pipeline.claim();
    expect(claim?.payload.ai.status).toBe('skipped');
    expect(claim?.payload.objects[0]?.zoneIds).toEqual([zone]);
    expect(claim?.payload.images[0]?.path).toBe(`/api/events/${source.id}/images/${source.snapshots[0]!.id}`);
    expect(await f.pipeline.claim()).toBeNull();
    await f.pipeline.finish(claim!, outcome('accepted'));
    await f.pipeline.finish(claim!, outcome('accepted'));
    const restart = createNotificationPipeline(f.prisma, f.options, f.now);
    await restart.reconcile();
    expect(await restart.claim()).toBeNull();
    expect(f.tables.notificationAttempt).toHaveLength(1);
    expect(f.tables.notificationIntent?.[0]?.state).toBe('DELIVERED');
    expect(f.raw.mock.calls.some(([sql]) => sql.join('').includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    expect(f.raw.mock.calls.some(([sql]) => sql.join('').includes('pg_advisory_xact_lock'))).toBe(true);
});
it('serializes competing workers and cooldown reservations; a definite failure releases a waiting event', async () => {
    const f = setup();
    f.event(1);
    f.event(2);
    await f.pipeline.reconcile();
    const other = createNotificationPipeline(f.prisma, f.options, f.now);
    await Promise.all([f.pipeline.evaluateNext(), other.evaluateNext()]);
    expect(f.tables.notificationIntent).toHaveLength(1);
    const waiting = f.tables.notificationEvaluation!.find(e => e.state === 'WAITING')!;
    expect(waiting.result).toMatchObject({ decisions: [{ outcome: 'reserved', reason: 'cooldown_reserved' }] });
    const claims = await Promise.all([f.pipeline.claim(), other.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await f.pipeline.finish(claims.find(Boolean)!, outcome('failed'));
    expect(f.tables.notificationCooldown![0]?.lastDeliveredAt).toBeNull();
    expect(f.tables.notificationCooldown![0]?.reservationId).toBeNull();
    f.advance(30000);
    await f.pipeline.evaluateNext();
    expect(f.tables.notificationIntent).toHaveLength(2);
});
it('commits cooldown only on acknowledgement; suppressed events never extend it', async () => {
    const f = setup();
    f.event(1);
    await prepare(f);
    const a = await f.pipeline.claim();
    await f.pipeline.finish(a!, outcome('accepted'));
    const acknowledged = f.now();
    f.event(2);
    await prepare(f);
    expect(f.tables.notificationEvaluation!.find(e => e.eventId === id(102))?.result).toMatchObject({ decisions: [{ outcome: 'cooldown' }] });
    expect(f.tables.notificationCooldown![0]?.lastDeliveredAt).toEqual(acknowledged);
    f.advance(60000);
    f.event(3);
    await prepare(f);
    expect(f.tables.notificationIntent).toHaveLength(2);
});
it('combines multiple matching rules/objects into one event intent and supports explicit camera scope', async () => {
    const f = setup();
    f.config.rules = [{ ...f.config.rules[0]!, cooldownScope: 'rule_camera' }, { ...f.config.rules[0]!, id: id(4), name: 'Other matching rule', cooldownSeconds: 0 }];
    f.event(1).objects.push({ ...f.event(2).objects[0]!, id: id(999) });
    await prepare(f);
    const first = f.tables.notificationIntent![0]!;
    expect(first.payload).toMatchObject({ rules: [{ id: rule.id }, { id: id(4) }], objects: [{ id: id(301) }, { id: id(999) }] });
    expect(f.tables.notificationIntent).toHaveLength(1);
    // The second event waits on the same camera, but the other camera has a separate scope for rule 1.
    f.event(3, 2);
    await prepare(f);
    expect(f.tables.notificationIntent).toHaveLength(2);
    expect(f.tables.notificationCooldown!.some(c => c.scopeKey === rule.id + ':2')).toBe(true);
});
it('preserves the existing per-rule-across-cameras default and makes camera scope opt-in', async () => {
    const f = setup();
    f.event(1, 1);
    f.event(2, 2);
    await prepare(f);
    expect(f.tables.notificationIntent).toHaveLength(1);
    expect(f.tables.notificationCooldown![0]?.channel).toBe(0);
});
it('bounds safe retries, retains stable payload/identity and holds uncertainty without resending', async () => {
    const f = setup();
    f.event(1);
    await prepare(f);
    const a = await f.pipeline.claim();
    await f.pipeline.finish(a!, outcome('retry'));
    expect(await f.pipeline.claim()).toBeNull();
    f.advance(5000);
    const b = await f.pipeline.claim();
    expect(b?.payload).toEqual(a?.payload);
    expect(b?.ordinal).toBe(2);
    await f.pipeline.finish(b!, outcome('uncertain'));
    f.advance(300000);
    await f.pipeline.recover();
    expect(await f.pipeline.claim()).toBeNull();
    expect(f.tables.notificationIntent![0]?.state).toBe('UNCERTAIN');
    expect(f.tables.notificationCooldown![0]?.reservationId).toBe(a!.id);
    expect(f.tables.notificationAttempt).toHaveLength(2);
});
it('terminates definite retries at the attempt limit and releases reservations', async () => {
    const f = setup();
    f.event(1);
    await prepare(f);
    for (let n = 0; n < PIPELINE.maxAttempts; n++) {
        const c = await f.pipeline.claim();
        expect(c).not.toBeNull();
        await f.pipeline.finish(c!, outcome('retry'));
        f.advance(80000);
    }
    expect(await f.pipeline.claim()).toBeNull();
    expect(f.tables.notificationIntent![0]?.state).toBe('FAILED');
    expect(f.tables.notificationCooldown![0]?.reservationId).toBeNull();
    expect(f.tables.notificationCooldown![0]?.lastDeliveredAt).toBeNull();
});
it('recovers an expired in-flight lease as uncertain and fences late worker results', async () => {
    const f = setup();
    f.event(1);
    await prepare(f);
    const claim = await f.pipeline.claim();
    f.advance(PIPELINE.leaseMs + 1);
    await f.pipeline.recover();
    await f.pipeline.finish(claim!, outcome('accepted'));
    expect(f.tables.notificationIntent![0]?.state).toBe('UNCERTAIN');
    expect(f.tables.notificationAttempt![0]).toMatchObject({ outcome: 'UNCERTAIN', errorCode: 'worker_lease_expired', mayHaveReached: true });
    expect(await f.pipeline.claim()).toBeNull();
});
it('keeps explicit unknown/ambiguous exclusions, retries metadata but never waits for AI', async () => {
    const f = setup();
    const unknown = f.event(1);
    unknown.objects[0]!.coordinateStatus = 'MISSING';
    const boundary = f.event(2);
    boundary.objects[0]!.xMin = 4500;
    boundary.objects[0]!.xMax = 5200;
    await prepare(f);
    expect(f.tables.notificationIntent).toHaveLength(0);
    expect(f.tables.notificationEvaluation!.every(e => e.state === 'WAITING')).toBe(true);
    unknown.objects[0]!.coordinateStatus = 'VALID';
    f.advance(30000);
    await f.pipeline.evaluateNext();
    expect(f.tables.notificationIntent).toHaveLength(1);
    expect(f.tables.notificationIntent![0]?.payload).toMatchObject({ ai: { status: 'skipped' } });
});
it('honors the saved global OFF, operator arm, activation cutoff, configuration revision and destination guards', async () => {
    for (const guard of ['global', 'producer', 'activation', 'runtime'] as const) {
        const f = setup(guard !== 'runtime');
        f.event(1);
        if (guard === 'global')
            f.config.deliveryEnabled = false;
        if (guard === 'producer')
            f.configuration.producerEnabled = false;
        if (guard === 'activation')
            f.options.activatedAt = new Date('2026-10-21T13:00:00Z');
        await prepare(f);
        expect(f.tables.notificationIntent).toHaveLength(0);
        expect(await f.pipeline.claim()).toBeNull();
    }
    const f = setup();
    f.event(1);
    await prepare(f);
    const claim = await f.pipeline.claim();
    f.config.deliveryEnabled = false;
    expect(await f.pipeline.authorize(claim!)).toBe(false);
    const changed = setup();
    changed.event(1);
    await prepare(changed);
    changed.configuration.revision = 2;
    expect(await changed.pipeline.claim()).toBeNull();
    expect(changed.tables.notificationIntent![0]?.state).toBe('CANCELLED');
    const target = setup();
    target.event(1);
    await prepare(target);
    target.options.destinationId = 'b'.repeat(64);
    expect(await target.pipeline.claim()).toBeNull();
});
it('repairs missed producer jobs behind the cursor without touching historical or source records', async () => {
    const f = setup();
    f.event(2);
    await f.pipeline.reconcile();
    const late = f.event(1);
    await f.pipeline.reconcile();
    expect(f.tables.notificationEvaluation).toHaveLength(2);
    const before = f.event(3);
    before.firstReceivedAt = new Date('2026-10-20T12:00:00Z');
    await f.pipeline.reconcile();
    expect(f.tables.notificationEvaluation).toHaveLength(2);
    expect(late.processing.status).toBe('SKIPPED');
});
it('rolls back an intent/reservation if persistence fails and expires stale undelivered work', async () => {
    const f = setup();
    f.event(1);
    await f.pipeline.reconcile();
    vi.spyOn(f.prisma.notificationIntent, 'create').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.pipeline.evaluateNext()).rejects.toThrow('storage unavailable');
    expect(f.tables.notificationIntent).toHaveLength(0);
    expect(f.tables.notificationCooldown).toHaveLength(0);
    await f.pipeline.evaluateNext();
    f.advance(PIPELINE.maxAgeMs);
    await f.pipeline.recover();
    expect(f.tables.notificationIntent![0]?.state).toBe('CANCELLED');
    expect(f.tables.notificationCooldown![0]?.reservationId).toBeNull();
});
it('provides bounded read-only history without webhook payloads/secrets and scopes cursors', async () => {
    const f = setup();
    f.event(1);
    await prepare(f);
    const a = await f.pipeline.claim();
    await f.pipeline.finish(a!, outcome('failed'));
    const before = structuredClone(f.tables), history = await notificationHistory(f.prisma, installation);
    expect(history).toMatchObject({ producerEnabled: true, deliveryEnabled: true, items: [{ decisions: [{ ruleName: 'Entrance people' }], intent: { state: 'FAILED', attemptCount: 1, attempts: [{ outcome: 'FAILED' }] } }] });
    expect(JSON.stringify(history)).not.toMatch(/payload|signature|https:\/\/dashboard|snapshot|destinationId/);
    expect(f.tables).toEqual(before);
    await expect(notificationHistory(f.prisma, installation, id(999))).rejects.toThrow('Unknown history cursor');
});
it('worker never invokes a sender with global OFF and does not resend transport exceptions', async () => {
    const f = setup();
    f.event(1);
    f.config.deliveryEnabled = false;
    const sender = vi.fn(async () => outcome('accepted'));
    await notificationTick(f.pipeline, sender, new AbortController().signal);
    expect(sender).not.toHaveBeenCalled();
    const g = setup();
    g.event(1);
    const broken = vi.fn(async () => { throw Error('transport failed'); });
    await notificationTick(g.pipeline, broken, new AbortController().signal);
    await notificationTick(g.pipeline, broken, new AbortController().signal);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(g.tables.notificationIntent![0]?.state).toBe('UNCERTAIN');
});
it('defaults worker OFF before opening connections, requires explicit secret/destination/cutoff to send', () => {
    expect(notificationRuntime({})).toEqual({ enabled: false });
    expect(notificationRuntime({ NOTIFICATION_DELIVERY_ENABLED: 'true', DATABASE_URL: 'bad' })).toEqual({ enabled: false });
    const env = { NOTIFICATION_WORKER_ENABLED: 'true', DATABASE_URL: 'postgresql://test:secret@invalid/security', UNIVIEW_INSTALLATION_ID: installation, NOTIFICATION_DASHBOARD_ORIGIN: 'https://dashboard.example' };
    expect(notificationRuntime(env)).toMatchObject({ enabled: true, deliveryEnabled: false, target: null, activatedAt: null });
    expect(() => notificationRuntime({ ...env, NOTIFICATION_DELIVERY_ENABLED: 'true' })).toThrow('Invalid notification worker configuration');
    const sql = readFileSync('prisma/migrations/20261021020000_notification_delivery/migration.sql', 'utf8');
    expect(sql).toContain('"producerEnabled" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('ON CONFLICT ("sourceInstallationId","eventId") DO NOTHING');
    expect(sql).toContain("set_config('lock_timeout','100ms',true)");
    expect(sql).not.toMatch(/UPDATE "SecurityEvent"|DELETE FROM|UPDATE "NotificationConfiguration"/);
});
it('reconsiders late source reports without waiting for AI or rewriting canonical observations', async () => {
    const f = setup();
    const source = f.event(1);
    source.objects[0]!.xMin = 6000;
    source.objects[0]!.xMax = 7000;
    await prepare(f);
    expect(f.tables.notificationIntent).toHaveLength(0);
    expect(f.tables.notificationEvaluation![0]?.state).toBe('WAITING');
    source.objects.push({ ...source.objects[0]!, id: id(777), xMin: 1000, xMax: 2000 });
    const before = structuredClone(source);
    f.advance(30000);
    await f.pipeline.evaluateNext();
    expect(f.tables.notificationIntent).toHaveLength(1);
    expect(source).toEqual(before);
    expect(f.tables.notificationIntent![0]?.payload).toMatchObject({ objects: [{ id: id(777) }] });
});
it('does not reconstruct old rules after a missed producer write or change the saved-settings timestamp during reconciliation', async () => {
    const f = setup();
    const saved = f.configuration.updatedAt;
    f.event(1);
    await f.pipeline.reconcile();
    expect(f.configuration.updatedAt).toEqual(saved);
    const g = setup();
    g.event(1);
    g.configuration.updatedAt = g.now();
    await prepare(g);
    expect(g.tables.notificationIntent).toHaveLength(0);
    expect(g.tables.notificationEvaluation![0]?.result).toMatchObject({ deliveryHeldReason: 'configuration_snapshot_unavailable' });
});
it('carries existing failed/pending AI state and only an already accepted optional summary', async () => {
    for (const status of ['FAILED', 'PENDING']) {
        const f = setup();
        const source = f.event(1);
        source.processing.status = status;
        await prepare(f);
        expect(f.tables.notificationIntent![0]?.payload).toMatchObject({ ai: { status: status === 'FAILED' ? 'failed' : 'pending', summary: null } });
    }
});
it('paginates read-only history without duplicate rows at identical timestamps', async () => {
    const f = setup();
    for (let n = 0; n < 52; n++)
        f.event(n);
    await f.pipeline.reconcile();
    const first = await notificationHistory(f.prisma, installation);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const next = await notificationHistory(f.prisma, installation, first.nextCursor!);
    expect(next.items).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map(i => i.id)).size).toBe(52);
});
it('includes only original media anchors of qualifying source observations', async () => {
    const f = setup();
    const source = f.event(1);
    f.tables.eventSnapshot!.unshift({ id: id(20), eventId: source.id, origin: 'NVR_PUSH', status: 'RECEIVED', sha256: 'b'.repeat(64) });
    await prepare(f);
    expect(f.tables.notificationIntent![0]?.payload).toMatchObject({ images: [{ id: source.snapshots[0]!.id }] });
});
it('prefers the qualifying original full frame over a crop and freezes scoped media links',async()=>{
 const f=setup(),source=f.event(1),crop=id(999);Object.assign(source.objects[0]!,{cropSnapshotId:crop});f.tables.eventSnapshot!.push({id:crop,eventId:source.id,origin:'NVR_PUSH',status:'RECEIVED',sha256:'b'.repeat(64)});const pipeline=createNotificationPipeline(f.prisma,{...f.options,media:{key:'c'.repeat(64),origin:'http://192.168.50.10:3000'}},f.now);await pipeline.reconcile();await pipeline.evaluateNext();const claim=await pipeline.claim();expect(claim?.payload.images[0]?.id).toBe(source.snapshots[0]!.id);expect(claim?.payload.images[0]?.delivery?.url).toContain(`/api/notification-media/${source.id}/${source.snapshots[0]!.id}?token=`);expect(claim?.payload.ai.status).toBe('skipped');expect(source.objects[0]!.fullFrameSnapshotId).toBe(source.snapshots[0]!.id);
});
it('evaluates fresh cached source geometry before AI and retains single-intent cooldown fencing after restart',async()=>{
 const f=setup(),source=f.event(1);source.processing.status='PENDING';
 for(const version of f.tables.univiewZoneVersion!)version.lastObservedAt=new Date('2026-10-21T12:00:00Z');
 await prepare(f);const claim=await f.pipeline.claim();expect(claim?.payload.ai.status).toBe('pending');expect(claim?.payload.objects[0]?.basis).toBe('latest_confirmed_geometry_assumed_unchanged');
 await f.pipeline.finish(claim!,outcome('accepted'));const restarted=createNotificationPipeline(f.prisma,f.options,f.now);await restarted.reconcile();expect(await restarted.claim()).toBeNull();expect(f.tables.notificationIntent).toHaveLength(1);
});

it('creates one initial intent for person entry at the boundary, without waiting for AI or duplicating the event',async()=>{
 const f=setup();const e=f.event(1);e.objects[0]!.xMin=4400;e.objects[0]!.xMax=5200;
 await prepare(f);expect(f.tables.notificationIntent).toHaveLength(1);await f.pipeline.reconcile();await f.pipeline.evaluateNext();expect(f.tables.notificationIntent).toHaveLength(1);expect(f.tables.notificationIntent![0]!.payload).toMatchObject({ai:{status:'skipped'}});
});
