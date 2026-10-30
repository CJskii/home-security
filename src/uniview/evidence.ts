import type { Config } from '../config.js';
import type { EvidenceStore, ProcessingStatus } from './evidence-store.js';
import { inspectFrame, type EvidenceMetadata, type MemoryFrame } from './ingest.js';
import type { SnapshotClient } from './snapshot-client.js';
import type { AnalysisOutcome, EventAnalyser } from '../ai/analysis.js';
export interface EvidenceOutcome extends AnalysisOutcome {
  capacity?: { stage: 'collection' | 'admission'; collectingWindows: number; admittedWindows: number; limit: number; retainedBytes: number };
}
interface Window { admitted:boolean; channel: number; startedAt: number; frames: MemoryFrame[]; timers: ReturnType<typeof setTimeout>[]; abort: AbortController; task: Promise<void>; closing: boolean; analysing: boolean; rejection: string | null }
export type EligibilityGate = (eventId:string,signal:AbortSignal)=>Promise<{eligible:boolean;reason:string}>;
export function createEvidenceCoordinator(config: Config, store: EvidenceStore, snapshot: SnapshotClient,
  reportFailure: () => void = () => {}, analysis?: EventAnalyser, reportAnalysis:(eventId:string,outcome:EvidenceOutcome)=>void=()=>{}, eligibility?:EligibilityGate) {
  const windows = new Map<string, Window>(); const busyCameras = new Set<number>();
  let retainedBytes = 0, reservedBytes = 0, stopping = false;
  const capacity = (stage:'collection'|'admission') => ({stage,collectingWindows:[...windows.values()].filter(w=>!w.admitted).length,admittedWindows:[...windows.values()].filter(w=>w.admitted).length,limit:stage==='collection'?config.UNIVIEW_MAX_CONCURRENT_UPLOADS:config.UNIVIEW_MAX_ACTIVE_WINDOWS,retainedBytes});
  const full = (f: MemoryFrame) => f.metadata.imageType !== '2' && (f.metadata.width ?? 0) >= 1280 && (f.metadata.height ?? 0) >= 720;
  function release(id: string, w: Window) {
    for (const timer of w.timers) clearTimeout(timer);
    w.abort.abort();
    retainedBytes -= w.frames.reduce((sum, f) => sum + f.bytes.length, 0); w.frames.length = 0;
    if (windows.get(id) === w) windows.delete(id);
  }
  function initial(incoming: MemoryFrame[]) {
    return incoming.filter(f=>f.metadata.origin==='NVR_PUSH' && f.metadata.status==='RECEIVED' && ['1','2'].includes(f.metadata.imageType??''));
  }
  function add(w: Window, incoming: MemoryFrame[]) {
    for (const f of incoming) {
      if (w.frames.some((old) => old.metadata.sha256 === f.metadata.sha256)) continue;
      if (w.frames.length >= 8) {w.rejection='image_limit_exceeded';continue;}
      if (retainedBytes + reservedBytes + f.bytes.length > config.UNIVIEW_MEMORY_BYTES) {w.rejection='memory_limit';continue;}
      w.frames.push(f); retainedBytes += f.bytes.length;
    }
  }
  async function finish(id: string, w: Window, status: ProcessingStatus, reason: string) {
    if (w.closing) return; w.closing = true; release(id, w);
    try { await store.finish(id, status, reason, new Date()); } catch { reportFailure(); }
  }
  async function sample(id: string, w: Window, ordinal: number) {
    if (w.closing || stopping) return;
    const requestedAt = new Date();
    let metadata: EvidenceMetadata = { imageOrdinal: ordinal, sourceImageIndex: null, imageType: null,
      declaredWidth: null, declaredHeight: null, capturedAt: null, origin: 'NVR_LIVE', sha256: null,
      bytes: null, width: null, height: null, requestedAt, acquiredAt: null, status: 'FAILED', failureCode: 'snapshot_unavailable' };
    if (busyCameras.has(w.channel)) metadata.failureCode = 'camera_busy';
    // Reserve enough space for the bounded response and Buffer.concat copy.
    else if (retainedBytes + reservedBytes + 2 * config.UNIVIEW_MAX_IMAGE_BYTES > config.UNIVIEW_MEMORY_BYTES) metadata.failureCode = 'memory_limit';
    else {
      busyCameras.add(w.channel); reservedBytes += 2 * config.UNIVIEW_MAX_IMAGE_BYTES;
      try {
        const signal = AbortSignal.any([w.abort.signal, AbortSignal.timeout(config.UNIVIEW_SNAPSHOT_TIMEOUT_MS)]);
        const bytes = await snapshot(w.channel, signal);
        if (!w.closing) {
          metadata.acquiredAt = new Date();
          const f = inspectFrame(bytes, metadata, config);
          if (f.metadata.width !== 3840 || f.metadata.height !== 2160) metadata.failureCode = 'unexpected_resolution';
          else {
            metadata = f.metadata;
            reservedBytes -= 2 * config.UNIVIEW_MAX_IMAGE_BYTES;
            add(w, [f]);
            reservedBytes += 2 * config.UNIVIEW_MAX_IMAGE_BYTES;
          }
        }
      } catch { metadata.failureCode = w.abort.signal.aborted ? 'interrupted' : 'snapshot_unavailable'; }
      finally { busyCameras.delete(w.channel); reservedBytes -= 2 * config.UNIVIEW_MAX_IMAGE_BYTES; }
    }
    if (!w.closing) {
      try { await store.sample(id, metadata); } catch { reportFailure(); await finish(id, w, 'FAILED', 'evidence_persistence_failed'); }
      if (!w.closing && ordinal === config.UNIVIEW_SAMPLE_DELAYS_MS.length - 1) {
        if (!config.AI_ENABLED) await finish(id, w, 'COMPLETE', w.frames.some(full) ? 'ai_disabled' : 'no_full_frame');
        else await analyseOriginals(id,w);

      }
    }
  }
  async function analyseOriginals(id:string,w:Window) {
    if(w.closing || stopping)return;
    w.analysing=true;
    if(eligibility){
      // After the existing paired-notification collection, before Base64 copies,
      // analysis.begin(), the inference queue or any model request. Canonical
      // ingestion has already committed independently. Fail open on read errors.
      let decision:{eligible:boolean;reason:string}|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
      const gateAbort=new AbortController(),gateSignal=AbortSignal.any([w.abort.signal,gateAbort.signal]);
      let interrupt=()=>{};
      const bounded=new Promise<never>((_resolve,reject)=>{
        interrupt=()=>reject(new Error('eligibility_interrupted'));
        gateSignal.addEventListener('abort',interrupt,{once:true});
        deadline=setTimeout(()=>gateAbort.abort(),2000);
      });
      try{decision=await Promise.race([eligibility(id,gateSignal),bounded]);}catch{reportFailure();}
      finally{clearTimeout(deadline);gateSignal.removeEventListener('abort',interrupt);gateAbort.abort();}
      if(w.closing||stopping)return;
      if(decision&&!decision.eligible){await finish(id,w,'SKIPPED',decision.reason);return;}
    }
    if(w.rejection){await finish(id,w,'SKIPPED',w.rejection);return;}
    if(eligibility&&!w.admitted){
      if([...windows.values()].filter(other=>other.admitted).length>=config.UNIVIEW_MAX_ACTIVE_WINDOWS){reportAnalysis(id,{status:'SKIPPED',reason:'capacity_exceeded',capacity:capacity('admission')});await finish(id,w,'SKIPPED','capacity_exceeded');return;}
      w.admitted=true;
    }
    if(!analysis){await finish(id,w,'FAILED','analysis_unavailable');return;}
    // Account for Base64/request copies of all bounded original evidence.
    const extra=3*w.frames.reduce((sum,f)=>sum+f.bytes.length,0);
    if(retainedBytes+reservedBytes+extra>config.UNIVIEW_MEMORY_BYTES){await finish(id,w,'SKIPPED','ai_memory_limit');return;}
    reservedBytes+=extra;
    try {
      const outcome=await analysis.analyse(id,w.frames,w.abort.signal);
      reportAnalysis(id,outcome);
      if(!w.closing)await finish(id,w,stopping?'INTERRUPTED':outcome.status,stopping?'receiver_shutdown':outcome.reason);
    } finally {reservedBytes-=extra;}
  }
  return {
    async ready() { await store.interrupt(); },
    accept(eventId: string, channel: number, frames: MemoryFrame[], receivedAt = Date.now(), newNotification = true) {
      const existing = windows.get(eventId);
      if (existing) { if (!existing.closing && !existing.analysing) add(existing, initial(frames)); return; }
      if (stopping || !newNotification) return;
      const selected = initial(frames);
      const skipped = !config.AI_ENABLED && !config.UNIVIEW_SAMPLING_ENABLED ? 'sampling_disabled' : !eligibility && windows.size >= config.UNIVIEW_MAX_ACTIVE_WINDOWS ? 'capacity_exceeded' : eligibility && [...windows.values()].filter(w=>!w.admitted).length>=config.UNIVIEW_MAX_CONCURRENT_UPLOADS ? 'eligibility_buffer_limit' : retainedBytes + reservedBytes + selected.reduce((sum, f) => sum + f.bytes.length, 0) > config.UNIVIEW_MEMORY_BYTES ? 'memory_limit' : null;
      if (skipped) {
        const details = skipped==='eligibility_buffer_limit' ? capacity('collection') : skipped==='capacity_exceeded' ? capacity('admission') : undefined;
        void store.claim(eventId, new Date(receivedAt), 'SKIPPED', skipped).then(claimed=>{if(claimed)reportAnalysis(eventId,{status:'SKIPPED',reason:skipped,...(details?{capacity:details}:{})});}).catch(reportFailure); return;
      }
      const w: Window = { admitted:!eligibility, channel, startedAt: receivedAt, frames: [], timers: [], abort: new AbortController(), task: Promise.resolve(), closing: false, analysing:false, rejection:null };
      windows.set(eventId, w); add(w, selected);
      w.timers.push(setTimeout(() => { void finish(eventId, w, 'FAILED', 'processing_timeout'); }, Math.max(0, receivedAt + config.UNIVIEW_PROCESSING_TIMEOUT_MS - Date.now())));
      w.task = (async () => {
        try {
          if (!await store.claim(eventId, new Date(receivedAt), 'COLLECTING', null)) { release(eventId, w); return; }
          if (w.closing) { await store.finish(eventId, 'FAILED', 'processing_timeout', new Date()); return; }
          if (stopping) { await finish(eventId, w, 'INTERRUPTED', 'receiver_shutdown'); return; }
          if(config.AI_ENABLED){
            // Brief bounded collection of paired Alarm/Structure pushes, not temporal
            // acquisition. Later notifications still persist, but never mutate a running request.
            w.timers.push(setTimeout(()=>{w.task=w.task.then(()=>analyseOriginals(eventId,w)).catch(()=>finish(eventId,w,'FAILED','processing_failed'));},1500));
            return;
          }
          for (const [ordinal, delay] of config.UNIVIEW_SAMPLE_DELAYS_MS.entries()) {
            w.timers.push(setTimeout(() => { w.task = w.task.then(() => sample(eventId, w, ordinal)).catch(() => finish(eventId, w, 'FAILED', 'processing_failed')); }, Math.max(0, receivedAt + delay - Date.now())));
          }
        } catch { release(eventId, w); reportFailure(); }
      })();
    },
    usage() { return { activeWindows: [...windows.values()].filter(w=>w.admitted).length, retainedBytes }; },
    async close() {
      stopping = true;
      const pending = [...windows.entries()];
      for (const [, w] of pending) w.abort.abort();
      for (const [id, w] of pending) { await w.task; await finish(id, w, 'INTERRUPTED', 'receiver_shutdown'); }
    },
  };
}
export type EvidenceCoordinator = ReturnType<typeof createEvidenceCoordinator>;
