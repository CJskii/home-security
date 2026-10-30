import { z } from 'zod';

export const CLIENT_LIMITS = { pageSize: 20, searchResults: 100, jsonBytes: 32_000_000, rangeSeconds: 86400 } as const;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(256).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
export const channelSchema = z.number().int().min(1).max(256);
export const rangeSchema = z.object({ Begin: integer, End: integer }).strict().refine((v) => v.End >= v.Begin && v.End - v.Begin <= CLIENT_LIMITS.rangeSeconds);
export const pictureReferenceSchema = z.object({ Type: z.union([z.literal(1), z.literal(2)]), Name: text, Size: integer.positive() }).strict();
export type HistoricalPictureReference = z.infer<typeof pictureReferenceSchema>;
const point = z.object({ X: z.number().int().min(0).max(10000), Y: z.number().int().min(0).max(10000) }).passthrough();
const rule = z.object({ RuleType: integer, TrigerType: integer.optional(), PointNum: integer.max(16), PointList: z.array(point).max(16).optional() }).passthrough();
const picture = z.object({ Name: text, Size: integer, URL: z.string().max(2048).optional(), Data: z.string().optional() }).passthrough();
const sourceObject = z.object({ PersonID: z.union([integer, text]).optional(), ID: z.union([integer, text]).optional(), Position: z.string().max(256).optional(), RuleInfo: rule.optional() }).passthrough();
const searchEntry = z.object({
  RecordID: z.union([integer, text]).optional(), Type: integer, Time: integer, ChannelID: channelSchema, ChannelName: z.string().max(256).optional(),
  FullPicture: picture,
  ObjectList: z.array(z.object({ ObjectID: z.union([integer, text]), ObjectPicture: picture,
    ObjectInfo: z.object({ ObjectType: integer, PersonInfo: sourceObject.optional(), VehicleInfo: sourceObject.optional(), NonMotorVehicleInfo: sourceObject.optional() }).passthrough(),
  }).passthrough()).max(64),
}).passthrough();
export const searchPageSchema = z.object({ Num: integer.max(CLIENT_LIMITS.pageSize), Total: integer, SmartObjectInfoList: z.array(searchEntry).max(CLIENT_LIMITS.pageSize).default([]) })
  .passthrough().refine((v) => v.Num === v.SmartObjectInfoList.length && v.Total >= v.Num);
export type SmartSearchPage = z.infer<typeof searchPageSchema>;
export type SmartSearchEntry = z.infer<typeof searchEntry>;
export const searchQuerySchema = z.object({ ChannelID: channelSchema, Begin: integer, End: integer,
  AlarmType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/).optional(), ObjectType: integer.max(65535).optional(),
}).strict().refine((v) => v.End >= v.Begin && v.End - v.Begin <= CLIENT_LIMITS.rangeSeconds);
export type SmartSearchQuery = z.infer<typeof searchQuerySchema>;
export const pageQuerySchema = z.object({ Offset: integer.max(CLIENT_LIMITS.searchResults - 1).default(0), Limit: integer.positive().max(CLIENT_LIMITS.pageSize).default(5) }).strict();
const dimensions = z.object({Width: integer.max(10000), Height: integer.max(10000)});
export const zoneRuleConfigurationSchema = z.object({
  sensitivity: integer.max(100).nullable(), priority: integer.max(65535).nullable(),
  targets: z.array(z.object({Enabled:z.union([z.literal(0),z.literal(1)]),Type:integer.max(65535),ObjectMaxSize:dimensions.optional(),ObjectMinSize:dimensions.optional()})).max(16),
}).strict();
export const cameraOsdSchema = z.object({Num:integer.max(32),ContentList:z.array(z.object({ID:integer,ContentInfo:z.array(z.object({ContentType:integer,Value:z.string().max(256)})).max(32)})).max(32)}).refine(v=>v.Num===v.ContentList.length);
export const accessZoneSchema = z.object({ Rule: z.object({ Enabled: z.union([z.literal(0), z.literal(1)]) }).passthrough(),
  Areas: z.object({ Num: integer.max(4), PolygonInfoList: z.array(z.object({
    ID: integer.max(3), Enabled: z.union([z.literal(0), z.literal(1)]), Sensitivity: integer.max(100).optional(), Priority: integer.max(65535).optional(),
    Name: text.max(128).optional(), Num:integer.max(16).optional(), DetectTargetList: zoneRuleConfigurationSchema.shape.targets.optional(),
    PointNum: integer.max(16), PointList: z.array(point).max(16),
  }).passthrough().refine((v) => v.PointNum === v.PointList.length)).max(4) }).passthrough(),
}).passthrough();
export type AccessZoneConfiguration = z.infer<typeof accessZoneSchema>;
export const recordsSchema = z.object({ Nums: integer.max(CLIENT_LIMITS.pageSize), RecordInfos: z.array(z.object({
  FileName: z.string().max(2048), RecordType: integer, RecordTypes2: integer.optional(), Begin: integer, End: integer,
}).passthrough().refine((v) => v.End >= v.Begin)).max(CLIENT_LIMITS.pageSize).default([]) }).passthrough().refine((v) => v.Nums === v.RecordInfos.length);
export type RecordingPage = z.infer<typeof recordsSchema>;
export const recordReferenceSchema = z.object({ URL: z.string().max(2048) }).passthrough();
export type RecordingReference = z.infer<typeof recordReferenceSchema>;
export const startSchema = z.object({ SearchID: integer });
export const progressSchema = z.object({ Percent: integer.max(100) }).passthrough();

// Encoding configuration, not measured stream throughput or an RTSP health probe.
const streamInteger = z.number().int().nonnegative().max(1_000_000);
export const videoStreamsSchema = z.object({ Num: z.number().int().min(0).max(16), VideoStreamInfos: z.array(z.object({
  ID: streamInteger, MainStreamType: streamInteger.optional(), Enabled: z.union([z.literal(0),z.literal(1)]).optional(),
  VideoEncodeInfo: z.object({ EncodeFormat: streamInteger.optional(),
    Resolution: z.object({Width:streamInteger.positive(),Height:streamInteger.positive()}).optional(),
    FrameRate: streamInteger.optional(), BitRate: streamInteger.optional(), BitRateType: streamInteger.optional(),
  }).optional(),
})).max(16) }).refine((v)=>v.Num===v.VideoStreamInfos.length);
export type VideoStreamSettings = z.infer<typeof videoStreamsSchema>;
