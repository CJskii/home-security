import { z } from 'zod';
import { activityLabelSchema, objectActionSchema } from '../ai/schemas.js';
const name = z.string().min(1).max(128).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
const iso = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
export const categorySchema = z.enum(['person', 'motor_vehicle', 'non_motor_vehicle', 'unknown']);
const cursorShape = z.object({ eventTime: z.iso.datetime(), id: z.uuid().transform((v) => v.toLowerCase()), sort:z.literal('oldest').optional() }).strict();
export const vehicleGroupSchema = z.enum(['car', 'van', 'truck', 'bus', 'motorcycle', 'bicycle']);
export const historySchema = z.object({ camera: name.optional(), alarmType: name.max(100).optional(),
  sort:z.enum(['newest','oldest']).default('newest'),
  aiOutcome:z.enum(['completed','excluded','capacity','failed','pending','other_skipped']).optional(),
  notificationOutcome:z.enum(['accepted','cooldown','excluded','failed','uncertain','pending','held','not_evaluated']).optional(),
  category: categorySchema.optional(), vehicleGroup: vehicleGroupSchema.optional(), action:objectActionSchema.optional(), verification:z.enum(['supported','uncertain','contradicted']).optional(), activityLabel: activityLabelSchema.optional(),
  sourceInstallationId: z.uuid().optional(), nvrChannel: z.coerce.number().int().positive().max(2147483647).optional(),
  alarmSeen: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  occurredAfter: iso.optional(), occurredBefore: iso.optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  zoneInterest: z.enum(['interested','other']).optional(),
  locationZoneId: z.uuid().optional(), interestedZonesOnly: z.enum(['true','false']).transform(v=>v==='true').optional(),
  locationStatus:z.enum(['matched','ambiguous','unmatched','unknown','uncertain']).optional(),
  zoneId: z.uuid().optional(), zoneVersionId: z.uuid().optional(), zoneName: name.optional(),
  zoneRelation: z.enum(['trigger', 'membership']).default('trigger'), zoneNameScope: z.enum(['historical', 'current']).default('historical'),
  cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).transform((value, ctx) => {
    try { const v = cursorShape.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); return { eventTime: new Date(v.eventTime), id: v.id, ...(v.sort?{sort:v.sort}:{}) }; }
    catch { ctx.addIssue({ code: 'custom', message: 'Invalid cursor' }); return z.NEVER; }
  }).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.occurredAfter && v.occurredBefore && v.occurredAfter > v.occurredBefore) ctx.addIssue({ code: 'custom', message: 'Reversed range' });
  if(v.cursor&&(v.cursor.sort??'newest')!==v.sort)ctx.addIssue({code:'custom',path:['cursor'],message:'Cursor order differs from selected sort'});
});
export type HistoryQuery = z.infer<typeof historySchema>;
