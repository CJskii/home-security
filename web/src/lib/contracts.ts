import { z } from "zod";
const nullableText = z.string().nullable();
const ai = z.object({
  shortDescription: z.string().nullish(),
  observedType: z.string(),
  verification: z.string(),
  actions: z.array(z.string()),
  uncertainties: z.array(z.string()),
  person: z.record(z.string(), z.unknown()).nullish(),
  vehicle: z.record(z.string(), z.unknown()).nullish(),
  relationship: z.object({ kind: z.enum(["beside", "near"]), object: z.enum(["vehicle", "bin", "bicycle", "bag", "other"]) }).nullable().optional(),
  evidenceImages: z.array(z.number().int().min(1).max(6)).max(6).optional(),
  diagnostics: z.array(z.object({
    field: z.string().max(32),
    code: z.enum(["model_omitted", "model_unknown", "unsupported_vocabulary", "missing_evidence", "insufficient_confidence", "source_category_mismatch", "type_incompatible_action", "description_rule_failure"]),
    rules: z.array(z.string().max(64)).max(16).optional(),
  })).max(24).optional(),
  attributeEvidence: z
    .record(
      z.string(),
      z.object({
        basis: z.string(),
        confidence: z.number().nullable(),
        uncertainty: nullableText,
        evidenceImages: z.array(z.number()),
      }),
    )
    .optional(),
});
export const imageSchema = z.object({
  id: z.uuid(),
  type: z.number().nullable(),
  url: nullableText,
  width: z.number().nullable(),
  height: z.number().nullable(),
  availability: z.object({ state: z.string() }),
  capturedAt: nullableText,
});
export const eventSchema = z.object({
  id: z.uuid(),
  camera: z.string(),
  nvrChannel: z.number(),
  alarmType: z.string(),
  timestamp: z.object({ value: z.string(), source: z.string() }),
  categories: z.array(z.string()),
  processing: z.object({ status: z.string(), reason: nullableText }).nullable(),
  images: z.array(imageSchema),
  objects: z.array(
    z.object({
      id: z.uuid(),
      category: z.string(),
      location:z.object({status:z.enum(['MATCHED','AMBIGUOUS','UNMATCHED','UNKNOWN']),reason:z.string(),algorithm:z.string(),temporalBasis:z.literal('observed_configuration_bracket'),evaluatedVersionIds:z.array(z.uuid()),matches:z.array(z.object({zoneId:z.uuid(),versionId:z.uuid(),revision:z.number().optional(),slot:z.number(),name:z.string(),interested:z.boolean()}))}).nullish(),
      sourceList: z.string(),
      notificationId: z.uuid().optional(),
      sourceOrdinal: z.number().int().optional(),
      sourceIdentifiers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      sourceCategoryCode: z.string().nullable().optional(),
      images: z.object({ cropId: nullableText, fullFrameId: nullableText }),
      rectangle: z
        .object({
          xMin: z.number(),
          yMin: z.number(),
          xMax: z.number(),
          yMax: z.number(),
          imageId: nullableText,
          scale: z.literal(10000),
          coordinateSpace: z.literal("original_full_frame"),
        })
        .nullable(),
      analysis: ai.nullable(),
    }),
  ),
  analysis: z
    .object({
      shortDescription: z.string(),
      uncertainties: z.array(z.string()),
      model: z.string(),
      promptVersion: z.number(),
      schemaVersion: z.number(),
    })
    .nullable(),
  truncated: z.object({ objects: z.boolean(), images: z.boolean() }),
});
export type SecurityEvent = z.infer<typeof eventSchema>;
export type EventImage = z.infer<typeof imageSchema>;
export const pageSchema = z.object({
  events: z.array(eventSchema),
  nextCursor: nullableText,
});
export const camerasSchema = z.object({
  refreshAvailable:z.boolean().default(false),
  cameras: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      channel: z.number(),
      synchronization:z.object({state:z.enum(['fresh','stale','unavailable']),lastSuccessfulAt:nullableText,lastAttemptAt:nullableText,error:nullableText,intervalSeconds:z.number()}).optional(),
      defaultProfile: z.string(),
      streamHealth: z.string(),
    }),
  ),
});
export type CameraConfiguration = z.infer<typeof camerasSchema>["cameras"][number];
export const statisticsSchema = z.object({
  total: z.number(),
  person: z.number(),
  motorVehicle: z.number(),
  complete: z.number(),
  skipped: z.number(),
  failed: z.number(),
  interrupted: z.number(),
  pending: z.number(),
  missing: z.number(),
  completionPercentage: z.number(),
  activity: z.array(z.object({ start: z.string(), count: z.number() })),
});
export const streamsSchema = z.object({
  profiles: z.array(
    z.object({
      id: z.string(),
      videoCodec: nullableText,
      width: z.number().nullable(),
      height: z.number().nullable(),
      fps: z.number().nullable(),
      enabled: z.boolean().nullable(),
      playback: z.object({
        state: z.string(),
        protocol: z.literal("mse_websocket"),
        endpoint: z.string().nullable(),
      }).optional(),
    }),
  ),
  discovery: z.object({
    state: z.string(),
    stale: z.boolean(),
    refreshedAt: nullableText,
  }),
});
export const zonesSchema = z.object({
  preferencesAvailable: z.boolean().default(false),
  zones: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().nullish(),
      slot: z.number().int().nonnegative(),
      preference: z.object({ displayName: z.string().nullable(), interested: z.boolean(), updatedAt: z.string() }).nullish(),
      current: z
        .object({
          enabled: z.boolean(),
          ruleEnabled: z.boolean().nullable(),
          polygon: z.array(z.object({ X: z.number(), Y: z.number() })),
          geometryFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          observedAt: z.string(),
          lastObservedAt: nullableText.optional(),
          revision: z.number().int().optional(),
          configuration: z.object({
            sensitivity: z.number().nullable(), priority: z.number().nullable(),
            targets: z.array(z.object({ Enabled: z.union([z.literal(0), z.literal(1)]), Type: z.number().int(),
              ObjectMinSize: z.object({ Width: z.number(), Height: z.number() }).optional(),
              ObjectMaxSize: z.object({ Width: z.number(), Height: z.number() }).optional() })),
          }).nullish(),
        })
        .nullable(),
    }),
  ),
});
