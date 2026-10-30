import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { analysisSchema, type AnalysisResult } from '../src/ai/schemas.js';
import { visualResponseSchema } from '../src/ai/visual-schema.js';
import { decodeCompactResponse } from '../src/ai/compact-schema.js';
import { selectEvidence } from '../src/ai/evidence.js';
import { createEventAnalyser, analyseEvidence } from '../src/ai/analysis.js';
import type { AnalysisStore, AnalysisWrite } from '../src/ai/store.js';
import { VisionError, type VisionClient } from '../src/ai/client.js';
import {failureDiagnostic} from '../src/ai/failure-diagnostics.js';
import { createEvidenceStore } from '../src/uniview/evidence-store.js';
import { createEvidenceCoordinator } from '../src/uniview/evidence.js';
import type { EvidenceStore } from '../src/uniview/evidence-store.js';
import { inspectFrame } from '../src/uniview/ingest.js';
import { config, jpeg, fixtureStore, alarm } from './uniview-fixtures.js';
import { loadConfig } from '../src/config.js';
import { loggerOptions } from '../src/logging.js';
import { buildReceiver } from '../src/uniview/app.js';
import { historySchema } from '../src/events/queries.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
const start = Date.parse('2026-10-13T00:00:00Z');
const ai = { ...config, AI_ENABLED: true, AI_BASE_URL: 'http://ollama-api:11434', AI_MODEL: 'qwen3-vl:4b-instruct', AI_ENABLEMENT_CUTOFF: new Date(start), AI_TIMEOUT_MS: 60000,
  UNIVIEW_SAMPLING_ENABLED: true, UNIVIEW_PROCESSING_TIMEOUT_MS: 120000 };
const output: AnalysisResult = { activityLabel: 'standing', shortDescription: 'A person stands beside a vehicle.',
  objects: [], subjects: [{ type: 'person', count: 1 }], uncertainties: ['Subject detail is unclear.'] };
function frame(offset: number, tag: number, crop = false) {
  const bytes = Buffer.from(jpeg); bytes[25] = tag;
  if (crop) { bytes.writeUInt16BE(352, 7); bytes.writeUInt16BE(224, 9); }
  return inspectFrame(bytes, { imageOrdinal: tag, sourceImageIndex: null, imageType: crop ? '2' : '1', declaredWidth: null, declaredHeight: null,
    capturedAt: offset === 0 ? new Date(start) : null, origin: offset === 0 ? 'NVR_PUSH' : 'NVR_LIVE', sha256: null, bytes: null, width: null, height: null,
    status: 'FAILED', failureCode: null, requestedAt: new Date(start + offset), acquiredAt: new Date(start + offset) }, config);
}
const objectId='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const modelOutput=visualResponseSchema.parse(decodeCompactResponse({objects:[{objectId,observedType:'person',verification:'uncertain',person:{},actions:['visible'],evidenceImages:[1,2],confidence:{observedType:null,verification:null,actions:null},shortDescription:'A person is visible.'}]},[objectId],2));
const pair=()=>[frame(0,1),frame(0,4,true)];
function fixture() {
  const begun = new Set<string>(), saved: AnalysisWrite[] = [];
  const facts = { persons: 2, vehicles: 0, targets:[{objectId,category:'person',fullFrameSha256:frame(0,1).metadata.sha256,cropSha256:frame(0,4,true).metadata.sha256}] };
  const store: AnalysisStore = { source: vi.fn(async () => ({ confirmed: true, firstReceivedAt: new Date(start), facts })),
    begin: vi.fn(async (id) => { if (begun.has(id)) return false; begun.add(id); return true; }),
    retry:vi.fn(async()=>{}), save: vi.fn(async (write) => { saved.push(write); return true; }) };
  const client = { analyse: vi.fn<VisionClient['analyse']>(async () => modelOutput) };
  return { store, client, saved, facts, analyser: createEventAnalyser(ai, store, client) };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); });
