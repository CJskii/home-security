import { z } from 'zod';
export const proposalSchema=z.object({enabled:z.boolean(),unmatched:z.enum(['analyse','exclude']),uncertain:z.enum(['analyse','exclude']),zones:z.array(z.object({zoneId:z.uuid(),enabled:z.boolean()}))});
export type Proposal=z.infer<typeof proposalSchema>;
export const aiProcessingSchema=z.object({enforcementAvailable:z.literal(false),available:z.boolean(),writable:z.boolean(),updatedAt:z.string().nullable(),configuration:proposalSchema,
  zones:z.array(z.object({zoneId:z.uuid(),channel:z.number(),slot:z.number(),name:z.string(),interested:z.boolean()})),
  latestRecordedAnalysis:z.object({model:z.string(),promptVersion:z.number(),schemaVersion:z.number(),completedAt:z.string()}).nullable(),
  recent:z.array(z.object({status:z.string(),reason:z.string().nullable(),count:z.number()})),metricsWindowHours:z.number()});
