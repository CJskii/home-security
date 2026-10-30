import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEvidenceCoordinator } from '../src/uniview/evidence.js';
import type { EvidenceStore } from '../src/uniview/evidence-store.js';
import { config, fixtureStore, jpeg, structure } from './uniview-fixtures.js';
import { ingestNotification } from '../src/uniview/ingest.js';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });
async function setup(overrides: Partial<typeof config> = {}) {
  const rows = new Set<string>();
  const store: EvidenceStore = { interrupt: vi.fn(async () => {}),
    claim: vi.fn(async (id) => { if (rows.has(id)) return false; rows.add(id); return true; }),
    finish: vi.fn(async () => {}), sample: vi.fn(async () => {}) };
  const fetchSnapshot = vi.fn(async () => jpeg);
  const coordinator = createEvidenceCoordinator({ ...config, UNIVIEW_SAMPLING_ENABLED: true, ...overrides }, store, fetchSnapshot);
  const result = await ingestNotification(config, fixtureStore().store, structure(), 'STRUCTURE');
  return { store, fetchSnapshot, coordinator, frames: result.frames };
}
it('samples +5/+15 once, retains originals in RAM and releases at completion; duplicate does not restart', async () => {
  const f = await setup(); f.coordinator.accept('one', 1, f.frames); await vi.advanceTimersByTimeAsync(0);
  f.coordinator.accept('one', 1, f.frames); expect(f.coordinator.usage()).toEqual({ activeWindows: 1, retainedBytes: jpeg.length });
  await vi.advanceTimersByTimeAsync(4999); expect(f.fetchSnapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.fetchSnapshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000); expect(f.fetchSnapshot).toHaveBeenCalledTimes(2);
  expect(f.store.sample).toHaveBeenCalledTimes(2); expect(f.store.sample).toHaveBeenCalledWith('one', expect.objectContaining({ origin: 'NVR_LIVE', capturedAt: null, status: 'RECEIVED' }));
  expect(f.coordinator.usage()).toEqual({ activeWindows: 0, retainedBytes: 0 });
  f.coordinator.accept('one', 1, f.frames, Date.now(), false); await vi.advanceTimersByTimeAsync(30000); expect(f.fetchSnapshot).toHaveBeenCalledTimes(2);
});
it('capacity and memory limits skip processing without denying canonical ingestion', async () => {
  const f = await setup({ UNIVIEW_MAX_ACTIVE_WINDOWS: 1 }); f.coordinator.accept('one', 1, f.frames); f.coordinator.accept('two', 2, f.frames);
  await vi.advanceTimersByTimeAsync(0); expect(f.store.claim).toHaveBeenCalledWith('two', expect.any(Date), 'SKIPPED', 'capacity_exceeded');
  await f.coordinator.close(); expect(f.coordinator.usage().retainedBytes).toBe(0);
  const low = await setup({ UNIVIEW_MEMORY_BYTES: 1 }); low.coordinator.accept('one', 1, low.frames); await vi.advanceTimersByTimeAsync(0);
  expect(low.store.claim).toHaveBeenCalledWith('one', expect.any(Date), 'SKIPPED', 'memory_limit'); expect(low.coordinator.usage().activeWindows).toBe(0);
});
it('snapshot failure is recorded and timeout/shutdown release memory', async () => {
  const f = await setup(); f.fetchSnapshot.mockRejectedValue(new Error('private credentials'));
  f.coordinator.accept('one', 1, f.frames); await vi.advanceTimersByTimeAsync(15000);
  expect(f.store.sample).toHaveBeenCalledWith('one', expect.objectContaining({ status: 'FAILED', failureCode: 'snapshot_unavailable' }));
  expect(f.coordinator.usage().retainedBytes).toBe(0);
  const pending = await setup(); pending.coordinator.accept('one', 1, pending.frames); await vi.advanceTimersByTimeAsync(0); await pending.coordinator.close();
  expect(pending.store.finish).toHaveBeenCalledWith('one', 'INTERRUPTED', 'receiver_shutdown', expect.any(Date));
});
it('startup marks previous unfinished work interrupted and DB processing failures do not throw into ingestion', async () => {
  const f = await setup(); await f.coordinator.ready(); expect(f.store.interrupt).toHaveBeenCalledOnce();
  vi.mocked(f.store.claim).mockRejectedValueOnce(new Error('unavailable'));
  expect(() => f.coordinator.accept('one', 1, f.frames)).not.toThrow(); await vi.advanceTimersByTimeAsync(0); expect(f.coordinator.usage().activeWindows).toBe(0);
});

