import { z } from 'zod';
import { richPersonSchema, richVehicleSchema } from './observations.js';

export const visualText = (max: number) => z.string().trim().min(1).max(max)
  .refine(v => [...v].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) && !/\/9j\/|data:image\/|iVBORw0KGgo/.test(v), 'Invalid analysis text');
export const visualActionSchema = z.enum(['visible', 'standing', 'sitting', 'crouching', 'bending', 'holding', 'carrying', 'walking', 'running', 'unknown', 'other']);
export const personVisualSchema = richPersonSchema.pick({ upperClothing: true, lowerClothing: true, upperColor: true, lowerColor: true,
  outerwear: true, headwear: true, bags: true, accessories: true, carriedObjects: true });
export const vehicleVisualSchema = richVehicleSchema.pick({ vehicleType: true, color: true, make: true, model: true });
export const relationshipSchema = z.object({ kind: z.enum(['beside', 'near']), object: z.enum(['vehicle', 'bin', 'bicycle', 'bag', 'other']) }).strict();
// Only description content is recoverable; IDs, branches, facts and evidence stay strict.
const recoverableDescription = z.unknown().transform(v => typeof v === 'string' && v.length <= 2048 ? v : '');
export const ATTRIBUTE_KEYS = ['observedType', 'verification', 'actions', 'upperClothing', 'lowerClothing', 'upperColor', 'lowerColor',
  'outerwear', 'headwear', 'bags', 'accessories', 'carriedObjects', 'vehicleType', 'color', 'make', 'model', 'relationship'] as const;
// Application diagnostics only: never part of the compact model response grammar.
export const validationDiagnosticSchema = z.object({
  field: z.enum([...ATTRIBUTE_KEYS, 'shortDescription']),
  code: z.enum(['model_omitted', 'model_unknown', 'unsupported_vocabulary', 'missing_evidence', 'insufficient_confidence',
    'source_category_mismatch', 'type_incompatible_action', 'description_rule_failure']),
  rules: z.array(z.enum(['missing_evidence', 'invalid_format', 'subject_mismatch', 'attribute_mismatch', 'action_mismatch',
    'relationship_mismatch', 'unsupported_name', 'temporal_claim', 'unsupported_context', 'unqualified_action',
    'vehicle_identity_mismatch', 'vehicle_type_mismatch', 'unsupported_interaction'])).max(16).optional(),
}).strict();
export const validationDiagnosticsSchema = z.array(validationDiagnosticSchema).max(24);
export type ValidationDiagnostic = z.infer<typeof validationDiagnosticSchema>;
export const fieldEvidenceSchema = z.object({ basis: z.enum(['direct_visual', 'interpretation', 'unknown']),
  confidence: z.number().int().min(0).max(100).nullable(), evidenceImages: z.array(z.number().int().min(1).max(6)).max(6),
  uncertainty: visualText(160).nullable() }).strict();
// Explicit properties avoid propertyNames-only JSON Schema, which some local
// constrained decoders ignore. Runtime validation remains strict as well.
const attributeShape = Object.fromEntries(ATTRIBUTE_KEYS.map(key => [key, fieldEvidenceSchema.optional()])) as
  { [K in typeof ATTRIBUTE_KEYS[number]]: z.ZodOptional<typeof fieldEvidenceSchema> };
export const attributeEvidenceSchema = z.object(attributeShape).strict();
const visualObjectBase = z.object({ objectId: z.uuid(), observedType: z.enum(['person', 'motor_vehicle', 'non_motor_vehicle', 'animal', 'unknown']),
  verification: z.enum(['supported', 'uncertain', 'contradicted']), actions: z.array(visualActionSchema).min(1).max(4),
  evidenceImages: z.array(z.number().int().min(1).max(6)).min(1).max(6),
  person: personVisualSchema.nullable(), vehicle: vehicleVisualSchema.nullable(), attributeEvidence: attributeEvidenceSchema,
  shortDescription: recoverableDescription, relationship: relationshipSchema.nullable(), uncertainties: z.array(visualText(200)).max(4),
  diagnostics: validationDiagnosticsSchema.optional() }).strict();
function categoryObjectSchema() {
  const base=visualObjectBase;
  return z.discriminatedUnion('observedType', [
    base.extend({observedType:z.literal('person'),person:personVisualSchema,vehicle:z.null()}),
    base.extend({observedType:z.enum(['motor_vehicle','non_motor_vehicle']),person:z.null(),vehicle:vehicleVisualSchema}),
    base.extend({observedType:z.enum(['animal','unknown']),person:z.null(),vehicle:z.null()}),
  ]);
}
export const visualObjectSchema = categoryObjectSchema();
export const visualResponseSchema = z.object({ objects: z.array(visualObjectSchema).max(4) }).strict();
export const structuredSubjectSchema = visualObjectBase.pick({ objectId: true, person: true, vehicle: true, attributeEvidence: true }).extend({
  relationship: relationshipSchema.nullable().optional(),
  diagnostics: validationDiagnosticsSchema.optional(),
  type: z.enum(['person', 'vehicle', 'animal', 'unknown']), count: z.number().int().min(0).max(100).nullable() }).strict();
export type VisualObject = z.infer<typeof visualObjectSchema>;
