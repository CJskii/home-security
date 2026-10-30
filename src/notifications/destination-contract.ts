import { z } from 'zod';
import { webhookTarget } from './webhook.js';
import { webhookPayload } from './delivery-contract.js';
export const pinnedDestination = z.object({ url: z.string().url().max(512), address: z.string().max(64), allowLanHttp: z.boolean() }).strict();
export type PinnedDestination = z.infer<typeof pinnedDestination>;
export function approvedDestinations(raw: string) { const rows = z.array(pinnedDestination).max(8).parse(JSON.parse(raw)); return rows.map(r => ({ ...r, url: webhookTarget({ ...r, secret: 'x'.repeat(32) }).url.href })); }
export const deliverySave = z.object({ expectedRevision: z.number().int().nonnegative(), url: z.string().max(512), signingSecret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(), acknowledgeHttp: z.boolean() }).strict();
export const testSend = z.object({ confirmation: z.string().max(8192), confirmed: z.literal(true) }).strict();
export const testOutcome = z.object({ id: z.uuid(), state: z.enum(['SENDING', 'DELIVERED', 'FAILED', 'UNCERTAIN']), at: z.iso.datetime(), httpStatus: z.number().nullable(), code: z.string().nullable(), durationMs: z.number().nullable(), receipt: z.string().nullable(), mayHaveReached: z.boolean() }).strict();
export const deliverySettings = z.object({ available: z.boolean(), writable: z.boolean(), revision: z.number().int(), updatedAt: z.iso.datetime().nullable(), configured: pinnedDestination.nullable(), secretConfigured: z.boolean(), approved: z.array(pinnedDestination).max(8), globalDeliveryEnabled: z.boolean(), producerEnabled: z.boolean(), automaticDeliveryAvailable: z.literal(false), tests: z.array(testOutcome).max(10) }).strict();
export const deliveryPreview = z.object({ payload: webhookPayload, body: z.string().max(8192), confirmation: z.string().max(8192), expiresAt: z.iso.datetime(), destination: z.string().url(), headers: z.record(z.string(), z.string()), revision: z.number().int() }).strict();
export class DeliveryConfigurationError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}