it('processing deadline frees RAM even if the asynchronous claim is stalled', async () => {
  const f = await setup(); let release!: (value: boolean) => void;
  vi.mocked(f.store.claim).mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
  f.coordinator.accept('one', 1, f.frames); await vi.advanceTimersByTimeAsync(30000);
  expect(f.coordinator.usage()).toEqual({ activeWindows: 0, retainedBytes: 0 });
  release(true); await vi.advanceTimersByTimeAsync(0); expect(f.fetchSnapshot).not.toHaveBeenCalled();
  expect(f.store.finish).toHaveBeenCalledWith('one', 'FAILED', 'processing_timeout', expect.any(Date));
});

it('AI starts from paired original pushes after a brief collection window, never calls live snapshots or waits +5/+15',async()=>{
 const f=await setup({AI_ENABLED:true,UNIVIEW_SAMPLING_ENABLED:false});
 let resolve!:(v:{status:'COMPLETE';reason:string})=>void;
 const analyse=vi.fn(()=>new Promise<{status:'COMPLETE';reason:string}>(r=>{resolve=r;}));
 const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true,UNIVIEW_SAMPLING_ENABLED:false},f.store,f.fetchSnapshot,undefined,{analyse});
 coordinator.accept('one',1,[]);await vi.advanceTimersByTimeAsync(500);
 coordinator.accept('one',1,f.frames);await vi.advanceTimersByTimeAsync(999);expect(analyse).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(analyse).toHaveBeenCalledOnce();
 expect(analyse.mock.calls[0]).toBeDefined();
 await vi.advanceTimersByTimeAsync(15000);expect(f.fetchSnapshot).not.toHaveBeenCalled();expect(f.store.sample).not.toHaveBeenCalled();
 resolve({status:'COMPLETE',reason:'ai_complete'});await vi.advanceTimersByTimeAsync(0);
 expect(coordinator.usage()).toEqual({activeWindows:0,retainedBytes:0});
 coordinator.accept('one',1,f.frames);await vi.advanceTimersByTimeAsync(2000);expect(analyse).toHaveBeenCalledOnce();
 await coordinator.close();
});
it('AI collection overflow has an explicit bounded outcome and never starts inference',async()=>{
 const f=await setup({AI_ENABLED:true});const analyse=vi.fn();
 const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true},f.store,f.fetchSnapshot,undefined,{analyse});
 const frames=Array.from({length:9},(_,n)=>({...f.frames[0]!,bytes:Buffer.from(f.frames[0]!.bytes),metadata:{...f.frames[0]!.metadata,sha256:String(n)}}));
 coordinator.accept('one',1,frames);await vi.advanceTimersByTimeAsync(1500);
 expect(analyse).not.toHaveBeenCalled();expect(f.store.finish).toHaveBeenCalledWith('one','SKIPPED','image_limit_exceeded',expect.any(Date));
 expect(coordinator.usage().retainedBytes).toBe(0);
});

it('candidate eligibility runs after collection but before inference, records intentional exclusion and preserves committed source metadata',async()=>{
 const f=await setup({AI_ENABLED:true}),source=fixtureStore(),committed=await ingestNotification(config,source.store,structure(),'STRUCTURE');
 const analyse=vi.fn(async()=>({status:'COMPLETE' as const,reason:'ai_complete'})),gate=vi.fn(async()=>({eligible:false,reason:'zone_not_selected'}));
 const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true},f.store,f.fetchSnapshot,undefined,{analyse},undefined,gate);
 coordinator.accept(committed.eventId,1,committed.frames);await vi.advanceTimersByTimeAsync(1499);expect(gate).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(gate).toHaveBeenCalledOnce();expect(analyse).not.toHaveBeenCalled();
 expect(f.store.finish).toHaveBeenCalledWith(committed.eventId,'SKIPPED','zone_not_selected',expect.any(Date));expect(coordinator.usage()).toEqual({activeWindows:0,retainedBytes:0});
 expect(source.state().events).toHaveLength(1);expect(source.state().notifications).toHaveLength(1);expect(source.state().snapshots.length).toBeGreaterThan(0);await coordinator.close();
});
it('candidate metadata read failures and deadlines fail open, while shutdown cancels a stalled decision',async()=>{
 for(const stalled of[false,true]){
  const f=await setup({AI_ENABLED:true}),analyse=vi.fn(async()=>({status:'COMPLETE' as const,reason:'ai_complete'}));
  const gate=vi.fn(async()=>{if(stalled)return new Promise<{eligible:boolean;reason:string}>(()=>{});throw new Error('metadata unavailable');});
  const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true},f.store,f.fetchSnapshot,undefined,{analyse},undefined,gate);
  coordinator.accept('one',1,f.frames);await vi.advanceTimersByTimeAsync(3500);expect(analyse).toHaveBeenCalledOnce();await coordinator.close();
 }
 const f=await setup({AI_ENABLED:true}),analyse=vi.fn(async()=>({status:'COMPLETE' as const,reason:'ai_complete'}));
 const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true},f.store,f.fetchSnapshot,undefined,{analyse},undefined,async()=>new Promise(()=>{}));
 coordinator.accept('one',1,f.frames);await vi.advanceTimersByTimeAsync(1500);await coordinator.close();expect(analyse).not.toHaveBeenCalled();expect(coordinator.usage().retainedBytes).toBe(0);
});

