import { afterEach, expect, it, vi } from 'vitest';
import { buildReceiver } from '../src/uniview/app.js';
import { buildApp } from '../src/app.js';
import { config, alarm, fixtureStore } from './uniview-fixtures.js';
import { notificationPaths } from '../src/uniview/schemas.js';
const instances: { app: { close(): Promise<void> } }[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((s) => s.app.close())); });
function setup() {
  const f = fixtureStore(); const database = { uniview: f.store, checkReady: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const service = buildReceiver(config, database); instances.push(service);
  return { ...service, ...f, database };
}
it('receiver accepts committed/deduplicated source notifications and never invokes downstream delivery', async () => {
  const f = setup(); const send = () => f.app.inject({ method: 'POST', url: notificationPaths.ALARM, remoteAddress: '10.0.0.1', payload: JSON.stringify(alarm()), headers: { 'content-type': 'application/json' } });
  const first = await send(), repeat = await send(); expect(first.statusCode).toBe(200); expect(repeat.json()).toMatchObject({ accepted: true, eventId: first.json().eventId, newNotification: false });
  expect(f.state().events).toHaveLength(1); expect((await f.app.inject('/ready')).statusCode).toBe(200);
});
it('source filtering ignores forwarded headers and HTTP errors disclose no payload', async () => {
  const f = setup(); const response = await f.app.inject({ method: 'POST', url: notificationPaths.ALARM, remoteAddress: '10.0.0.2', payload: JSON.stringify(alarm()), headers: { 'x-forwarded-for': '10.0.0.1' } });
  expect(response.statusCode).toBe(403); expect(f.state().events).toHaveLength(0);
  const bad = await f.app.inject({ method: 'POST', url: notificationPaths.ALARM, remoteAddress: '10.0.0.1', payload: '{"secret":"private", "secret":1}', headers: { 'content-type': 'application/json' } });
  expect(bad.statusCode).toBe(400); expect(bad.body).not.toContain('private');
});
it('storage failures return retryable 503; receiver shutdown stops admission', async () => {
  const f = setup(); vi.spyOn(f.store, 'commit').mockRejectedValue(new Error('private DB'));
  const options = { method: 'POST' as const, url: notificationPaths.ALARM, remoteAddress: '10.0.0.1', payload: JSON.stringify(alarm()), headers: { 'content-type': 'application/json' } };
  expect((await f.app.inject(options)).statusCode).toBe(503); f.markStopping(); expect((await f.app.inject(options)).statusCode).toBe(503);
  await f.app.close(); expect(f.database.disconnect).toHaveBeenCalledOnce();
});
it('query API has no removed write/grouping/AI routes and protects canonical history', async () => {
  const database = { checkReady: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), events: {
    history: vi.fn(async () => [{ id: '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb', createdAt: new Date() }]), get: vi.fn(), notifications: vi.fn(), snapshots: vi.fn(),
  } };
  const service = buildApp({ ...config, EVENTS_TOKEN: 'e'.repeat(32) }, database); instances.push(service);
  for (const url of ['/api/scenes/compare', '/api/activities', '/api/analyses', '/api/evidence-scores']) expect((await service.app.inject(url)).statusCode).toBe(404);
  expect((await service.app.inject({ method: 'POST', url: '/api/events', payload: {} })).statusCode).toBe(404);
  expect((await service.app.inject('/api/events')).statusCode).toBe(401);
  const response = await service.app.inject({ url: '/api/events', headers: { authorization: `Bearer ${'e'.repeat(32)}` } });
  expect(response.statusCode).toBe(200); expect(response.json().events[0]).toMatchObject({ source: 'UNIVIEW', authority: 'authoritative' });
});
it('event detail preserves canonical facts, processing and AI interpretation without presentation state', async () => {
  const id = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
  const row = { id, nvrChannel: 1, alarmType: 'EnterArea', nativeEndedAt: null,
    processing: { status: 'COMPLETE' }, analysis: { shortDescription: 'A person is visible.' } };
  const get = vi.fn(async () => row);
  const service = buildApp({ ...config, EVENTS_TOKEN: 'e'.repeat(32) }, {
    checkReady: async () => {}, disconnect: async () => {},
    events: { history: vi.fn(), get, notifications: vi.fn(), snapshots: vi.fn() },
  }); instances.push(service);
  expect((await service.app.inject(`/api/events/${id}`)).statusCode).toBe(401);
  expect(get).not.toHaveBeenCalled();
  const response = await service.app.inject({ url: `/api/events/${id}`, headers: { authorization: `Bearer ${'e'.repeat(32)}` } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ...row, source: 'UNIVIEW', authority: 'authoritative',
    analysis: { ...row.analysis, authority: 'ai_interpretation' } });
  expect(get).toHaveBeenCalledWith(id);
});
it('bounded admission holds a slot through persistence and releases it after failure', async () => {
  const f = fixtureStore(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const commit = vi.fn(async (data: Parameters<typeof f.store.commit>[0]) => { await gate; return f.store.commit(data); });
  const service = buildReceiver({ ...config, UNIVIEW_MAX_CONCURRENT_UPLOADS: 1 }, { uniview: { commit }, checkReady: async () => {}, disconnect: async () => {} }); instances.push(service);
  const options = { method: 'POST' as const, url: notificationPaths.ALARM, remoteAddress: '10.0.0.1', payload: JSON.stringify(alarm()), headers: { 'content-type': 'application/json' } };
  const first = service.app.inject(options); await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
  expect((await service.app.inject(options)).statusCode).toBe(503); release(); expect((await first).statusCode).toBe(200);
  expect((await service.app.inject(options)).statusCode).toBe(200);
});
it('receiver rejects transfer framing, incompatible media type and oversize body; accepts omitted content type', async () => {
  const f = setup();
  const options = { method: 'POST' as const, url: notificationPaths.ALARM, remoteAddress: '10.0.0.1', payload: Buffer.from(JSON.stringify(alarm())) };
  expect((await f.app.inject(options)).statusCode).toBe(200);
  expect((await f.app.inject({ ...options, headers: { 'content-type': 'text/plain' } })).statusCode).toBe(415);
  expect((await f.app.inject({ ...options, headers: { 'transfer-encoding': 'chunked' } })).statusCode).toBe(400);
  expect((await f.app.inject({ ...options, headers: { 'content-length': String(config.UNIVIEW_MAX_BODY_BYTES + 1) } })).statusCode).toBe(413);
});

it('HTTP acknowledgement never waits for asynchronous evidence status/sampling', async () => {
  const f = fixtureStore(); let release!: (v: boolean) => void;
  const evidence = { interrupt: async () => {}, claim: vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; })), finish: async () => {}, sample: async () => {} };
  const service = buildReceiver({ ...config, UNIVIEW_SAMPLING_ENABLED: true }, { uniview: f.store, evidence, checkReady: async () => {}, disconnect: async () => {} }); instances.push(service);
  const response = await service.app.inject({ method: 'POST', url: notificationPaths.ALARM, remoteAddress: '10.0.0.1', payload: JSON.stringify(alarm()), headers: { 'content-type': 'application/json' } });
  expect(response.statusCode).toBe(200); expect(evidence.claim).toHaveBeenCalledOnce();
  release(true); await service.app.close();
});
it('saving an AI proposal cannot arm a disabled receiver; the explicit switch wires the real metadata gate',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});const now=new Date('2026-10-20T18:00:00Z');vi.setSystemTime(now);
 try{
  for(const armed of[false,true]){
   const f=fixtureStore(),read=vi.fn(async(installation:string,id:string)=>({savedAt:now,truncated:false,
    proposal:{enabled:true,uncertain:'analyse' as const,unmatched:'exclude' as const,zones:[0,1,2,3].map(slot=>({zoneId:`z${slot}`,enabled:slot===0}))},
    catalog:[0,1,2,3].map(slot=>({id:`v${slot}`,zoneId:`z${slot}`,revision:1,slot,channel:1,sourceInstallationId:installation,enabled:slot===0,ruleEnabled:true,name:'Synthetic',interested:true,polygon:slot===0?[{X:2000,Y:2000},{X:7000,Y:2000},{X:7000,Y:8000},{X:2000,Y:8000}]:[],observedAt:new Date(+now-10000),lastObservedAt:new Date(+now+10000),nameEffectiveAt:new Date(+now-10000)})),
    event:{id,sourceInstallationId:installation,channel:1,objects:[{id:'object',eventId:id,category:'PERSON',sourceList:'StructureInfo.ObjInfo.PersonInfoList',sourceIdentifiers:{PersonID:3},coordinateStatus:'VALID',sourceTimestamp:now,fullFrameSnapshotId:'scene',xMin:8000,xMax:9000,yMin:3000,yMax:5000}]}}));
   const finish=vi.fn(async()=>{}),service=buildReceiver({...config,AI_ENABLED:true,AI_ZONE_SELECTION_ENABLED:armed},{uniview:f.store,zoneEligibility:{read},evidence:{interrupt:async()=>{},claim:async()=>true,finish,sample:async()=>{}},checkReady:async()=>{},disconnect:async()=>{}});instances.push(service);
   const response=await service.app.inject({method:'POST',url:notificationPaths.ALARM,remoteAddress:'10.0.0.1',payload:JSON.stringify(alarm()),headers:{'content-type':'application/json'}});
   expect(response.statusCode).toBe(200);const before=structuredClone(f.state());await vi.advanceTimersByTimeAsync(1500);
   if(armed){expect(read).toHaveBeenCalledOnce();expect(finish).toHaveBeenCalledWith(response.json().eventId,'SKIPPED','zone_not_selected',expect.any(Date));}
   else{expect(read).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalledWith(response.json().eventId,'SKIPPED','zone_not_selected',expect.any(Date));}
   expect(f.state()).toEqual(before);await service.app.close();
  }
 }finally{vi.useRealTimers();}
});
