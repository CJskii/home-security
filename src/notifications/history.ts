import { z } from 'zod';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { notificationConfiguration } from './contracts.js';
const decision = z.object({ ruleId: z.uuid(), ruleName: z.string().max(80), outcome: z.string().max(32), reason: z.string().max(64), scopeKey: z.string().max(64), cooldownUntil: z.iso.datetime().nullable(), reservationId: z.uuid().nullable(), objectIds: z.array(z.uuid()).max(128), zoneVersionIds: z.array(z.uuid()).max(512) }).strict();
const attempt = z.object({ ordinal: z.number().int(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), outcome: z.string(), httpStatus: z.number().nullable(), errorCode: z.string().nullable(), durationMs: z.number().nullable(), mayHaveReached: z.boolean(), receipt: z.string().nullable() }).strict();
const ledgerSummary=z.object({ id: z.uuid(), state: z.string(), attemptCount: z.number().int(), createdAt: z.iso.datetime(), deliveredAt: z.iso.datetime().nullable(), lastError: z.string().nullable(), nextAttemptAt: z.iso.datetime(), attempts: z.array(attempt).max(5) }).strict();
export const deliveryHistoryResponse = z.object({ available: z.boolean(), producerEnabled: z.boolean(), deliveryEnabled: z.boolean(), nextCursor: z.uuid().nullable(), items: z.array(z.object({
        id: z.uuid(), eventId: z.uuid(), createdAt: z.iso.datetime(), revision: z.number().int(), state: z.string(), receivedAt: z.iso.datetime().nullable(), channel: z.number().int().nullable(), deliveryHeldReason: z.string().nullable(), decisions: z.array(decision).max(10),
        intent: ledgerSummary.extend({enrichment:ledgerSummary.nullable().optional()}).nullable(),
    }).strict()).max(50) }).strict();
const intentSelect={id: true, state: true, attemptCount: true, createdAt: true, deliveredAt: true, lastError: true, nextAttemptAt: true, attempts: { orderBy: { ordinal: 'asc' }, take: 5, select: { ordinal: true, startedAt: true, finishedAt: true, outcome: true, httpStatus: true, errorCode: true, durationMs: true, mayHaveReached: true, receipt: true } }} as const;
const result = z.object({ receivedAt: z.iso.datetime().nullable().default(null), channel: z.number().int().nullable().default(null), deliveryHeldReason: z.string().nullable().default(null), decisions: z.array(decision).max(10).default([]) });
export type DeliveryHistory = z.infer<typeof deliveryHistoryResponse>;
export async function notificationHistory(prisma: PrismaClient, installation: string, before?: string, attemptedOnly = false, eventIds?: readonly string[]): Promise<DeliveryHistory> {
    try {
        return await prisma.$transaction(async (tx) => {
            const cfg = await tx.notificationConfiguration.findUnique({ where: { sourceInstallationId: installation } });
            let cursor: Prisma.NotificationEvaluationWhereInput = {};
            if (before) {
                const prior = await tx.notificationEvaluation.findFirst({ where: { id: before, sourceInstallationId: installation, kind: 'LIVE' }, select: { id: true, createdAt: true } });
                if (!prior)
                    throw new Error('Unknown history cursor');
                cursor = { OR: [{ createdAt: { lt: prior.createdAt } }, { createdAt: prior.createdAt, id: { lt: prior.id } }] };
            }
            const rows = await tx.notificationEvaluation.findMany({ where: { sourceInstallationId: installation, kind: 'LIVE', ...(attemptedOnly ? { intent: { isNot: null } } : {}), ...(eventIds ? {eventId:{in:[...eventIds]}} : {}), ...cursor }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
                select: { id: true, eventId: true, createdAt: true, configurationRevision: true, state: true, result: true, intent: { select: { ...intentSelect,enrichment:{select:intentSelect} } } } });
            const items = rows.slice(0, 50).map(row => { const r = result.parse(row.result); return { id: row.id, eventId: row.eventId, createdAt: row.createdAt.toISOString(), revision: row.configurationRevision, state: row.state, ...r, intent: row.intent ? { ...row.intent, createdAt: row.intent.createdAt.toISOString(), deliveredAt: row.intent.deliveredAt?.toISOString() ?? null, nextAttemptAt: row.intent.nextAttemptAt.toISOString(), enrichment:row.intent.enrichment?{...row.intent.enrichment,createdAt:row.intent.enrichment.createdAt.toISOString(),deliveredAt:row.intent.enrichment.deliveredAt?.toISOString()??null,nextAttemptAt:row.intent.enrichment.nextAttemptAt.toISOString(),attempts:row.intent.enrichment.attempts.map(a=>({...a,startedAt:a.startedAt.toISOString(),finishedAt:a.finishedAt?.toISOString()??null}))}:null, attempts: row.intent.attempts.map(a => ({ ...a, startedAt: a.startedAt.toISOString(), finishedAt: a.finishedAt?.toISOString() ?? null })) } : null }; });
            return deliveryHistoryResponse.parse({ available: true, producerEnabled: cfg?.producerEnabled ?? false, deliveryEnabled: cfg ? notificationConfiguration.parse(cfg.configuration).deliveryEnabled : false, nextCursor: rows.length > 50 ? rows[49]!.id : null, items });
        }, { isolationLevel: 'RepeatableRead', timeout: 5000 });
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['P2021', 'P2022'].includes(String(error.code)))
            return { available: false, producerEnabled: false, deliveryEnabled: false, nextCursor: null, items: [] };
        throw error;
    }
}
