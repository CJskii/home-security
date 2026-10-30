import { testEnrichmentPayload, ENRICHMENT_WINDOW_MS } from './enrichment.js';
import { locationCatalog } from '../events/locations.js';
import { projectNotificationEvent } from './geometry.js';
import { mediaLink, type NotificationMedia } from './media.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { credentialCipher } from './destination-crypto.js';
import { createWebhookSender, webhookTarget, type WebhookTarget } from './webhook.js';
import { webhookPayload, type DeliveryResult, type WebhookPayload } from './delivery-contract.js';
import { samplePayload } from './sample-payload.js';
import { pinnedDestination, deliverySave, deliveryPreview, deliverySettings, testOutcome, DeliveryConfigurationError, type PinnedDestination } from './destination-contract.js';
export interface DestinationOptions {
    media?: NotificationMedia | undefined;
    key?: string | undefined;
    approved: PinnedDestination[];
    dashboardOrigin: string;
    forbiddenSecrets?: string[];
}
export interface DeliveryStore {
    read(installation: string): Promise<z.infer<typeof deliverySettings>>;
    save(installation: string, input: z.infer<typeof deliverySave>): Promise<z.infer<typeof deliverySettings>>;
    preview(installation: string, sampleEventId?: string, updateTestId?: string): Promise<z.infer<typeof deliveryPreview>>;
    test(installation: string, confirmation: string, signal?: AbortSignal): Promise<z.infer<typeof testOutcome>>;
}
export function configuredTarget(row: {
    sourceInstallationId: string;
    deliveryConfiguration: unknown;
    deliverySecret: string | null;
    deliveryRevision: number;
}, options: DestinationOptions, targetFactory = webhookTarget): WebhookTarget {
    if (!options.key || !row.deliverySecret)
        throw new DeliveryConfigurationError(503, 'signing_credential_unavailable');
    const pin = pinnedDestination.parse(row.deliveryConfiguration), approved = options.approved.find(p => p.url === pin.url && p.address === pin.address && p.allowLanHttp === pin.allowLanHttp);
    if (!approved)
        throw new DeliveryConfigurationError(409, 'destination_approval_required');
    const secret = credentialCipher(options.key).open(row.deliverySecret, row.sourceInstallationId), target = targetFactory({ ...pin, secret });
    return { ...target, id: createHash('sha256').update(target.id + ':' + row.deliveryRevision).digest('hex') };
}
const ticket = z.object({ installation: z.uuid(), revision: z.number().int(), destinationId: z.string().length(64), expiresAt: z.number().int(), payload: webhookPayload }).strict();
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export function createDeliveryStore(prisma: PrismaClient, options: DestinationOptions, dependencies: {
    now?: () => Date;
    targetFactory?: typeof webhookTarget;
    send?: (target: WebhookTarget, payload: WebhookPayload, signal?: AbortSignal) => Promise<DeliveryResult>;
} = {}): DeliveryStore {
    const now = dependencies.now ?? (() => new Date()), targetFactory = dependencies.targetFactory ?? webhookTarget, send = dependencies.send ?? ((target, payload, signal) => createWebhookSender(target)(payload, signal));
    const cipher = options.key ? credentialCipher(options.key) : null;
    async function lock<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, installation: string) { return prisma.$transaction(async (tx) => { await tx.$executeRaw `SET LOCAL lock_timeout='2s'`; await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`notifications:${installation}`},0))::text`; return fn(tx); }, { timeout: 5000, maxWait: 2000 }); }
    function outcome(row: {
        id: string;
        state: string;
        createdAt: Date;
        leaseUntil: Date | null;
        attempts: {
            httpStatus: number | null;
            errorCode: string | null;
            durationMs: number | null;
            receipt: string | null;
            mayHaveReached: boolean;
        }[];
    }) {
        const a = row.attempts[0], expired = row.state === 'SENDING' && row.leaseUntil !== null && row.leaseUntil <= now();
        return testOutcome.parse({ id: row.id, state: expired ? 'UNCERTAIN' : row.state, at: row.createdAt.toISOString(), httpStatus: a?.httpStatus ?? null, code: expired ? 'test_process_outcome_unknown' : a?.errorCode ?? null, durationMs: a?.durationMs ?? null, receipt: a?.receipt ?? null, mayHaveReached: expired || a?.mayHaveReached === true });
    }
    const includeAttempt = { attempts: { orderBy: { ordinal: 'desc' as const }, take: 1 } };
    async function read(installation: string) {
        try {
            const row = await prisma.notificationConfiguration.findUnique({ where: { sourceInstallationId: installation } }), tests = await prisma.notificationIntent.findMany({ where: { sourceInstallationId: installation, mode: 'TEST' }, orderBy: { createdAt: 'desc' }, take: 10, include: includeAttempt });
            const pin = row?.deliveryConfiguration ? pinnedDestination.parse(row.deliveryConfiguration) : null;
            return deliverySettings.parse({ available: true, writable: !!cipher && options.approved.length > 0, revision: row?.deliveryRevision ?? 0, updatedAt: row?.deliveryUpdatedAt?.toISOString() ?? null, configured: pin, secretConfigured: !!row?.deliverySecret, approved: options.approved, globalDeliveryEnabled: !!(row?.configuration as {
                    deliveryEnabled?: boolean;
                } | undefined)?.deliveryEnabled, producerEnabled: row?.producerEnabled ?? false, automaticDeliveryAvailable: false, tests: tests.map(outcome) });
        }
        catch (e) {
            if (e && typeof e === 'object' && 'code' in e && ['P2021', 'P2022'].includes(String(e.code)))
                return deliverySettings.parse({ available: false, writable: false, revision: 0, updatedAt: null, configured: null, secretConfigured: false, approved: options.approved, globalDeliveryEnabled: false, producerEnabled: false, automaticDeliveryAvailable: false, tests: [] });
            throw e;
        }
    }
    return {
        read,
        async save(installation, input) {
            if (!cipher)
                throw new DeliveryConfigurationError(503, 'credential_key_required');
            const value = deliverySave.parse(input);
            let canonical: string;
            try {
                canonical = new URL(value.url).href;
            }
            catch {
                throw new DeliveryConfigurationError(400, 'invalid_destination');
            }
            const pin = options.approved.find(p => p.url === canonical);
            if (!pin)
                throw new DeliveryConfigurationError(400, 'destination_not_approved');
            if (pin.url.startsWith('http:') && (!pin.allowLanHttp || !value.acknowledgeHttp))
                throw new DeliveryConfigurationError(400, 'explicit_lan_http_approval_required');
            if (value.signingSecret && (value.signingSecret === options.key || options.forbiddenSecrets?.includes(value.signingSecret)))
                throw new DeliveryConfigurationError(400, 'use_a_separate_signing_secret');
            await lock(async (tx) => {
                const row = await tx.notificationConfiguration.findUnique({ where: { sourceInstallationId: installation } });
                if ((row?.deliveryRevision ?? 0) !== value.expectedRevision)
                    throw new DeliveryConfigurationError(409, 'settings_changed_reload');
                const secret = value.signingSecret ?? (row?.deliverySecret ? cipher.open(row.deliverySecret, installation) : null);
                if (!secret)
                    throw new DeliveryConfigurationError(400, 'signing_secret_required');
                targetFactory({ ...pin, secret });
                if (row && JSON.stringify(row.deliveryConfiguration) === JSON.stringify(pin) && row.deliverySecret && cipher.open(row.deliverySecret, installation) === secret)
                    return;
                const change = { deliveryConfiguration: json(pin), deliverySecret: cipher.seal(secret, installation), deliveryRevision: { increment: 1 }, deliveryUpdatedAt: now(), producerEnabled: false, liveFromAt: null };
                await tx.notificationConfiguration.upsert({ where: { sourceInstallationId: installation }, create: { sourceInstallationId: installation, configuration: { deliveryEnabled: false, rules: [] }, deliveryConfiguration: json(pin), deliverySecret: change.deliverySecret, deliveryRevision: 1, deliveryUpdatedAt: now() }, update: { ...change, ...(row ? { updatedAt: row.updatedAt } : {}) } });
            }, installation);
            return read(installation);
        },
        async preview(installation, sampleEventId, updateTestId) {
            if (!cipher)
                throw new DeliveryConfigurationError(503, 'credential_key_required');
            const row = await prisma.notificationConfiguration.findUnique({ where: { sourceInstallationId: installation } });
            if (!row)
                throw new DeliveryConfigurationError(409, 'save_destination_first');
            const target = configuredTarget(row, options, targetFactory), payload = samplePayload(randomUUID(), installation, now(), options.dashboardOrigin), expiresAt = now().getTime() + 120000;
            if(sampleEventId){
                if(!options.media)throw new DeliveryConfigurationError(503,'notification_media_unavailable');
                const event=await prisma.securityEvent.findFirst({where:{id:z.uuid().parse(sampleEventId),sourceInstallationId:installation},select:{id:true,nvrChannel:true,camera:true,occurredAt:true,firstReceivedAt:true,objects:{take:129,select:{id:true,category:true,cropSnapshotId:true,coordinateStatus:true,sourceTimestamp:true,xMin:true,yMin:true,xMax:true,yMax:true,fullFrameSnapshotId:true,memberships:{take:17,select:{zoneVersionId:true,relationship:true}}}}}});
                const catalog=await locationCatalog(prisma,installation),projected=event?projectNotificationEvent(event,catalog):null;
                const object=event?.objects.find(o=>o.fullFrameSnapshotId&&projected?.objects.some(p=>p.id===o.id&&p.reliableZoneIds?.some(z=>catalog.some(v=>v.zoneId===z&&v.slot===0))))??event?.objects.find(o=>o.fullFrameSnapshotId);
                const location=projected?.objects.find(o=>o.id===object?.id),names=catalog.filter(z=>location?.reliableZoneIds?.includes(z.zoneId));
                if(!event||!object?.fullFrameSnapshotId)throw new DeliveryConfigurationError(404,'sample_frame_unavailable');
                const snapshot=await prisma.eventSnapshot.findFirst({where:{id:object.fullFrameSnapshotId,eventId:event.id,origin:'NVR_PUSH',status:'RECEIVED',sha256:{not:null}},select:{id:true}});
                if(!snapshot)throw new DeliveryConfigurationError(404,'sample_frame_unavailable');
                payload.sampleEventId=event.id;payload.camera={channel:event.nvrChannel,name:event.camera??`Camera ${event.nvrChannel}`};
                payload.timestamps={receivedAt:event.firstReceivedAt.toISOString(),occurredAt:event.occurredAt?.toISOString()??null};
                payload.objects=[{...payload.objects[0]!,id:object.id,category:z.enum(['PERSON','MOTOR_VEHICLE','NON_MOTOR_VEHICLE']).parse(object.category),zoneIds:location?.reliableZoneIds??[],zoneNames:[...new Map(names.map(z=>[z.zoneId,{id:z.zoneId,name:z.name}])).values()],locationReason:'controlled_sample_not_live_evaluation'}];
                payload.images=[{id:snapshot.id,path:`/api/events/${event.id}/images/${snapshot.id}`,authentication:'dashboard_session_or_service_bearer',delivery:mediaLink(options.media,event.id,snapshot.id,payload.notificationId,now(),object.coordinateStatus==='VALID'&&object.xMin!==null&&object.yMin!==null&&object.xMax!==null&&object.yMax!==null?[[object.xMin,object.yMin,object.xMax,object.yMax]]:undefined)}];
            }
            let finalPayload=payload;
            if(updateTestId){
                if(sampleEventId)throw new DeliveryConfigurationError(400,'choose_test_parent_only');
                const parent=await prisma.notificationIntent.findFirst({where:{id:z.uuid().parse(updateTestId),sourceInstallationId:installation,mode:'TEST',state:'DELIVERED',createdAt:{gte:new Date(now().getTime()-ENRICHMENT_WINDOW_MS)}}});
                const initial=parent?webhookPayload.parse(parent.payload):null;
                const analysis=initial?.sampleEventId?await prisma.eventAnalysis.findUnique({where:{eventId:initial.sampleEventId},include:{objectAnalyses:true}}):null;
                const update=initial&&analysis?testEnrichmentPayload(initial,analysis,now()):null;
                if(!update)throw new DeliveryConfigurationError(409,'fresh_test_with_useful_accepted_sample_required');
                finalPayload=update;
            }
            const canonicalPayload=webhookPayload.parse(finalPayload);
            return deliveryPreview.parse({ payload:canonicalPayload, body: JSON.stringify(canonicalPayload), confirmation: cipher.sign({ installation, revision: row.deliveryRevision, destinationId: target.id, expiresAt, payload:canonicalPayload }), expiresAt: new Date(expiresAt).toISOString(), destination: target.url.href, revision: row.deliveryRevision, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': canonicalPayload.idempotencyKey, 'X-Home-Security-Test': 'true', 'X-Home-Security-Timestamp': '<Unix seconds at send>', 'X-Home-Security-Signature': 'sha256=<HMAC-SHA256 hex; saved secret never displayed>' } });
        },
        async test(installation, confirmation, signal) {
            if (!cipher)
                throw new DeliveryConfigurationError(503, 'credential_key_required');
            let prepared: z.infer<typeof ticket>;
            try {
                prepared = ticket.parse(cipher.verify(confirmation));
            }
            catch {
                throw new DeliveryConfigurationError(400, 'invalid_test_confirmation');
            }
            if (prepared.installation !== installation || prepared.payload.type !== 'security.test')
                throw new DeliveryConfigurationError(400, 'invalid_test_confirmation');
            const claim = await lock(async (tx) => {
                const stale = await tx.notificationIntent.findMany({ where: { sourceInstallationId: installation, mode: 'TEST', state: 'SENDING', leaseUntil: { lte: now() } }, take: 10 });
                for (const old of stale) {
                    await tx.notificationAttempt.updateMany({ where: { intentId: old.id, outcome: 'STARTED' }, data: { outcome: 'UNCERTAIN', finishedAt: now(), errorCode: 'test_process_outcome_unknown', mayHaveReached: true } });
                    await tx.notificationIntent.update({ where: { id: old.id }, data: { state: 'UNCERTAIN', lastError: 'test_process_outcome_unknown', leaseToken: null, leaseUntil: null } });
                }
                const isUpdate=prepared.payload.action==='update';
                const existing = await tx.notificationIntent.findFirst({ where: { ...(isUpdate?{parentId:prepared.payload.notificationId,mode:'UPDATE'}:{id:prepared.payload.notificationId,mode:'TEST'}), sourceInstallationId: installation }, include: includeAttempt });
                if (existing) {
                    if(JSON.stringify(webhookPayload.parse(existing.payload))!==JSON.stringify(prepared.payload))throw new DeliveryConfigurationError(409,'test_identity_conflict');
                    return { existing: outcome(existing) };
                }
                if (prepared.expiresAt <= now().getTime())
                    throw new DeliveryConfigurationError(410, 'test_confirmation_expired');
                const row = await tx.notificationConfiguration.findUniqueOrThrow({ where: { sourceInstallationId: installation } }), target = configuredTarget(row, options, targetFactory);
                if (row.deliveryRevision !== prepared.revision || target.id !== prepared.destinationId)
                    throw new DeliveryConfigurationError(409, 'destination_changed_preview_again');
                const recent = await tx.notificationIntent.findFirst({ where: { sourceInstallationId: installation, mode: 'TEST', createdAt: { gt: new Date(now().getTime() - 60000) } }, orderBy: { createdAt: 'desc' } });
                if (recent && !isUpdate)
                    throw new DeliveryConfigurationError(429, 'test_rate_limit_one_per_minute');
                if(isUpdate){const parent=await tx.notificationIntent.findFirst({where:{id:prepared.payload.notificationId,sourceInstallationId:installation,mode:'TEST',state:'DELIVERED',createdAt:{gte:new Date(now().getTime()-ENRICHMENT_WINDOW_MS)}}});if(!parent)throw new DeliveryConfigurationError(409,'fresh_test_parent_required');}
                const token = randomUUID(), id = isUpdate?randomUUID():prepared.payload.notificationId;
                await tx.notificationIntent.create({ data: { id, mode: isUpdate?'UPDATE':'TEST',...(isUpdate?{parentId:prepared.payload.notificationId}:{}), sourceInstallationId: installation, eventId: null, evaluationId: null, destinationId: target.id, payload: json(prepared.payload), state: 'SENDING', nextAttemptAt: now(), expiresAt: new Date(prepared.expiresAt), attemptCount: 1, leaseToken: token, leaseUntil: new Date(now().getTime() + 30000) } });
                await tx.notificationAttempt.create({ data: { intentId: id, ordinal: 1, leaseToken: token, startedAt: now(), outcome: 'STARTED' } });
                return { id, token, target };
            }, installation);
            if ('existing' in claim)
                return claim.existing;
            // Recheck configuration immediately before HTTP. A concurrent save disarms live
            // delivery and invalidates this revision too. A send already on the wire cannot be recalled.
            const current = await prisma.notificationConfiguration.findUniqueOrThrow({ where: { sourceInstallationId: installation } });
            let result: DeliveryResult;
            if (current.deliveryRevision !== prepared.revision)
                result = { outcome: 'failed', code: 'destination_changed_before_send', status: null, durationMs: 0, receipt: null, mayHaveReached: false };
            else
                try {
                    const target = configuredTarget(current, options, targetFactory);
                    if (target.id !== claim.target.id)
                        throw Error('Changed destination');
                    result = await send(target, prepared.payload, signal);
                }
                catch {
                    result = { outcome: 'uncertain', code: 'test_network_outcome_unknown', status: null, durationMs: 0, receipt: null, mayHaveReached: true };
                }
            await lock(async (tx) => { const active = await tx.notificationIntent.findUniqueOrThrow({ where: { id: claim.id } }); if (active.state !== 'SENDING' || active.leaseToken !== claim.token)
                return; const state = result.outcome === 'accepted' ? 'DELIVERED' : result.outcome === 'uncertain' ? 'UNCERTAIN' : 'FAILED'; await tx.notificationAttempt.update({ where: { intentId_ordinal: { intentId: claim.id, ordinal: 1 } }, data: { outcome: state, finishedAt: now(), httpStatus: result.status, errorCode: result.code, durationMs: result.durationMs, mayHaveReached: result.mayHaveReached, receipt: result.receipt } }); await tx.notificationIntent.update({ where: { id: claim.id }, data: { state, deliveredAt: state === 'DELIVERED' ? now() : null, lastError: result.code, leaseToken: null, leaseUntil: null } }); }, installation);
            const saved = await prisma.notificationIntent.findUniqueOrThrow({ where: { id: claim.id }, include: includeAttempt });
            return outcome(saved);
        }
    };
}
