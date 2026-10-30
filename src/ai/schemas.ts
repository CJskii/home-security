import { z } from 'zod';
import { structuredSubjectSchema } from './visual-schema.js';
export const PROMPT_VERSION = 5;
export const SCHEMA_VERSION = 3;
const text = (max:number) => z.string().trim().min(1).max(max)
  .refine(v=>![...v].some(c=>c.charCodeAt(0)<9) && !/\/9j\/|data:image\/|iVBORw0KGgo/.test(v),'Media/control data is not analysis text');
export const activityLabelSchema=z.enum(['passing_by','approaching','leaving','standing','interacting_with_vehicle','carrying_object','unknown']);
export const objectActionSchema=z.enum(['visible','standing','sitting','carrying','walking','running','approaching','leaving','entering','exiting','driving','stopping','parking','crouching','bending','holding','other','unknown']);
export const objectResultSchema=z.object({objectId:z.uuid(),observedType:z.enum(['person','motor_vehicle','non_motor_vehicle','animal','unknown']),
  verification:z.enum(['supported','uncertain','contradicted']),actions:z.array(objectActionSchema).min(1).max(6),
  evidenceImages:z.array(z.number().int().min(1).max(6)).min(1).max(6),
  shortDescription:text(256),uncertainties:z.array(text(200)).max(4),
}).strict();
// Active result shape after the short-only forward migration. Legacy subject
// JSON stays readable; abandoned temporal/long-text columns are no longer used.
export const analysisSchema=z.object({activityLabel:activityLabelSchema,shortDescription:text(512),
  subjects:z.array(z.union([structuredSubjectSchema,z.object({type:z.enum(['person','vehicle','animal','unknown']),count:z.number().int().min(0).max(100).nullable()}).strict()])).max(6),
  uncertainties:z.array(text(256)).max(8),objects:z.array(objectResultSchema).max(4),
}).strict();
export type AnalysisResult=z.infer<typeof analysisSchema>;