it('strict structured results reject media, extra identity claims, malformed counts and invalid labels', () => {
  expect(analysisSchema.parse(output)).toEqual(output);
  for (const value of [{ ...output, images: ['private'] }, { ...output, activityLabel: 'criminal' }, { ...output, shortDescription: '/9j/private-media' },
    { ...output, subjects: [{ type: 'person', count: -1 }] }, { ...output, identity: 'neighbour' }]) expect(analysisSchema.safeParse(value).success).toBe(false);
});
it('only original scenes/crops are selected; live temporal samples stay out of inference', () => {
  const original = frame(0, 1), five = frame(5000, 2), fifteen = frame(15000, 3), crop = frame(0, 4, true);
  const chosen = selectEvidence([fifteen, crop, five, original, five, frame(500, 5)]);
  expect(chosen.selected.map((f) => f.metadata.sha256)).toEqual([original, crop].map((f) => f.metadata.sha256));
  expect(chosen.evidence[1]).toMatchObject({ sourceTimestamp: new Date(start).toISOString(), timeBasis: 'source_capture' });
  expect(selectEvidence([five, crop, original]).evidence[1]!.role).toBe('object_crop');
  expect(selectEvidence([crop]).sceneCount).toBe(0);
});
it('one initial analysis stays on its event UUID; writes contain only metadata/results and source facts stay separate', async () => {
  const f = fixture(), id = randomUUID(), frames = [...pair(), frame(5000, 2), frame(15000, 3)];
  expect(await f.analyser.analyse(id, frames, new AbortController().signal)).toEqual({ status: 'COMPLETE', reason: 'ai_complete' });
  expect((await f.analyser.analyse(id, frames, new AbortController().signal)).reason).toBe('analysis_already_claimed');
  expect(f.client.analyse).toHaveBeenCalledTimes(1); expect(f.saved).toHaveLength(1); expect(f.saved[0]).toMatchObject({ eventId: id, model: ai.AI_MODEL, promptVersion: 5, schemaVersion: 3 });
  expect(f.saved[0]!.inputFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(f.facts.persons).toBe(2); expect(f.saved[0]!.result.subjects[0]).toMatchObject({objectId});
  for (const image of frames) expect(JSON.stringify(f.saved)).not.toContain(image.bytes.toString('base64'));
  expect(String(f.client.analyse.mock.calls[0]![1])).not.toContain(frames[0]!.bytes.toString('base64'));
});
it('single-view evidence stays unknown/uncertain; initial-image loss and cutoff are explicit', async () => {
  const f = fixture(); const result = await f.analyser.analyse(randomUUID(), [frame(5000, 1)], new AbortController().signal);
  expect(result).toEqual({status:'SKIPPED',reason:'no_full_frame'}); expect(f.saved).toHaveLength(0);
  vi.mocked(f.store.source).mockResolvedValueOnce({ confirmed: true, firstReceivedAt: new Date(start - 1), facts: {} });
  expect((await f.analyser.analyse(randomUUID(), pair(), new AbortController().signal)).reason).toBe('ai_before_cutoff');
});
it('unreachable or invalid model output fails safely, with bounded transient retry', async () => {
  for (const error of [new VisionError('model_unavailable'), new VisionError('invalid_model_output'), new Error('private-model-details')]) {
    const f = fixture(); f.client.analyse.mockRejectedValue(error);
    const result = await f.analyser.analyse(randomUUID(), pair(), new AbortController().signal);
    expect(result.status).toBe('FAILED'); expect(result.reason).not.toContain('private'); expect(f.saved).toHaveLength(0); expect(f.client.analyse).toHaveBeenCalledTimes(error instanceof VisionError && error.code==='model_unavailable'?2:1);
  }
});
it('preserves bounded failure diagnostics through the analysis outcome without persisting a rejected analysis',async()=>{
 const f=fixture(),diagnostics=failureDiagnostic('grounding','source_verification',['objects',0,'verification']);
 f.client.analyse.mockRejectedValueOnce(new VisionError('invalid_model_output',diagnostics));
 expect(await f.analyser.analyse(randomUUID(),pair(),new AbortController().signal)).toEqual({status:'FAILED',reason:'invalid_model_output',validationFailure:diagnostics});
 expect(f.store.save).not.toHaveBeenCalled();expect(f.store.retry).not.toHaveBeenCalled();
});
it('one inference and one pending window are bounded; queue timeout releases admission', async () => {
  const f = fixture(); let resolve!: (v: typeof modelOutput) => void;
  f.client.analyse.mockImplementationOnce(() => new Promise<typeof modelOutput>((r) => { resolve = r; }));
  const first = f.analyser.analyse(randomUUID(), pair(), new AbortController().signal); await vi.advanceTimersByTimeAsync(0);
  const second = f.analyser.analyse(randomUUID(), pair(), new AbortController().signal); await vi.advanceTimersByTimeAsync(0);
  expect(f.analyser.usage()).toEqual({ active: 1, queued: 1 });
  expect((await f.analyser.analyse(randomUUID(), pair(), new AbortController().signal)).reason).toBe('ai_capacity');
  await vi.advanceTimersByTimeAsync(30000); expect((await second).reason).toBe('ai_queue_timeout');
  resolve(modelOutput); await first; expect(f.analyser.usage()).toEqual({ active: 0, queued: 0 });
});
it('receiver keeps accepting canonical Alarms during AI; buffers release at completion and duplicates do not reinfer', async () => {
  const f = fixture(); let resolve!: (v: typeof modelOutput) => void;
  f.client.analyse.mockImplementationOnce(() => new Promise<typeof modelOutput>((r) => { resolve = r; }));
  const rows = new Set<string>(); const evidenceStore: EvidenceStore = { interrupt: vi.fn(async () => {}), claim: vi.fn(async (id) => { if (rows.has(id)) return false; rows.add(id); return true; }), finish: vi.fn(async () => {}), sample: vi.fn(async () => {}) };
  let tag = 10;
  const coordinator = createEvidenceCoordinator(ai, evidenceStore, async () => frame(Date.now() - start, tag++).bytes, undefined, f.analyser);
  const firstId = randomUUID(); coordinator.accept(firstId, 1, pair()); await vi.advanceTimersByTimeAsync(15000);
  expect(f.client.analyse).toHaveBeenCalledTimes(1); expect(coordinator.usage().retainedBytes).toBeGreaterThan(0);
  const ingestion = fixtureStore(); const service = buildReceiver(ai, { uniview: ingestion.store, checkReady: async () => {}, disconnect: async () => {} }, coordinator);
  try {
    const body = JSON.stringify(alarm('second'));
    const response = await service.app.inject({ method: 'POST', url: '/LAPI/V1.0/System/Event/Notification/Alarm', remoteAddress: '10.0.0.1', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, payload: body });
    expect(response.statusCode).toBe(200); expect(ingestion.state().events[0]!.nativeEndedAt).toBeNull();
    resolve(modelOutput); await vi.advanceTimersByTimeAsync(0);
    coordinator.accept(firstId, 1, pair(), Date.now(), false); await vi.advanceTimersByTimeAsync(0);
    expect(f.client.analyse).toHaveBeenCalledTimes(1);
  } finally { await service.app.close(); }
  expect(coordinator.usage()).toEqual({ activeWindows: 0, retainedBytes: 0 });
});
it('restart interrupts collection and analysis; query API filters activity without changing NVR facts', async () => {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  await createEvidenceStore({ evidenceProcessing: { updateMany } } as unknown as PrismaClient).interrupt();
  expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['COLLECTING', 'ANALYSING'] } }, data: expect.objectContaining({ status: 'INTERRUPTED' }) }));
  expect(historySchema.parse({ activityLabel: 'approaching' })).toMatchObject({ activityLabel: 'approaching' });
});
it('shutdown aborts slow inference and releases all retained evidence without saving a result', async () => {
  const f = fixture();
  f.client.analyse.mockImplementationOnce((_images, _prompt, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new VisionError('vision_timeout')), { once: true });
  }));
  const finish = vi.fn(async () => {});
  const store: EvidenceStore = { interrupt: vi.fn(async () => {}), claim: vi.fn(async () => true), finish, sample: vi.fn(async () => {}) };
  const coordinator = createEvidenceCoordinator(ai, store, async () => frame(Date.now() - start, 2).bytes, undefined, f.analyser);
  coordinator.accept(randomUUID(), 1, pair());
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.analyser.usage().active).toBe(1);
  await coordinator.close();
  expect(coordinator.usage()).toEqual({ activeWindows: 0, retainedBytes: 0 });
  expect(f.analyser.usage()).toEqual({ active: 0, queued: 0 });
  expect(f.saved).toHaveLength(0);
  expect(finish).toHaveBeenCalledWith(expect.any(String), 'INTERRUPTED', 'receiver_shutdown', expect.any(Date));
});
it('AI enables only with local vision settings and enough bounded collection/inference time', () => {
  const base = { DATABASE_URL: config.DATABASE_URL, AI_ENABLED: 'true' };
  expect(() => loadConfig(base)).toThrow('AI_BASE_URL');
  expect(() => loadConfig({ DATABASE_URL: config.DATABASE_URL, AI_BASE_URL: 'https://api.ollama.com' })).toThrow('AI_BASE_URL');
  expect(() => loadConfig({ DATABASE_URL: config.DATABASE_URL, AI_BASE_URL: 'https://192.168.example.com' })).toThrow('AI_BASE_URL');
  expect(loadConfig({ DATABASE_URL: config.DATABASE_URL }).AI_ENABLED).toBe(false);
});
it('operational logs redact prompts/images/descriptions and AI credentials', () => {
  let text = ''; const destination = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  const log = pino(loggerOptions({ ...config, LOG_LEVEL: 'info' }), destination);
  log.info({ prompt: 'private-prompt', images: ['private-image'], shortDescription: 'private-description', AI_BEARER_TOKEN: 'private-token', subjects: [{ identity: 'private-subject' }] }, 'safe category');
  expect(text).not.toMatch(/private-prompt|private-image|private-description|private-token|private-subject/); expect(text).toContain('[REDACTED]');
});
it('transient retry is counted once within the same claim; invalid output is never retried',async()=>{
 const f=fixture();f.client.analyse.mockRejectedValueOnce(new VisionError('model_unavailable'));
 const result=await f.analyser.analyse(randomUUID(),pair(),new AbortController().signal);
 expect(result.status).toBe('COMPLETE');expect(f.store.begin).toHaveBeenCalledOnce();expect(f.store.retry).toHaveBeenCalledOnce();expect(f.client.analyse).toHaveBeenCalledTimes(2);expect(f.saved).toHaveLength(1);
});
it('eligible Structure-only object evidence can be analysed and explicit reprocessing remains one canonical UUID',async()=>{
 const f=fixture(),id=randomUUID();
 expect((await f.analyser.analyse(id,pair(),new AbortController().signal,{reprocess:true})).status).toBe('COMPLETE');
 expect(f.store.begin).toHaveBeenCalledWith(id,true,expect.any(Date));expect(f.saved[0]!.eventId).toBe(id);
});
it('does not prime visual action inference with EnterArea codes, native IDs or NVR counts',async()=>{
 const f=fixture();Object.assign(f.facts,{alarmType:'EnterArea',sourceObjects:[{id:'native-alarm-id',typeCode:2}]});
 await f.analyser.analyse(randomUUID(),pair(),new AbortController().signal);
 expect(String(f.client.analyse.mock.calls[0]![1])).not.toMatch(/EnterArea|native-alarm-id|"persons":2/);
});

