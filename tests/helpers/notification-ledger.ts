import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const installation = id(1), zone = id(2), rule = { id: id(3), name: 'Entrance people', enabled: true, channels: [1, 2], zoneIds: [zone, id(12)], categories: ['PERSON'], cooldownSeconds: 60, ambiguous: 'exclude', unknown: 'exclude' };
// A metadata-only transactional DB double. Uniqueness and serialized transactions
// simulate the guarantees requested explicitly by the production SQL; no live DB.
type Row = Record<string, unknown>;
type Args = {
    where?: Row;
    data?: Row;
    create?: Row;
    update?: Row;
    select?: Row;
    include?: Row;
    take?: number;
    orderBy?: Row | Row[];
};
export function ledgerFixture() {
    let clock = new Date('2026-10-21T12:00:10.000Z'), chain: Promise<unknown> = Promise.resolve();
    const configuration: Row = { deliveryRevision:0,deliveryConfiguration:null,deliverySecret:null,sourceInstallationId: installation, configuration: { deliveryEnabled: true, rules: [structuredClone(rule)] }, revision: 1, producerEnabled: true, liveFromAt: new Date('2026-10-21T12:00:00Z'), updatedAt: new Date('2026-10-21T12:00:00Z'), scannedAt: null, scannedId: null };
    const tables: Record<string, Row[]> = { notificationConfiguration: [configuration], notificationEvaluation: [], notificationIntent: [], notificationCooldown: [], notificationAttempt: [], eventSnapshot: [], securityEvent: [], univiewZoneVersion: [], eventAnalysis: [] };
    for (const channel of [1, 2])
        for (let slot = 0; slot < 4; slot++)
            tables.univiewZoneVersion!.push({ id: id(40 + channel * 10 + slot), zoneId: slot === 0 ? (channel === 1 ? zone : id(12)) : id(70 + channel * 10 + slot), zone: { channel, slot, sourceInstallationId: installation, preference: null }, revision: 2, enabled: slot === 0, ruleEnabled: slot === 0, polygon: slot === 0 ? [{ X: 100, Y: 100 }, { X: 4800, Y: 100 }, { X: 4800, Y: 9900 }, { X: 100, Y: 9900 }] : [], observedAt: new Date('2026-10-21T00:00:00Z'), lastObservedAt: new Date('2026-10-21T23:59:00Z'), nameEffectiveAt: new Date('2026-10-21T00:00:00Z'), displayName: 'Entrance' });
    function related(row: Row): Row { return { ...row, enrichment:tables.notificationIntent!.find(i=>i.parentId===row.id)??null, event: tables.securityEvent!.find(e => e.id === row.eventId), evaluation: tables.notificationEvaluation!.find(e => e.id === row.evaluationId), intent: tables.notificationIntent!.find(e => e.evaluationId === row.id) ?? null, attempts: tables.notificationAttempt!.filter(e => e.intentId === row.id), notificationEvaluations: tables.notificationEvaluation!.filter(e => e.eventId === row.id) }; }
    function match(row: Row, where: Row = {}): boolean {
        return Object.entries(where).every(([key, v]) => {
            if (key === 'OR')
                return (v as Row[]).some(w => match(row, w));
            if (['sourceInstallationId_eventId', 'sourceInstallationId_scopeKey', 'intentId_ordinal'].includes(key))
                return match(row, v as Row);
            const value = related(row)[key];
            if (v instanceof Date)
                return value instanceof Date && value.getTime() === v.getTime();
            if (v && typeof v === 'object') {
                const op = v as Row;
                if ('none' in op)
                    return !(value as Row[]).some(r => match(r, op.none as Row));
                return Object.entries(op).every(([k, x]) => {
                    const a = value instanceof Date ? value.getTime() : value as number | string, b = x instanceof Date ? x.getTime() : x as number | string;
                    if (k === 'gte')
                        return a >= b;
                    if (k === 'gt')
                        return a > b;
                    if (k === 'lte')
                        return a <= b;
                    if (k === 'lt')
                        return a < b;
                    if (k === 'not')
                        return value !== x;
                    if (k === 'in')
                        return (x as unknown[]).includes(value);
                    return !!value && match(value as Row, op);
                });
            }
            return value === v;
        });
    }
    function project(row: Row, a: Args = {}): Row {
        const r = related(row);
        if (!a.select && !a.include)
            return { ...row };
        const out: Row = a.include ? { ...row } : {};
        for (const [k, v] of Object.entries(a.select ?? a.include ?? {})) {
            if (v === true)
                out[k] = r[k];
            else if (v && typeof v === 'object') {
                const nested = v as Args;
                out[k] = Array.isArray(r[k]) ? (r[k] as Row[]).slice(0, nested.take).map(o => project(o, nested)) : r[k] ? project(r[k] as Row, nested) : null;
            }
        }
        return out;
    }
    function list(name: string, a: Args = {}) {
        let rows = tables[name]!.filter(r => match(r, a.where));
        const order = Array.isArray(a.orderBy) ? a.orderBy : a.orderBy ? [a.orderBy] : [];
        rows = rows.toSorted((a, b) => {
            for (const rule of order)
                for (const [key, dir] of Object.entries(rule)) {
                    const x = a[key] instanceof Date ? (a[key] as Date).getTime() : a[key] as string, y = b[key] instanceof Date ? (b[key] as Date).getTime() : b[key] as string;
                    if (x !== y)
                        return (x! < y! ? -1 : 1) * (dir === 'desc' ? -1 : 1);
                }
            return 0;
        });
        return rows.slice(0, a.take).map(r => project(r, a));
    }
    const assign=(row:Row,data:Row|undefined)=>{for(const[k,v]of Object.entries(data??{})){if(v&&typeof v==='object'&&'increment'in v)row[k]=Number(row[k]??0)+Number(v.increment);else row[k]=v;}};
    const api: Record<string, unknown> = {};
    for (const name of Object.keys(tables)) {
        const create = (a: Args) => {
            const row: Row = { mode:'LIVE', parentId:null, id: randomUUID(), createdAt: clock, updatedAt: clock, attemptCount: 0, leaseToken: null, leaseUntil: null, lastError: null, deliveredAt: null, lastDeliveredAt: null, reservationId: null, finishedAt: null, httpStatus: null, errorCode: null, durationMs: null, mayHaveReached: false, receipt: null, ...a.data ?? a.create };
            if (name === 'notificationIntent' && row.parentId && tables[name]!.some(r=>r.parentId===row.parentId))throw Error('unique enrichment');
            if (name === 'notificationIntent' && tables[name]!.some(r => row.eventId!==null&&row.eventId!==undefined&&r.eventId === row.eventId))
                throw Error('unique event intent');
            if (name === 'notificationEvaluation' && tables[name]!.some(r => row.eventId!==null&&row.eventId!==undefined&&r.eventId === row.eventId))
                throw Error('unique event evaluation');
            if (name === 'notificationAttempt' && tables[name]!.some(r => r.intentId === row.intentId && r.ordinal === row.ordinal))
                throw Error('unique attempt');
            tables[name]!.push(row);
            return project(row, a);
        };
        api[name] = { findMany: vi.fn(async (a: Args = {}) => list(name, a)), findFirst: vi.fn(async (a: Args) => list(name, a)[0] ?? null), findUnique: vi.fn(async (a: Args) => list(name, a)[0] ?? null), findUniqueOrThrow: vi.fn(async (a: Args) => {
                const row = list(name, a)[0];
                if (!row)
                    throw Error('not found');
                return row;
            }), create: vi.fn(async (a: Args) => create(a)), update: vi.fn(async (a: Args) => {
                const row = tables[name]!.find(r => match(r, a.where));
                if (!row)
                    throw Error('update missing');
                assign(row, a.data);
                return project(row, a);
            }), updateMany: vi.fn(async (a: Args) => { const rows = tables[name]!.filter(r => match(r, a.where)); rows.forEach(r => assign(r, a.data)); return { count: rows.length }; }), upsert: vi.fn(async (a: Args) => {
                const row = tables[name]!.find(r => match(r, a.where));
                if (row) {
                    assign(row, a.update);
                    return project(row, a);
                }
                return create(a);
            }) };
    }
    const raw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('pg_advisory_xact_lock'))
            return [{}];
        if (sql.includes('NotificationEvaluation'))
            return list('notificationEvaluation', { where: { sourceInstallationId: values[0], kind: 'LIVE', state: { in: ['PENDING', 'WAITING'] }, availableAt: { lte: values[1] } }, orderBy: [{ availableAt: 'asc' }, { eventId: 'asc' }], take: 1 }).map(r => ({ id: r.id }));
        return list('notificationIntent', { where: { sourceInstallationId: values[0],mode:{in:sql.includes("mode IN ('LIVE','UPDATE')")?['LIVE','UPDATE']:['LIVE']}, state: { in: ['READY', 'RETRY'] }, nextAttemptAt: { lte: values[1] } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 1 }).map(r => ({ id: r.id }));
    });
    api.$queryRaw = raw;
    api.$executeRaw = vi.fn(async () => 0);
    const prisma = { ...api, $transaction: <T>(fn: (tx: unknown) => Promise<T>) => {
            const operation = chain.then(async () => {
                const copy = structuredClone(tables);
                try {
                    return await fn(api);
                }
                catch (error) {
                    for (const name of Object.keys(tables))
                        tables[name] = copy[name]!;
                    throw error;
                }
            });
            chain = operation.catch(() => { });
            return operation;
        } } as unknown as PrismaClient;
    function event(n: number, channel = 1) {
        const at = new Date('2026-10-21T12:00:01Z'), row = { id: id(100 + n), sourceInstallationId: installation, nvrChannel: channel, camera: 'Camera ' + channel, firstReceivedAt: at, occurredAt: at, processing: { status: 'SKIPPED', reason: 'ai_capacity' }, analysis: null, snapshots: [{ id: id(200 + n) }], objects: [{ id: id(300 + n), category: 'PERSON', coordinateStatus: 'VALID', sourceTimestamp: at, xMin: 1000, yMin: 3000, xMax: 2000, yMax: 4000, fullFrameSnapshotId: id(200 + n), memberships: [] as {
                        zoneVersionId: string;
                        relationship: string;
                    }[] }] };
        tables.securityEvent!.push(row);
        tables.eventSnapshot!.push({ id: id(200 + n), eventId: row.id, origin: 'NVR_PUSH', status: 'RECEIVED', sha256: 'a'.repeat(64) });
        return row;
    }
    return { prisma, tables, configuration, event, raw, now: () => clock, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, setTime: (date: Date) => { clock = date; } };
}
