import { enrichmentPayload, ENRICHMENT_WINDOW_MS } from './enrichment.js';
import { mediaLink, type NotificationMedia } from './media.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { locationCatalog } from '../events/locations.js';
import { notificationConfiguration } from './contracts.js';
import { projectNotificationEvent } from './geometry.js';
import { cooldownScopeKey, matchNotificationRule } from './evaluate.js';
import { webhookPayload, retryDelay, type DeliveryClaim, type DeliveryResult } from './delivery-contract.js';
export const PIPELINE = { maxAgeMs: 900000, leaseMs: 30000, maxAttempts: 5, metadataRetryMs: 30000 } as const;
export interface PipelineOptions {
    media?: NotificationMedia | undefined;
    updatesEnabled?: boolean;
    updatesFrom?: Date | null;
    installation: string;
    deliveryEnabled: boolean;
    activatedAt: Date | null;
    destinationId: string;
    destinationRevision?:number;
    dashboardOrigin: string;
}
export interface NotificationPipeline {
    reconcile(): Promise<void>;
    enrich?(): Promise<void>;
    evaluateNext(): Promise<boolean>;
    claim(): Promise<DeliveryClaim | null>;
    authorize(claim: DeliveryClaim): Promise<boolean>;
    finish(claim: DeliveryClaim, result: DeliveryResult): Promise<void>;
    recover(): Promise<void>;
}
const asJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const resultSchema = z.object({ outcome: z.enum(['accepted', 'retry', 'failed', 'uncertain']), code: z.string().regex(/^[a-z0-9_]{1,64}$/), status: z.number().int().min(100).max(599).nullable(), mayHaveReached: z.boolean(), durationMs: z.number().int().min(0).max(2147483647), receipt: z.enum(['accepted', 'rejected']).nullable(), retryAfterMs: z.number().int().min(0).max(300000).optional() }).strict();
export function createNotificationPipeline(prisma: PrismaClient, options: PipelineOptions, now: () => Date = () => new Date()): NotificationPipeline {
    const installation = z.uuid().parse(options.installation);
    async function locked<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        return prisma.$transaction(async (tx) => {
            await tx.$executeRaw `SET LOCAL lock_timeout = '2s'`;
            await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`notifications:${installation}`},0))::text AS locked`;
            return fn(tx);
        }, { timeout: 10000, maxWait: 2000 });
    }
    async function armed(tx: Prisma.TransactionClient, eventAt?: Date) {
        const cfg = await tx.notificationConfiguration.findUnique({ where: { sourceInstallationId: installation } });
        return cfg && cfg.producerEnabled && cfg.liveFromAt && (!eventAt || eventAt >= cfg.liveFromAt) ? cfg : null;
    }
    async function canSend(tx: Prisma.TransactionClient, eventAt: Date, revision?: number) {
        const cfg = await armed(tx, eventAt);
        return Boolean(options.deliveryEnabled && options.activatedAt && now() >= options.activatedAt && eventAt >= options.activatedAt && cfg && (options.destinationRevision===undefined||cfg.deliveryRevision===options.destinationRevision) && (revision === undefined || cfg.revision === revision) && notificationConfiguration.parse(cfg.configuration).deliveryEnabled);
    }
    const deliveryInclude={event:{select:{firstReceivedAt:true}},evaluation:{select:{configurationRevision:true}}} as const;
    async function sourceFor(tx:Prisma.TransactionClient,i:{mode:string;parentId:string|null;payload:unknown;createdAt:Date}) {
        if(i.mode!=='UPDATE')return null;
        if(!options.updatesEnabled||!options.updatesFrom||!i.parentId)return null;
        const parent=await tx.notificationIntent.findFirst({where:{id:i.parentId,mode:'LIVE',sourceInstallationId:installation,state:'DELIVERED',createdAt:{gte:options.updatesFrom}},include:deliveryInclude});
        const payload=webhookPayload.parse(i.payload);
        if(!parent?.event||!parent.evaluation||payload.notificationId!==parent.id||payload.eventId!==parent.eventId||now().getTime()-parent.event.firstReceivedAt.getTime()>ENRICHMENT_WINDOW_MS)return null;
        const latest=await tx.eventAnalysis.findUnique({where:{eventId:parent.eventId!},select:{revision:true}});
        if(latest?.revision!==payload.enrichment?.revision)return null;
        return parent;
    }
    async function release(tx: Prisma.TransactionClient, id: string) { await tx.notificationCooldown.updateMany({ where: { sourceInstallationId: installation, reservationId: id }, data: { reservationId: null } }); }
    async function cancel(tx: Prisma.TransactionClient, id: string, reason: string) { await release(tx, id); await tx.notificationIntent.update({ where: { id }, data: { state: 'CANCELLED', leaseToken: null, leaseUntil: null, lastError: reason } }); }
    async function recover() {
        await locked(async (tx) => {
            const stale = await tx.notificationIntent.findMany({ where: { sourceInstallationId: installation, mode:{in:['LIVE','UPDATE']}, state: 'SENDING', leaseUntil: { lte: now() } }, take: 100 });
            for (const intent of stale) {
                await tx.notificationAttempt.updateMany({ where: { intentId: intent.id, leaseToken: intent.leaseToken!, outcome: 'STARTED' }, data: { outcome: 'UNCERTAIN', finishedAt: now(), mayHaveReached: true, errorCode: 'worker_lease_expired' } });
                await tx.notificationIntent.update({ where: { id: intent.id }, data: { state: 'UNCERTAIN', lastError: 'worker_lease_expired', leaseUntil: null, leaseToken: null } });
            }
            const expired = await tx.notificationIntent.findMany({ where: { sourceInstallationId: installation, mode:{in:['LIVE','UPDATE']}, state: { in: ['READY', 'RETRY'] }, expiresAt: { lte: now() } }, take: 100 });
            for (const i of expired)
                await cancel(tx, i.id, 'intent_expired');
        });
    }
    return {
        recover,
        async enrich(){
            if(!options.updatesEnabled||!options.updatesFrom||!options.deliveryEnabled)return;
            await locked(async tx=>{
                const parents=await tx.notificationIntent.findMany({where:{sourceInstallationId:installation,mode:'LIVE',state:'DELIVERED',createdAt:{gte:options.updatesFrom!},event:{firstReceivedAt:{gte:new Date(now().getTime()-ENRICHMENT_WINDOW_MS)}},enrichment:null},include:deliveryInclude,orderBy:{createdAt:'desc'},take:20});
                for(const parent of parents){
                    if(!parent.event||!parent.evaluation||!await canSend(tx,parent.event.firstReceivedAt,parent.evaluation.configurationRevision))continue;
                    const event=await tx.securityEvent.findUnique({where:{id:parent.eventId!},select:{processing:{select:{status:true}},analysis:{include:{objectAnalyses:true}}}});
                    if(event?.processing?.status!=='COMPLETE'||!event.analysis)continue;
                    const initial=webhookPayload.parse(parent.payload),payload=enrichmentPayload(initial,event.analysis,parent.createdAt,now());
                    if(!payload)continue;
                    await tx.notificationIntent.create({data:{mode:'UPDATE',parentId:parent.id,eventId:null,evaluationId:null,sourceInstallationId:installation,destinationId:parent.destinationId,payload:asJson(webhookPayload.parse(payload)),state:'READY',nextAttemptAt:now(),expiresAt:new Date(Math.min(Date.parse(initial.timestamps.receivedAt)+ENRICHMENT_WINDOW_MS,parent.expiresAt.getTime()))}});
                }
            });
        },
        async reconcile() {
            await locked(async (tx) => {
                const cfg = await armed(tx);
                if (!cfg)
                    return;
                // A committed later source report makes waiting work due immediately.
                // NOTIFY is emitted by the existing event trigger at transaction commit.
                // No receiver/AI dependency or rearming terminal/historical evaluations.
                await tx.$executeRaw`UPDATE "NotificationEvaluation" n SET "availableAt"=${now()}
                  FROM "SecurityEvent" e WHERE n."eventId"=e.id AND n."sourceInstallationId"=${installation}::uuid
                    AND n.kind='LIVE' AND n.state='WAITING' AND n."availableAt">${now()}
                    AND e."firstReceivedAt">=${new Date(Math.max(cfg.liveFromAt!.getTime(),now().getTime()-PIPELINE.maxAgeMs))}
                    AND e."lastReceivedAt">COALESCE((n.result->>'metadataReceivedAt')::timestamptz,n."createdAt")`;

                // Persistent scan cursor repairs a missed NOTIFY/failed optional trigger write.
                // No startup backfill: only events beyond the separately approved live cutoff.
                const rows = await tx.securityEvent.findMany({ where: { sourceInstallationId: installation, firstReceivedAt: { gte: cfg.liveFromAt! }, ...(cfg.scannedAt && cfg.scannedId ? { OR: [{ firstReceivedAt: { gt: cfg.scannedAt } }, { firstReceivedAt: cfg.scannedAt, id: { gt: cfg.scannedId } }] } : {}) }, orderBy: [{ firstReceivedAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, firstReceivedAt: true } });
                const repair = await tx.securityEvent.findMany({ where: { sourceInstallationId: installation, firstReceivedAt: { gte: new Date(Math.max(cfg.liveFromAt!.getTime(), now().getTime() - PIPELINE.maxAgeMs)) }, notificationEvaluations: { none: { kind: 'LIVE' } } }, orderBy: [{ firstReceivedAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, firstReceivedAt: true } });
                for (const e of [...rows, ...repair])
                    await tx.notificationEvaluation.upsert({ where: { sourceInstallationId_eventId: { sourceInstallationId: installation, eventId: e.id } }, create: { sourceInstallationId: installation, eventId: e.id, fingerprint: 'live:' + e.id, configurationRevision: cfg.revision, configuration: cfg.configuration as Prisma.InputJsonValue, result: { configurationRecovered: true }, kind: 'LIVE', state: 'PENDING', availableAt: new Date(e.firstReceivedAt.getTime() + 2000) }, update: {} });
                const last = rows.at(-1);
                if (last)
                    await tx.notificationConfiguration.update({ where: { sourceInstallationId: installation }, data: { scannedAt: last.firstReceivedAt, scannedId: last.id, updatedAt: cfg.updatedAt } });
            });
        },
        async evaluateNext() {
            return await locked(async (tx) => {
                const jobs = await tx.$queryRaw<{
                    id: string;
                }[]> `SELECT id FROM "NotificationEvaluation" WHERE "sourceInstallationId"=${installation}::uuid AND kind='LIVE' AND state IN ('PENDING','WAITING') AND "availableAt"<=${now()} ORDER BY "availableAt","eventId" FOR UPDATE SKIP LOCKED LIMIT 1`;
                const job = jobs[0];
                if (!job)
                    return false;
                const evaluation = await tx.notificationEvaluation.findUniqueOrThrow({ where: { id: job.id } });
                const row = await tx.securityEvent.findFirst({ where: { id: evaluation.eventId!, sourceInstallationId: installation }, select: { id: true, nvrChannel: true, camera: true, firstReceivedAt: true, occurredAt: true, lastReceivedAt: true,
                        processing: { select: { status: true } }, analysis: { select: { revision: true, shortDescription: true } },
                        objects: { take: 129, orderBy: { id: 'asc' }, select: { id: true, category: true, coordinateStatus: true, sourceTimestamp: true, xMin: true, xMax: true, yMin: true, yMax: true, fullFrameSnapshotId: true, cropSnapshotId: true, memberships: { take: 17, orderBy: { zoneVersionId: 'asc' }, select: { zoneVersionId: true, relationship: true } } } } } });
                if (!row)
                    throw new Error('Notification source unavailable');
                const cfg = notificationConfiguration.parse(evaluation.configuration), expired = now().getTime() - row.firstReceivedAt.getTime() >= PIPELINE.maxAgeMs;
                const catalog=await locationCatalog(tx, installation);
                const event = projectNotificationEvent(row, catalog, now());
                const matches = cfg.rules.map(rule => ({ rule, match: matchNotificationRule(rule, event) }));
                const recovered = evaluation.result && typeof evaluation.result === 'object' && !Array.isArray(evaluation.result) && evaluation.result.configurationRecovered === true;
                const current = await tx.notificationConfiguration.findUnique({ where: { sourceInstallationId: installation } });
                const recoveredPolicyTooNew = recovered && current && current.updatedAt > row.firstReceivedAt;
                const allowed = cfg.deliveryEnabled && await canSend(tx, row.firstReceivedAt, evaluation.configurationRevision), held = expired ? 'event_expired' : recoveredPolicyTooNew ? 'configuration_snapshot_unavailable' : !allowed ? 'delivery_disabled_or_configuration_changed' : null;
                const decisions = matches.map(({ rule, match }) => ({ ruleId: rule.id, ruleName: rule.name, outcome: match.kind === 'match' ? 'eligible' : match.kind, reason: match.reason, scopeKey: cooldownScopeKey(rule, row.nvrChannel), objectIds: match.objects.map(o => o.id), cooldownUntil: null as string | null, reservationId: null as string | null, zoneVersionIds: [...new Set(match.objects.flatMap(o => o.versionIds))] }));
                const eligible: typeof matches = [];
                if (!held)
                    for (const item of matches.filter(m => m.match.kind === 'match').sort((a, b) => cooldownScopeKey(a.rule, row.nvrChannel).localeCompare(cooldownScopeKey(b.rule, row.nvrChannel)))) {
                        const key = cooldownScopeKey(item.rule, row.nvrChannel);
                        const cooldown = await tx.notificationCooldown.upsert({ where: { sourceInstallationId_scopeKey: { sourceInstallationId: installation, scopeKey: key } }, create: { sourceInstallationId: installation, scopeKey: key, ruleId: item.rule.id, channel: item.rule.cooldownScope === 'rule_camera' ? row.nvrChannel : 0, cooldownSeconds: item.rule.cooldownSeconds }, update: {} });
                        const d = decisions.find(d => d.ruleId === item.rule.id)!;
                        if (cooldown.reservationId) {
                            d.outcome = 'reserved';
                            d.reason = 'cooldown_reserved';
                            d.reservationId = cooldown.reservationId;
                            continue;
                        }
                        if (cooldown.lastDeliveredAt && now().getTime() < cooldown.lastDeliveredAt.getTime() + item.rule.cooldownSeconds * 1000) {
                            d.outcome = 'cooldown';
                            d.reason = 'cooldown_after_delivery';
                            d.cooldownUntil = new Date(cooldown.lastDeliveredAt.getTime() + item.rule.cooldownSeconds * 1000).toISOString();
                            continue;
                        }
                        eligible.push(item);
                    }
                const prior = typeof evaluation.result === 'object' && evaluation.result !== null && !Array.isArray(evaluation.result) ? evaluation.result as Record<string, Prisma.JsonValue> : {};
                const retryOnMetadata = !expired && (matches.some(m => m.match.kind === 'uncertain' || m.match.kind === 'unmatched' && ['zone_not_selected', 'category_not_selected'].includes(m.match.reason)) || decisions.some(d => d.outcome === 'reserved')) && !eligible.length && !held;
                const result = { configurationRecovered: recovered, algorithm: 'source_zone_rules_v1', receivedAt: row.firstReceivedAt.toISOString(), channel: row.nvrChannel, metadataReceivedAt: row.lastReceivedAt?.toISOString(), decisions, deliveryHeldReason: held, retryOnMetadata,
                    runs: [...(Array.isArray(prior.runs) ? prior.runs.slice(-7) : []), { at: now().toISOString(), held, counts: decisions.reduce<Record<string, number>>((n, d) => { n[d.outcome] = (n[d.outcome] ?? 0) + 1; return n; }, {}) }] };
                if (eligible.length) {
                    const existing = await tx.notificationIntent.findUnique({ where: { eventId: row.id } });
                    if (!existing) {
                        const id = randomUUID(), objects = [...new Map(eligible.flatMap(m => m.match.objects).map(o => [o.id, o])).values()];
                        const anchorIds = [...new Set(objects.map(o=>row.objects.find(s=>s.id===o.id)!.fullFrameSnapshotId).filter((id): id is string => Boolean(id)))].slice(0, 1);
                        const snapshots = await tx.eventSnapshot.findMany({ where: { eventId: row.id, id: { in: anchorIds }, origin: 'NVR_PUSH', status: 'RECEIVED', sha256: { not: null } }, take: 2, orderBy: { id: 'asc' }, select: { id: true } });
                        const status = row.analysis ? 'completed' : row.processing?.status === 'SKIPPED' ? 'skipped' : ['FAILED', 'INTERRUPTED'].includes(row.processing?.status ?? '') ? 'failed' : 'pending';
                        const payload = webhookPayload.parse({ version: 1, type: 'security.event',action:'create',test:false,notification:{title:`Home Security · ${row.camera??'Camera '+row.nvrChannel}`,message:objects.map(o=>o.category.toLowerCase().replaceAll('_',' ')).filter((v,i,a)=>a.indexOf(v)===i).join(', ')+' detected.'}, notificationId: id, eventId: row.id, idempotencyKey: `notification:v1:${installation}:${row.id}`, camera: { channel: row.nvrChannel, name: row.camera ?? `Camera ${row.nvrChannel}` }, timestamps: { receivedAt: row.firstReceivedAt.toISOString(), occurredAt: row.occurredAt?.toISOString() ?? null }, rules: eligible.map(m => ({ id: m.rule.id, name: m.rule.name, reason: m.match.reason })), objects: objects.map(o => ({ id: o.id, category: o.category, zoneIds: o.reliableZoneIds ?? o.zoneIds, zoneNames:[...new Map(catalog.filter(z=>(o.reliableZoneIds??o.zoneIds).includes(z.zoneId)).map(z=>[z.zoneId,{id:z.zoneId,name:z.name}])).values()], zoneVersionIds: o.versionIds, basis: o.basis, locationReason: o.reason, uncertain: o.status !== 'MATCHED' && !o.reliableZoneIds?.length })), ai: { status, revision: row.analysis?.revision ?? null, summary: row.analysis?.shortDescription ?? null }, images: [...snapshots].sort((a,b)=>anchorIds.indexOf(a.id)-anchorIds.indexOf(b.id)).map(s => ({ ...(options.media?{delivery:mediaLink(options.media,row.id,s.id,id,now(), row.objects.filter(o=>objects.some(m=>m.id===o.id)&&o.fullFrameSnapshotId===s.id&&o.coordinateStatus==='VALID').slice(0,8).map(o=>[o.xMin!,o.yMin!,o.xMax!,o.yMax!]))}:{}),id: s.id, path: `/api/events/${row.id}/images/${s.id}`, authentication: 'dashboard_session_or_service_bearer' })), dashboardUrl: options.dashboardOrigin + '/explore?event=' + row.id });
                        await tx.notificationIntent.create({ data: { id, eventId: row.id, evaluationId: evaluation.id, sourceInstallationId: installation, destinationId: options.destinationId, payload: asJson(payload), state: 'READY', nextAttemptAt: now(), expiresAt: new Date(row.firstReceivedAt.getTime() + PIPELINE.maxAgeMs) } });
                        for (const e of eligible)
                            await tx.notificationCooldown.update({ where: { sourceInstallationId_scopeKey: { sourceInstallationId: installation, scopeKey: cooldownScopeKey(e.rule, row.nvrChannel) } }, data: { reservationId: id, cooldownSeconds: e.rule.cooldownSeconds } });
                    }
                }
                await tx.notificationEvaluation.update({ where: { id: evaluation.id }, data: { state: retryOnMetadata ? 'WAITING' : 'EVALUATED', availableAt: retryOnMetadata ? new Date(now().getTime() + PIPELINE.metadataRetryMs) : null, result: asJson(result) } });
                return true;
            }) ?? false;
        },
        async claim() {
            if (!options.deliveryEnabled)
                return null;
            return locked(async (tx) => {
                const rows = await tx.$queryRaw<{
                    id: string;
                }[]> `SELECT id FROM "NotificationIntent" WHERE "sourceInstallationId"=${installation}::uuid AND mode IN ('LIVE','UPDATE') AND state IN ('READY','RETRY') AND "nextAttemptAt"<=${now()} ORDER BY CASE WHEN mode='LIVE' THEN 0 ELSE 1 END,"nextAttemptAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
                if (!rows[0])
                    return null;
                const i = await tx.notificationIntent.findUniqueOrThrow({ where: { id: rows[0].id }, include: deliveryInclude });
                const source=i.mode==='UPDATE'?await sourceFor(tx,i):i;
                if (!source?.event || !source.evaluation || !await canSend(tx, source.event.firstReceivedAt, source.evaluation.configurationRevision) || i.destinationId !== options.destinationId || i.expiresAt <= now() || i.attemptCount >= PIPELINE.maxAttempts) {
                    await cancel(tx, i.id, 'delivery_not_authorized');
                    return null;
                }
                const token = randomUUID(), ordinal = i.attemptCount + 1;
                await tx.notificationIntent.update({ where: { id: i.id }, data: { state: 'SENDING', attemptCount: ordinal, leaseToken: token, leaseUntil: new Date(now().getTime() + PIPELINE.leaseMs) } });
                await tx.notificationAttempt.create({ data: { intentId: i.id, ordinal, leaseToken: token, startedAt: now(), outcome: 'STARTED' } });
                return { id: i.id, mode:i.mode==='UPDATE'?'UPDATE':'LIVE', eventId: source.eventId!, token, ordinal, payload: webhookPayload.parse(i.payload) };
            });
        },
        async authorize(claim) {
            return await locked(async (tx) => {
                const i = await tx.notificationIntent.findFirst({ where: { id: claim.id, sourceInstallationId: installation, mode:{in:['LIVE','UPDATE']}, state: 'SENDING', leaseToken: claim.token, leaseUntil: { gt: now() } }, include: deliveryInclude });
                const source=i?.mode==='UPDATE'?await sourceFor(tx,i):i;
                return Boolean(i && source?.event && source.evaluation && await canSend(tx, source.event.firstReceivedAt, source.evaluation.configurationRevision) && i.destinationId === options.destinationId);
            }) ?? false;
        },
        async finish(claim, input) {
            const outcome = resultSchema.parse(input);
            await locked(async (tx) => {
                const i = await tx.notificationIntent.findFirst({ where: { id: claim.id, sourceInstallationId: installation, mode:{in:['LIVE','UPDATE']}, state: 'SENDING', leaseToken: claim.token, leaseUntil: { gt: now() } } });
                if (!i)
                    return;
                const retryAt = new Date(now().getTime() + Math.max(retryDelay(claim.ordinal), outcome.retryAfterMs ?? 0));
                const state = outcome.outcome === 'accepted' ? 'DELIVERED' : outcome.outcome === 'uncertain' ? 'UNCERTAIN' : outcome.outcome === 'retry' && i.attemptCount < PIPELINE.maxAttempts && retryAt < i.expiresAt ? 'RETRY' : 'FAILED';
                await tx.notificationAttempt.update({ where: { intentId_ordinal: { intentId: i.id, ordinal: claim.ordinal } }, data: { outcome: outcome.outcome.toUpperCase(), finishedAt: now(), httpStatus: outcome.status, errorCode: outcome.outcome === 'accepted' ? null : outcome.code, durationMs: outcome.durationMs, mayHaveReached: outcome.mayHaveReached, receipt: outcome.receipt } });
                if (state === 'DELIVERED' && i.mode!=='UPDATE')
                    await tx.notificationCooldown.updateMany({ where: { sourceInstallationId: installation, reservationId: i.id }, data: { lastDeliveredAt: now(), reservationId: null } });
                if (state === 'FAILED' && i.mode!=='UPDATE')
                    await release(tx, i.id);
                await tx.notificationIntent.update({ where: { id: i.id }, data: { state, nextAttemptAt: retryAt, leaseToken: null, leaseUntil: null, lastError: state === 'DELIVERED' ? null : outcome.code, ...(state === 'DELIVERED' ? { deliveredAt: now() } : {}) } });
            });
        },
    };
}
