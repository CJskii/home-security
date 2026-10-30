import type { Config } from '../config.js';
import type { MemoryFrame } from '../uniview/ingest.js';
import { VisionError, type VisionClient, type InferenceTelemetry } from './client.js';
import { failureDiagnostic, type FailureDiagnostics } from './failure-diagnostics.js';
import { analysisPrompt, inputFingerprint, selectEvidence, EvidenceSelectionError } from './evidence.js';
import { groundedResult, linkedTargets } from './grounding.js';
import { PROMPT_VERSION, SCHEMA_VERSION } from './schemas.js';
import type { AnalysisStore } from './store.js';
export interface AnalysisOutcome { status: 'COMPLETE' | 'FAILED' | 'SKIPPED'; reason: string; validationFailure?:FailureDiagnostics }
export interface EventAnalyser { analyse(eventId: string, frames: MemoryFrame[], signal: AbortSignal, options?:{reprocess?:boolean}): Promise<AnalysisOutcome> }
// One inference and one bounded waiting window; all image ownership stays in receiver RAM.
export function createEventAnalyser(config: Config, store: AnalysisStore, client: VisionClient, reportTelemetry:(eventId:string, telemetry:InferenceTelemetry & {requestAttempt:number;processingStartedAt:string})=>void=()=>{}): EventAnalyser & { usage(): { active: number; queued: number } } {
  let active = false, waiting: { grant(): void } | undefined;
  function acquire(signal: AbortSignal): Promise<() => void> {
    const release = () => { if (waiting) { const next = waiting; waiting = undefined; next.grant(); } else active = false; };
    if (signal.aborted) return Promise.reject(new Error('interrupted'));
    if (!active) { active = true; return Promise.resolve(release); }
    if (waiting) return Promise.reject(new Error('ai_capacity'));
    return new Promise((resolve, reject) => {
      const cancel = (reason: string) => { if (waiting === entry) waiting = undefined; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error(reason)); };
      const abort = () => cancel('interrupted');
      const entry = { grant() { clearTimeout(timer); signal.removeEventListener('abort', abort); if (signal.aborted) { active = false; reject(new Error('interrupted')); } else resolve(release); } };
      const timer = setTimeout(() => cancel('ai_queue_timeout'), 30000); waiting = entry;
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  return {
    usage: () => ({ active: Number(active), queued: Number(Boolean(waiting)) }),
    async analyse(eventId, frames, signal, options?:{reprocess?:boolean}) {
      let release: (() => void) | undefined;
      const { selected, sceneCount } = selectEvidence(frames);
      const images = selected.map((f) => f.bytes);
      const clear = () => { images.length = 0; selected.length = 0; };
      signal.addEventListener('abort', clear, { once: true });
      try {
        if (!sceneCount) return { status: 'SKIPPED', reason: 'no_full_frame' };
        const source = await store.source(eventId);
        if (signal.aborted) return { status: 'FAILED', reason: 'interrupted' };
        if (!source?.confirmed) return { status: 'SKIPPED', reason: 'alarm_unconfirmed' };
        if (!options?.reprocess && source.firstReceivedAt < config.AI_ENABLEMENT_CUTOFF!) return { status: 'SKIPPED', reason: 'ai_before_cutoff' };
        if(Array.isArray(source.facts.targets) && !source.facts.targets.length)return {status:'SKIPPED',reason:'no_linked_objects'};
        // Validate all requested source pairs before reserving model capacity.
        selectEvidence(frames,source.facts);
        try { release = await acquire(signal); } catch (error) { return { status: 'SKIPPED', reason: error instanceof Error ? error.message : 'ai_capacity' }; }
        const startedAt=new Date();
        if (signal.aborted || !await store.begin(eventId,options?.reprocess,startedAt)) return { status: 'SKIPPED', reason: 'analysis_already_claimed' };
        const processingStartedAt=startedAt.toISOString();
        const {result,evidence:usedEvidence,fingerprint}=await analyseEvidence(config,client,frames,source.facts,signal,()=>store.retry(eventId),(value)=>reportTelemetry(eventId,{...value,processingStartedAt}));
        if(usedEvidence[0])Object.assign((usedEvidence[0] as Record<string,unknown>).inferenceTelemetry as object,{processingStartedAt});
        const saved = await store.save({ eventId, inputFingerprint: fingerprint, model: config.AI_MODEL!, promptVersion: PROMPT_VERSION,
          schemaVersion: SCHEMA_VERSION, result, evidence:usedEvidence, completedAt: new Date() });
        return saved ? { status: 'COMPLETE', reason: 'ai_complete' } : { status: 'FAILED', reason: 'analysis_interrupted' };
      } catch (error) { if(error instanceof EvidenceSelectionError)return {status:'SKIPPED',reason:error.code}; return { status: 'FAILED', reason: error instanceof VisionError ? error.code : 'analysis_failed', ...(error instanceof VisionError && error.diagnostics ? {validationFailure:error.diagnostics} : {}) }; }
      finally { clear(); signal.removeEventListener('abort', clear); release?.(); }
    },
  };
}

// Reused by explicit historical evaluation: this function performs no database writes.
export async function analyseEvidence(config:Config,client:VisionClient,frames:MemoryFrame[],sourceFacts:Record<string,unknown>,external:AbortSignal,onRetry:()=>Promise<void>=async()=>{},onTelemetry:(value:InferenceTelemetry & {requestAttempt:number})=>void=()=>{}) {
  const {selected,evidence,sceneCount}=selectEvidence(frames,sourceFacts),images=selected.map(f=>f.bytes);
  if(!sceneCount)throw new VisionError('invalid_model_output',failureDiagnostic('input','image_limit',['images']));
  // Alarm codes/counts/IDs are not visual action evidence and can prime the model.
  const targets=linkedTargets(sourceFacts,evidence),facts={targets,evidenceAvailability:sourceFacts.evidenceAvailability??null,targetsTruncated:sourceFacts.targetsTruncated??false};
  const fingerprint=inputFingerprint(config.AI_MODEL!,evidence,facts);
  const signal=AbortSignal.any([external,AbortSignal.timeout(config.AI_TIMEOUT_MS)]);
  try{
    let raw:unknown;
    const requests:(InferenceTelemetry & {requestAttempt:number})[]=[];
    for(let attempt=0;attempt<2;attempt++){
      try{raw=await client.analyse(images,analysisPrompt(evidence,facts,sceneCount),signal,targets.length?targets.map(t=>t.objectId):undefined,value=>{const entry={...value,requestAttempt:attempt+1};requests.push(entry);try{onTelemetry(entry);}catch{/* Telemetry is optional. */}},evidence.filter(e=>e.role==='object_crop').map(e=>e.image));break;}
      catch(error){if(!(error instanceof VisionError) || error.code!=='model_unavailable' || attempt===1 || signal.aborted)throw error;await onRetry();}
    }
    const result=groundedResult(raw,evidence,targets);
    if(evidence[0])Object.assign(evidence[0],{inferenceTelemetry:{provider:'ollama',durationUnit:'milliseconds',requests}});
    return {result,evidence,fingerprint};
  }finally{images.length=0;selected.length=0;}
}