it('zone decisions precede evidence-window capacity: outside traffic cannot claim an AI window',async()=>{
 const f=await setup({AI_ENABLED:true,UNIVIEW_MAX_ACTIVE_WINDOWS:1});let finish!:(value:{status:'COMPLETE';reason:string})=>void;
 const analyse=vi.fn(()=>new Promise<{status:'COMPLETE';reason:string}>(r=>{finish=r;})),gate=vi.fn(async(id:string)=>({eligible:id!=='outside',reason:id==='outside'?'zone_not_selected':'selected_zone'}));
 const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true,UNIVIEW_MAX_ACTIVE_WINDOWS:1},f.store,f.fetchSnapshot,undefined,{analyse},undefined,gate);
 coordinator.accept('selected',1,f.frames);expect(coordinator.usage().activeWindows).toBe(0);await vi.advanceTimersByTimeAsync(1500);expect(coordinator.usage().activeWindows).toBe(1);
 coordinator.accept('outside',1,f.frames);await vi.advanceTimersByTimeAsync(1500);
 expect(gate).toHaveBeenCalledWith('outside',expect.any(AbortSignal));expect(f.store.finish).toHaveBeenCalledWith('outside','SKIPPED','zone_not_selected',expect.any(Date));
 expect(f.store.claim).not.toHaveBeenCalledWith('outside',expect.anything(),'SKIPPED','capacity_exceeded');expect(analyse).toHaveBeenCalledOnce();
 finish({status:'COMPLETE',reason:'ai_complete'});await vi.advanceTimersByTimeAsync(0);await coordinator.close();
});
it('pre-admission collection stays bounded by the existing upload and RAM budgets',async()=>{
 const f=await setup({AI_ENABLED:true}),coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true,UNIVIEW_MAX_CONCURRENT_UPLOADS:1},f.store,f.fetchSnapshot,undefined,{analyse:vi.fn()},undefined,async()=>({eligible:false,reason:'zone_not_selected'}));
 coordinator.accept('one',1,f.frames);coordinator.accept('two',1,f.frames);await vi.advanceTimersByTimeAsync(0);
 expect(coordinator.usage().activeWindows).toBe(0);expect(coordinator.usage().retainedBytes).toBe(jpeg.length);
 expect(f.store.claim).toHaveBeenCalledWith('two',expect.any(Date),'SKIPPED','eligibility_buffer_limit');
 await vi.advanceTimersByTimeAsync(1500);expect(coordinator.usage().retainedBytes).toBe(0);await coordinator.close();
});
it('reports burst collection pressure only for a new skip, without retaining media or changing zone eligibility',async()=>{
 const f=await setup({AI_ENABLED:true}),report=vi.fn(),gate=vi.fn(async()=>({eligible:false,reason:'zone_not_selected'})),analyse=vi.fn();
 const coordinator=createEvidenceCoordinator({...config,AI_ENABLED:true,UNIVIEW_MAX_CONCURRENT_UPLOADS:1},f.store,f.fetchSnapshot,undefined,{analyse},report,gate);
 coordinator.accept('one',1,f.frames);coordinator.accept('two',2,f.frames);coordinator.accept('two',2,f.frames);await vi.advanceTimersByTimeAsync(0);
 expect(report).toHaveBeenCalledTimes(1);expect(report).toHaveBeenCalledWith('two',{status:'SKIPPED',reason:'eligibility_buffer_limit',capacity:{stage:'collection',collectingWindows:1,admittedWindows:0,limit:1,retainedBytes:jpeg.length}});
 await vi.advanceTimersByTimeAsync(1500);expect(gate).toHaveBeenCalledOnce();expect(analyse).not.toHaveBeenCalled();expect(f.store.finish).toHaveBeenCalledWith('one','SKIPPED','zone_not_selected',expect.any(Date));
 expect(JSON.stringify(report.mock.calls)).not.toContain(jpeg.toString('base64'));await coordinator.close();
});
