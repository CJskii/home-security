import { z } from 'zod';
import { prepareImages } from './prepare.js';
import { visualResponseSchema } from './visual-schema.js';
import { compactResponseSchema, decodeCompactResponse } from './compact-schema.js';
import { failureDiagnostic, failureDiagnosticsSchema, parseWithDiagnostics, schemaFailure, type FailureDiagnostics } from './failure-diagnostics.js';
export class VisionError extends Error {
  readonly diagnostics?: FailureDiagnostics;
  constructor(readonly code: 'model_unavailable' | 'model_not_vision' | 'invalid_model_output' | 'vision_timeout', diagnostics?: FailureDiagnostics) {
    super(code);
    if (diagnostics) this.diagnostics = failureDiagnosticsSchema.parse(diagnostics);
  }
}
const reject = (diagnostics: FailureDiagnostics): never => { throw new VisionError('invalid_model_output', diagnostics); };
const numericTelemetry = z.object({prompt_eval_count:z.number().int().nonnegative().safe().optional(),eval_count:z.number().int().nonnegative().safe().optional(),
  prompt_eval_duration:z.number().int().nonnegative().safe().optional(),eval_duration:z.number().int().nonnegative().safe().optional(),total_duration:z.number().int().nonnegative().safe().optional()});
export interface InferenceTelemetry { promptTokens:number|null; generatedTokens:number|null; inputProcessingMs:number|null; generationMs:number|null; totalInferenceMs:number|null }
function telemetry(raw:unknown):InferenceTelemetry {
  const parsed=numericTelemetry.safeParse(raw),d=parsed.success?parsed.data:{};
  return {promptTokens:d.prompt_eval_count??null,generatedTokens:d.eval_count??null,inputProcessingMs:d.prompt_eval_duration===undefined?null:d.prompt_eval_duration/1e6,
    generationMs:d.eval_duration===undefined?null:d.eval_duration/1e6,totalInferenceMs:d.total_duration===undefined?null:d.total_duration/1e6};
}
// Existing Ollama transport, reused with bounded structured output and vision verification.
export function createVisionClient(origin: string, model: string, bearerToken?: string, request: typeof fetch = fetch) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) throw new Error('Invalid vision origin');
  let verified = false;
  async function call(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await request(new URL(path, origin), { method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) }, body: JSON.stringify(body) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new VisionError('model_unavailable'); }
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break;
          length += next.value.length; if (length > 65536) { await reader.cancel(); reject(failureDiagnostic('transport', 'response_limit')); }
          chunks.push(Buffer.from(next.value)); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } finally { reader.releaseLock(); }
    } catch (error) {
      if (signal.aborted) throw new VisionError('vision_timeout');
      if (error instanceof VisionError) throw error;
      if (error instanceof SyntaxError) reject(failureDiagnostic('transport', 'invalid_json'));
      throw new VisionError('model_unavailable');
    }
  }
  return { async analyse(images: Buffer[], prompt: string, signal: AbortSignal, objectIds?:string[], onTelemetry?:(value:InferenceTelemetry)=>void, nativeCropImages:number[]=[]) {
    if (images.length < 1 || images.length > 6 || images.some((b) => !b.length || b.length > 16000000) || images.reduce((s, b) => s + b.length, 0) > 16000000) reject(failureDiagnostic('input', 'image_limit', ['images']));
    if (!verified) {
      const show = z.object({ capabilities: z.array(z.string()) }).safeParse(await call('/api/show', { model }, signal));
      if (!show.success || !show.data.capabilities.includes('vision')) throw new VisionError('model_not_vision');
      verified = true;
    }
    if (signal.aborted) throw new VisionError('vision_timeout');
    const ids=objectIds ? parseWithDiagnostics(z.array(z.uuid()).min(1).max(4), objectIds, 'source_targets', reject) : undefined;
    const wireSchema=compactResponseSchema(ids,images.length,true);
    const prepared = await prepareImages(images,signal,nativeCropImages).catch(()=>{throw new VisionError(signal.aborted?'vision_timeout':'invalid_model_output',signal.aborted?undefined:failureDiagnostic('input','image_preparation',['images']));});
    try {
    const raw = await call('/api/chat', { model, stream: false, think: false, keep_alive: 0,
      format: z.toJSONSchema(wireSchema), options: { temperature: 0, num_ctx: 16384, num_predict: 3072 },
      messages: [{ role: 'user', content: prompt, images: prepared.map((b) => b.toString('base64')) }] }, signal);
    // Numeric metadata only, even when model content subsequently fails validation.
    try { onTelemetry?.(telemetry(raw)); } catch { /* Optional telemetry cannot fail inference. */ }
      const envelope = parseWithDiagnostics(z.object({ model: z.literal(model), done: z.literal(true), message: z.object({ content: z.string().max(32768) }) }), raw, 'envelope', reject);
      let content: unknown;
      try { content = JSON.parse(envelope.message.content) as unknown; } catch { reject(failureDiagnostic('json', 'invalid_json', ['message','content'])); }
      let expanded: unknown;
      try { expanded = decodeCompactResponse(content,ids,images.length); }
      catch (error) { if (error instanceof z.ZodError) reject(schemaFailure('compact_schema', error)); throw error; }
      const result = parseWithDiagnostics(visualResponseSchema, expanded, 'expanded_schema', reject);
      if (ids && (result.objects.length !== ids.length || result.objects.some(o=>!ids.includes(o.objectId)))) reject(failureDiagnostic('expanded_schema','object_identity',['objects']));
      if (result.objects.some(o=>o.evidenceImages.some(i=>i>images.length))) reject(failureDiagnostic('expanded_schema','evidence_ownership',['objects','evidenceImages']));
      return result;
    } finally {prepared.length=0;}
  } };
}
export type VisionClient = ReturnType<typeof createVisionClient>;
