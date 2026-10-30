import { z } from 'zod';
const pin = z.object({ url: z.string(), address: z.string(), allowLanHttp: z.boolean() });
export const testResultSchema = z.object({ id: z.string(), state: z.enum(['SENDING', 'DELIVERED', 'FAILED', 'UNCERTAIN']), at: z.string(), httpStatus: z.number().nullable(), code: z.string().nullable(), durationMs: z.number().nullable(), receipt: z.string().nullable(), mayHaveReached: z.boolean() });
export const deliverySettingsSchema = z.object({ available: z.boolean(), writable: z.boolean(), revision: z.number(), updatedAt: z.string().nullable(), configured: pin.nullable(), secretConfigured: z.boolean(), approved: z.array(pin), globalDeliveryEnabled: z.boolean(), producerEnabled: z.boolean(), automaticDeliveryAvailable: z.literal(false), tests: z.array(testResultSchema) });
// The backend's webhookPayload schema creates and validates the actual wire body.
// The UI displays/copies that exact string; it does not invent a second event schema.
export const deliveryPreviewSchema = z.object({ payload: z.unknown(), body: z.string(), confirmation: z.string(), expiresAt: z.string(), destination: z.string(), headers: z.record(z.string(), z.string()), revision: z.number() });
