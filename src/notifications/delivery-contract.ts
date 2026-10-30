import { z } from 'zod';
export const webhookPayload = z.object({
    version: z.literal(1), type: z.enum(['security.event','security.test']), action:z.enum(['create','update','test']).optional(), test:z.boolean().optional(), notification:z.object({title:z.string().max(160),message:z.string().max(600)}).strict().optional(), notificationId: z.uuid(), eventId: z.uuid().nullable(), sampleEventId: z.uuid().optional(),
    enrichment:z.object({revision:z.number().int().positive(),completedAt:z.iso.datetime(),objectIds:z.array(z.uuid()).min(1).max(8)}).strict().optional(),
    idempotencyKey: z.string().max(128), camera: z.object({ channel: z.number().int(), name: z.string().max(128) }).strict(),
    timestamps: z.object({ receivedAt: z.iso.datetime(), occurredAt: z.iso.datetime().nullable() }).strict(),
    rules: z.array(z.object({ id: z.uuid(), name: z.string().max(80), reason: z.string().max(64) }).strict()).max(10),
    objects: z.array(z.object({ id: z.uuid(), category: z.enum(['PERSON', 'MOTOR_VEHICLE', 'NON_MOTOR_VEHICLE']), zoneIds: z.array(z.uuid()).max(8), zoneNames:z.array(z.object({id:z.uuid(),name:z.string().max(128)}).strict()).max(8).optional(), zoneVersionIds: z.array(z.uuid()).max(16), basis: z.enum(['stored_membership', 'stored_geometry_projection', 'latest_confirmed_geometry_assumed_unchanged']), locationReason: z.string().max(64), uncertain: z.boolean() }).strict()).max(128),
    ai: z.object({ status: z.enum(['completed', 'skipped', 'failed', 'pending']), revision: z.number().int().nullable(), summary: z.string().max(512).nullable() }).strict(),
    // Same authenticated API as the dashboard. These are references, not public URLs
    // or bearer links. The receiver must obtain its own approved media credentials.
    images: z.array(z.object({ id: z.uuid(), path: z.string().max(256), authentication: z.literal('dashboard_session_or_service_bearer'), delivery: z.object({url:z.string().url().max(1024),expiresAt:z.iso.datetime()}).strict().optional() }).strict()).max(2),
    dashboardUrl: z.string().url().max(512),
}).strict().superRefine((v,ctx)=>{if((v.action==='update')!==Boolean(v.enrichment)||v.action==='update'&&(!['security.event','security.test'].includes(v.type)||v.ai.status!=='completed'||v.enrichment?.revision!==v.ai.revision||!v.ai.summary))ctx.addIssue({code:'custom',message:'Inconsistent enrichment'});if(v.type==='security.test'?(v.test!==true||!['test','update'].includes(v.action??'')||v.eventId!==null||(v.images.length!==0&&!v.sampleEventId)||v.rules.length!==0):(v.eventId===null||v.test===true||v.action==='test'||v.sampleEventId!==undefined))ctx.addIssue({code:'custom',message:'Inconsistent test/event identity'});});
export type WebhookPayload = z.infer<typeof webhookPayload>;
export interface DeliveryResult {
    outcome: 'accepted' | 'retry' | 'failed' | 'uncertain';
    code: string;
    status: number | null;
    mayHaveReached: boolean;
    durationMs: number;
    receipt: 'accepted' | 'rejected' | null;
    retryAfterMs?: number;
}
export interface DeliveryClaim {
    id: string;
    mode?: 'LIVE'|'UPDATE';
    eventId: string;
    token: string;
    ordinal: number;
    payload: WebhookPayload;
}
export function retryDelay(ordinal: number) { return Math.min(300000, 5000 * 2 ** Math.min(ordinal - 1, 10)); }
