import { z } from 'zod';
const unique=<T>(v:T[])=>new Set(v).size===v.length;
export const notificationRule=z.object({
  id:z.uuid(),name:z.string().trim().min(1).max(80),enabled:z.boolean(),
  channels:z.array(z.number().int().min(1).max(2)).min(1).max(2).refine(unique),
  zoneIds:z.array(z.uuid()).min(1).max(8).refine(unique),
  categories:z.array(z.enum(['PERSON','MOTOR_VEHICLE','NON_MOTOR_VEHICLE'])).min(1).max(3).refine(unique),
  cooldownSeconds:z.number().int().min(0).max(86400),
  // Omitted legacy values retain the documented per-rule scope.
  cooldownScope:z.enum(['rule','rule_camera']).optional(),
  ambiguous:z.enum(['include','exclude']),unknown:z.enum(['include','exclude']),
}).strict();
export const notificationConfiguration=z.object({deliveryEnabled:z.boolean(),rules:z.array(notificationRule).max(10).refine(v=>unique(v.map(r=>r.id)))}).strict();
export const notificationSave=z.object({expectedRevision:z.number().int().nonnegative(),configuration:notificationConfiguration}).strict();
export const notificationWindow=z.object({from:z.iso.datetime(),to:z.iso.datetime()}).strict().refine(v=>Date.parse(v.to)>Date.parse(v.from)&&Date.parse(v.to)-Date.parse(v.from)<=86400000,{message:'Choose a window of at most 24 hours'});
export const notificationArchive=z.object({from:z.iso.datetime(),to:z.iso.datetime(),expectedRevision:z.number().int().nonnegative(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(v=>Date.parse(v.to)>Date.parse(v.from)&&Date.parse(v.to)-Date.parse(v.from)<=86400000,{message:'Choose a window of at most 24 hours'});
export type NotificationConfiguration=z.infer<typeof notificationConfiguration>;
export type NotificationRule=z.infer<typeof notificationRule>;
export type NotificationWindow=z.infer<typeof notificationWindow>;
export class NotificationConflict extends Error {}
export class NotificationLimit extends Error {}
export const evaluationMetadata=z.object({id:z.uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),configurationRevision:z.number().int(),createdAt:z.iso.datetime()}).strict();
export const notificationSettingsResponse=z.object({available:z.boolean(),writable:z.boolean(),archivable:z.boolean(),deliveryAvailable:z.literal(false),revision:z.number().int().nonnegative(),updatedAt:z.iso.datetime().nullable(),configuration:notificationConfiguration,
  cameras:z.array(z.object({channel:z.number().int().min(1).max(2),name:z.string().max(128)}).strict()).max(2),
  zones:z.array(z.object({id:z.uuid(),channel:z.number().int().min(1).max(2),slot:z.number().int().min(0).max(3),name:z.string().max(128)}).strict()).max(8),evaluations:z.array(evaluationMetadata).max(5)}).strict();