it('evidence selection excludes original images belonging to unselected objects',()=>{
 const original=frame(0,1),crop=frame(0,2,true),other=frame(0,3),later=frame(5000,4);
 const chosen=selectEvidence([other,later,crop,original],{targets:[{fullFrameSha256:original.metadata.sha256,cropSha256:crop.metadata.sha256}]});
 expect(chosen.selected.map(f=>f.metadata.sha256)).toEqual([original.metadata.sha256,crop.metadata.sha256]);
});

it('requires every exact scene/crop pair, reuses shared scenes and enforces image/object limits',()=>{
 const scene=frame(0,1),a=frame(0,2,true),b=frame(0,3,true);
 const target=(objectId:string,full=scene,crop=a)=>({objectId,category:'person',fullFrameSha256:full.metadata.sha256,cropSha256:crop.metadata.sha256});
 const one=selectEvidence([scene,a,frame(5000,4)],{targets:[target(objectId)]});
 expect(one.selected).toEqual([scene,a]);
 const second=randomUUID(),multiple=selectEvidence([b,a,scene],{targets:[target(objectId),target(second,scene,b)]});
 expect(multiple.selected).toEqual([scene,a,b]);
 expect(multiple.evidence.map(e=>e.role)).toEqual(['scene','object_crop','object_crop']);
 for(const frames of [[scene],[a],[scene,b]])expect(()=>selectEvidence(frames,{targets:[target(objectId)]})).toThrow('original_evidence_missing');
 const corrupted={...a,bytes:Buffer.from(a.bytes)};corrupted.bytes[25]=99;
 expect(()=>selectEvidence([scene,corrupted],{targets:[target(objectId)]})).toThrow('original_evidence_integrity');
 expect(()=>selectEvidence([scene,a],{targets:[target(objectId)],targetsTruncated:true})).toThrow('object_limit_exceeded');
 const pairs=[1,2,3,4].map(n=>({scene:frame(0,n),crop:frame(0,n+10,true)}));
 expect(()=>selectEvidence(pairs.flatMap(p=>[p.scene,p.crop]),{targets:pairs.map(p=>target(randomUUID(),p.scene,p.crop))})).toThrow('image_limit_exceeded');
 const six=selectEvidence(pairs.slice(0,3).flatMap(p=>[p.scene,p.crop]),{targets:pairs.slice(0,3).map(p=>target(randomUUID(),p.scene,p.crop))});
 expect(six.selected).toHaveLength(6);
});
it('missing original crop skips before capacity, model invocation or analysis persistence',async()=>{
 const f=fixture();
 expect(await f.analyser.analyse(randomUUID(),[frame(0,1)],new AbortController().signal)).toEqual({status:'SKIPPED',reason:'original_evidence_missing'});
 expect(f.client.analyse).not.toHaveBeenCalled();expect(f.store.begin).not.toHaveBeenCalled();expect(f.store.save).not.toHaveBeenCalled();
});
it('numeric telemetry stays on the same canonical event and request attempt in atomic analysis metadata',async()=>{
 const f=fixture(),eventId=randomUUID();
 const numbers={promptTokens:2000,generatedTokens:150,inputProcessingMs:4000,generationMs:3000,totalInferenceMs:8000};
 f.client.analyse.mockImplementationOnce(async (_images,_prompt,_signal,_ids,onTelemetry,crops)=>{
  expect(crops).toEqual([2]);onTelemetry?.(numbers);return modelOutput;
 });
 const reports=vi.fn(),analyser=createEventAnalyser(ai,f.store,f.client,reports);
 expect((await analyser.analyse(eventId,pair(),new AbortController().signal)).status).toBe('COMPLETE');
 expect(reports).toHaveBeenCalledWith(eventId,{...numbers,requestAttempt:1,processingStartedAt:new Date(start).toISOString()});
 expect(f.saved[0]!.evidence[0]).toMatchObject({inferenceTelemetry:{provider:'ollama',durationUnit:'milliseconds',processingStartedAt:new Date(start).toISOString(),requests:[{...numbers,requestAttempt:1}]}});
 expect(JSON.stringify(f.saved[0]!.evidence[0])).not.toContain('prompt text');
});
it('enabled AI needs no live-sampling flag or live-snapshot credentials',()=>{
 const result=loadConfig({DATABASE_URL:config.DATABASE_URL,UNIVIEW_ENABLED:'true',UNIVIEW_INSTALLATION_ID:objectId,UNIVIEW_NVR_IP:'10.0.0.1',SHUTDOWN_TIMEOUT_MS:'30000',AI_ENABLED:'true',AI_BASE_URL:'http://ollama-api:11434',AI_MODEL:'vision',AI_ENABLEMENT_CUTOFF:new Date(start).toISOString(),AI_TIMEOUT_MS:'60000',UNIVIEW_PROCESSING_TIMEOUT_MS:'120000',UNIVIEW_SAMPLING_ENABLED:'false'});
 expect(result.AI_ENABLED).toBe(true);expect(result.UNIVIEW_SAMPLING_ENABLED).toBe(false);
});

it('inference timing is not part of the deterministic input fingerprint',async()=>{
 const f=fixture();let count=10;
 f.client.analyse.mockImplementation(async(_images,_prompt,_signal,_ids,report)=>{report?.({promptTokens:100,generatedTokens:count++,inputProcessingMs:10,generationMs:20,totalInferenceMs:30});return modelOutput;});
 const first=await analyseEvidence(ai,f.client,pair(),f.facts,new AbortController().signal);
 const second=await analyseEvidence(ai,f.client,pair(),f.facts,new AbortController().signal);
 expect(first.fingerprint).toBe(second.fingerprint);expect(first.evidence).not.toEqual(second.evidence);
});
