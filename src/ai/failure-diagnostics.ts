import { z } from 'zod';

// Never retain issue messages, input values, arbitrary property names or raw output.
const fields = new Set(('objects objectId observedType verification evidenceImages person vehicle actions relationship confidence uncertainties fieldImages shortDescription attributeEvidence upperClothing lowerClothing upperColor lowerColor outerwear headwear bags accessories carriedObjects vehicleType color make model kind object value basis uncertainty model done message content targets fullFrameSha256 cropSha256 rectangle images').split(' '));
const stages = ['input', 'transport', 'envelope', 'json', 'compact_schema', 'expanded_schema', 'source_targets', 'grounding'] as const;
const codes = ['invalid_type', 'invalid_value', 'invalid_union', 'unrecognized_keys', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of', 'custom', 'schema_invalid', 'invalid_json', 'response_limit', 'image_limit', 'image_preparation', 'object_identity', 'evidence_ownership', 'category_branch', 'inconsistent_evidence', 'unsupported_field', 'source_verification', 'action_uncertainty'] as const;
export const failureDiagnosticsSchema = z.object({
  version: z.literal(1), stage: z.enum(stages),
  issues: z.array(z.object({ field: z.string().max(256), code: z.enum(codes) }).strict()).min(1).max(8),
  truncated: z.boolean(),
}).strict();
export type FailureDiagnostics = z.infer<typeof failureDiagnosticsSchema>;
type Stage = FailureDiagnostics['stage'];
type Code = FailureDiagnostics['issues'][number]['code'];
function path(parts: readonly PropertyKey[]) {
  return parts.slice(0, 8).map(p => typeof p === 'number' && Number.isSafeInteger(p) && p >= 0 && p <= 65536 ? `[${p}]` : typeof p === 'string' && fields.has(p) ? p : '?').join('.') || '$';
}
export function failureDiagnostic(stage: Stage, code: Code, field: readonly PropertyKey[] = []): FailureDiagnostics {
  return { version: 1, stage, issues: [{ field: path(field), code }], truncated: field.length > 8 };
}
export function schemaFailure(stage: Stage, error: z.ZodError): FailureDiagnostics {
  const issues = error.issues.slice(0, 8).map(i => ({ field: path(i.path), code: (codes as readonly string[]).includes(i.code) ? i.code as Code : 'schema_invalid' as const }));
  return failureDiagnosticsSchema.parse({ version: 1, stage, issues: issues.length ? issues : [{ field: '$', code: 'schema_invalid' }], truncated: error.issues.length > 8 || error.issues.some(i => i.path.length > 8) });
}
export function parseWithDiagnostics<T>(schema: z.ZodType<T>, value: unknown, stage: Stage, reject: (diagnostics: FailureDiagnostics) => never): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : reject(schemaFailure(stage, result.error));
}
