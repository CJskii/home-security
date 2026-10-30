import { createHash } from 'node:crypto';
import { z } from 'zod';

export const notificationPaths = {
  ALARM: '/LAPI/V1.0/System/Event/Notification/Alarm',
  STRUCTURE: '/LAPI/V1.0/System/Event/Notification/Structure',
} as const;
export type Kind = keyof typeof notificationPaths;
const name = z.string().min(1).max(100).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
const identifier = z.union([z.string().min(1).max(256).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)), z.number().int().safe()]).transform(String);
const channel = z.union([z.string().regex(/^[0-9]+$/), z.number().int()]).transform(Number).pipe(z.number().int().min(1).max(2147483647));
const seconds = z.number().finite().positive().max(253402300799);
const count = z.number().int().min(0).max(100000);
// Observed on NVR-B3615.43.48.260723; preserve uninterpreted codes/positions.
const personInfo = z.object({ PersonID: identifier.optional(),
  SmallPicAttachIndex: z.number().int().nonnegative().optional(),
  LargePicAttachIndex: z.number().int().nonnegative().optional(),
}).passthrough();
const objInfo = z.object({ PersonNum: count.optional(), VehicleNum: count.optional(),
  FaceNum: count.optional(), NonMotorVehicleNum: count.optional(),
  PersonInfoList: z.array(personInfo).max(256).optional(),
}).passthrough();
const image = z.object({
  Index: z.number().int().nonnegative().optional(), Type: z.union([name, z.number().int()]).optional(),
  Width: z.number().int().positive().max(65535).optional(), Height: z.number().int().positive().max(65535).optional(),
  CaptureTime: seconds.optional(), Data: z.unknown().optional(),
}).passthrough();
const structure = z.object({ ObjInfo: objInfo.optional(), ImageNum: count.optional(),
  ImageInfoList: z.array(image).max(64).default([]),
}).passthrough();
const relatedObjects = z.object({ ObjectNum: count.optional(), ObjectList: z.array(z.object({
  ObjectID: identifier.optional(), ObjectType: z.union([name, z.number().int()]).optional(),
}).passthrough()).max(256).optional() }).passthrough();
const common = { AlarmType: name, RelatedID: identifier, TimeStamp: seconds.optional() };
const alarmSchema = z.object({ TimeStamp: seconds.optional(), AlarmInfo: z.object({ ...common, AlarmSrcID: channel,
  AlarmLevel: z.number().int().optional(), AlarmRuleID: identifier.optional(),
}).passthrough(), StructureInfo: structure.optional(), RelatedObjects: relatedObjects.optional() }).passthrough();
const structureSchema = z.object({ ...common, SrcID: channel, NotificationType: z.number().int().optional(), StructureInfo: structure }).passthrough();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function normalizeNotification(raw: unknown, kind: Kind) {
  const alarm = kind === 'ALARM' ? alarmSchema.parse(raw) : undefined;
  const structureMessage = kind === 'STRUCTURE' ? structureSchema.parse(raw) : undefined;
  const info = alarm?.AlarmInfo ?? structureMessage!;
  const nvrChannel = alarm ? alarm.AlarmInfo.AlarmSrcID : structureMessage!.SrcID;
  const reportedSeconds = info.TimeStamp ?? alarm?.TimeStamp;
  const { ImageInfoList: images = [], ...facts } = alarm?.StructureInfo ?? structureMessage?.StructureInfo ?? structure.parse({});
  // All source fields participate in notification identity; persist only media-free metadata.
  const contentHash = createHash('sha256').update(canonical(raw)).digest('hex');
  return {
    nvrChannel, alarmType: info.AlarmType, relatedId: info.RelatedID, kind, contentHash,
    reportedAt: reportedSeconds === undefined ? null : new Date(Math.round(reportedSeconds * 1000)),
    personCount: facts.ObjInfo?.PersonNum ?? null, vehicleCount: facts.ObjInfo?.VehicleNum ?? null,
    // Source code only. Do not infer an enum name or equate ObjectID and PersonID.
    objectType: alarm?.RelatedObjects?.ObjectList?.length === 1 && alarm.RelatedObjects.ObjectList[0]?.ObjectType !== undefined
      ? String(alarm.RelatedObjects.ObjectList[0].ObjectType) : null,
    metadata: mediaFreeMetadata(raw), images,

  };
}
// Never persist raw bodies: retain bounded structured facts while removing media and secrets.
export function mediaFreeMetadata(raw: unknown): Record<string, unknown> {
  let nodes = 0;
  const omitted: string[] = [];
  function clean(value: unknown, path: string, depth: number): unknown {
    if (++nodes > 4096 || depth > 16) throw new Error('Metadata limit');
    if (typeof value === 'string') {
      if (value.length > 4096 || (/^(?:\/9j\/|data:image\/)/i.test(value))) { omitted.push(path); return undefined; }
      return value;
    }
    if (Array.isArray(value)) return value.map((v, i) => clean(v, `${path}[${i}]`, depth + 1) ?? null);
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, v] of Object.entries(value)) {
        if (/^(?:Data|ImageData|Base64|Password|Authorization|Token)$/i.test(key) && (typeof v === 'string' || Array.isArray(v))) continue;
        const cleaned = clean(v, `${path}.${key}`, depth + 1);
        if (cleaned !== undefined) result[key] = cleaned;
      }
      return result;
    }
    return value;
  }
  const metadata = clean(raw, '$', 0) as Record<string, unknown>;
  if (omitted.length) metadata.metadataOmissions = omitted;
  if (Buffer.byteLength(JSON.stringify(metadata)) > 65536) throw new Error('Metadata limit');
  return metadata;
}
export type Notification = ReturnType<typeof normalizeNotification>;

// Bounded JSON parser: reject duplicate keys (including escaped aliases), non-finite
// numbers, invalid UTF-8 and excessive nesting before schema validation.
export function parseNotificationJson(bytes: Buffer): unknown {
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let offset = 0, nodes = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(input[offset] ?? '\0')) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < input.length) {
      const char = input[offset++];
      if (char === '\\') offset++;
      else if (char === '"') return JSON.parse(input.slice(start, offset)) as string;
    }
    throw new Error('Invalid JSON');
  };
  const value = (depth: number): unknown => {
    if (depth > 32 || ++nodes > 100000) throw new Error('JSON limit');
    whitespace(); const char = input[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      offset++; whitespace(); const close = char === '{' ? '}' : ']';
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = []; const keys = new Set<string>();
      if (input[offset] === close) { offset++; return char === '{' ? result : array; }
      while (true) {
        whitespace();
        if (char === '{') {
          if (input[offset] !== '"') throw new Error('Invalid JSON');
          const key = string(); if (keys.has(key)) throw new Error('Duplicate JSON key'); keys.add(key);
          whitespace(); if (input[offset++] !== ':') throw new Error('Invalid JSON');
          result[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace(); const separator = input[offset++];
        if (separator === close) return char === '{' ? result : array;
        if (separator !== ',') throw new Error('Invalid JSON');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(input.slice(offset));
    if (!match) throw new Error('Invalid JSON');
    offset += match[0].length;
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('Non-finite JSON');
    return parsed;
  };
  const parsed = value(0); whitespace(); if (offset !== input.length) throw new Error('Invalid JSON'); return parsed;
}
