import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createNvrApi, MEDIA_WORK_LIMITS } from '../src/events/nvr-service.js';
import { buildApp } from '../src/app.js';
import type { HistoricalImageStore, ResolutionEvent, ResolutionSnapshot } from '../src/uniview/historical-image-resolution.js';
import { UniviewClientError, type HistoricalPictureReference, type UniviewClient } from '../src/uniview/snapshot-client.js';
import { config, jpeg } from './uniview-fixtures.js';
const eventId='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb', fullId='27b01e57-cc3d-4db5-9bdd-f7d89e8149bb', cropId='37b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const settings={...config,EVENTS_TOKEN:'e'.repeat(32),UNIVIEW_USERNAME:'test',UNIVIEW_PASSWORD:'secret'};
const authorization='Bearer '+'e'.repeat(32), time=new Date('2026-10-14T12:00:00Z');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function setup(resolved=true) {
 const images=new Map([['full',Buffer.from(jpeg)],['crop',Buffer.from(jpeg)]]);images.get('crop')![26]=17;
 const snapshot=(id:string,type:1|2,name:string,index:number):ResolutionSnapshot=>({id,eventId,notificationId:fullId,origin:'NVR_PUSH',status:'RECEIVED',imageType:String(type),sha256:hash(images.get(name)!),sourceImageIndex:index,capturedAt:time,
   nvrPictureName:resolved?name:null,nvrPictureSize:resolved?images.get(name)!.length:null,nvrPictureType:resolved?type:null,nvrRecordId:resolved?'record':null,referenceStatus:resolved?'VERIFIED':'UNRESOLVED',referenceVersion:0,referenceResolvedAt:resolved?time:null});
 const event:ResolutionEvent={id:eventId,sourceInstallationId:settings.UNIVIEW_INSTALLATION_ID!,nvrChannel:1,alarmType:'EnterArea',
   snapshots:[snapshot(fullId,1,'full',1),snapshot(cropId,2,'crop',2)],notifications:[{id:fullId,eventId,reportedAt:time,metadata:{StructureInfo:{ObjInfo:{PersonInfoList:[{PersonID:12,LargePicAttachIndex:1,SmallPicAttachIndex:2}]}}}}]};
 const save=vi.fn<HistoricalImageStore['save']>(async(_installation,original,update)=>{
   const row=event.snapshots.find((s)=>s.id===original.id)!;if(row.referenceVersion!==original.referenceVersion)return false;
   row.referenceVersion++;row.referenceStatus=update.status;
   if(update.reference)Object.assign(row,{nvrPictureName:update.reference.picture.Name,nvrPictureSize:update.reference.picture.Size,nvrPictureType:update.reference.picture.Type,nvrRecordId:update.reference.recordId,referenceResolvedAt:update.checkedAt});
   return true;
 });
 const store:HistoricalImageStore={load:vi.fn(async()=>structuredClone(event)),save};
 const historicalPicture=vi.fn(async(picture:HistoricalPictureReference,signal?:AbortSignal)=>{signal?.throwIfAborted();return Buffer.concat([images.get(picture.Name)!,Buffer.from([0,0])]);});
 const searchObjects=vi.fn(async()=>[{RecordID:'record',Type:2,Time:time.getTime()/1000,ChannelID:1,FullPicture:{Name:'full',Size:images.get('full')!.length},ObjectList:[{ObjectID:999,ObjectPicture:{Name:'crop',Size:images.get('crop')!.length},ObjectInfo:{ObjectType:2,PersonInfo:{PersonID:3000}}}]}]);
 const database={historicalImages:store,projectObjects:vi.fn(async()=>({notifications:1,inserted:0})),zoneEnrichment:{load:vi.fn(async()=>({id:eventId,sourceInstallationId:settings.UNIVIEW_INSTALLATION_ID!,nvrChannel:1,alarmType:'EnterArea',objects:[]})),versions:vi.fn(async()=>[]),save:vi.fn(async()=>true)},checkReady:async()=>{},disconnect:vi.fn(async()=>{})};
 const client={historicalPicture,searchObjects} as unknown as UniviewClient;
 const api=createNvrApi(settings,database,client)!;
 return {event,images,store,save,historicalPicture,searchObjects,database,api};
}
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map((s)=>s.app.close()));});
it('serves exact normalized original bytes using verified references without a Smart Search',async()=>{
 const f=setup();const originalHash=f.event.snapshots[1]!.sha256;
 const result=await f.api.image(eventId,cropId);expect(result).toEqual(f.images.get('crop'));expect(hash(result)).toBe(originalHash);
 expect(f.searchObjects).not.toHaveBeenCalled();expect(f.historicalPicture).toHaveBeenCalledOnce();expect(f.event.snapshots[1]!.sha256).toBe(originalHash);await f.api.close();
});
it('resolves only the requested image, leaves sibling references untouched, and reuses it later',async()=>{
 const f=setup(false);expect(await f.api.image(eventId,cropId)).toEqual(f.images.get('crop'));
 expect(f.event.snapshots[1]!.referenceStatus).toBe('VERIFIED');expect(f.event.snapshots[0]!.referenceStatus).toBe('UNRESOLVED');
 const count=f.searchObjects.mock.calls.length;await f.api.image(eventId,cropId);expect(f.searchObjects).toHaveBeenCalledTimes(count);await f.api.close();
});
it('never returns a mismatched candidate and preserves the original source hash',async()=>{
 const f=setup();const original=f.event.snapshots[1]!.sha256;f.historicalPicture.mockResolvedValue(f.images.get('full')!);
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:502,availability:'INTEGRITY_MISMATCH'});
 expect(f.event.snapshots[1]!.sha256).toBe(original);expect(f.event.snapshots[1]!.referenceStatus).toBe('INTEGRITY_MISMATCH');await f.api.close();
});
it('checks foreign image/installation ownership before NVR requests',async()=>{
 const f=setup();await expect(f.api.image(eventId,randomUUID())).rejects.toMatchObject({status:404});
 f.event.sourceInstallationId=randomUUID();await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:404});
 expect(f.historicalPicture).not.toHaveBeenCalled();expect(f.searchObjects).not.toHaveBeenCalled();await f.api.close();
});
it('rejects live/failed/unhashed substitutes instead of manufacturing historical originals',async()=>{
 const f=setup();f.event.snapshots[1]!.origin='NVR_LIVE';await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:404});
 f.event.snapshots[1]!.origin='NVR_PUSH';f.event.snapshots[1]!.sha256=null;f.event.snapshots[1]!.status='FAILED';
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:422,availability:'UNRESOLVED'});expect(f.historicalPicture).not.toHaveBeenCalled();await f.api.close();
});
it('records temporary NVR failure without deleting last verified references or widening searches',async()=>{
 const f=setup();f.historicalPicture.mockRejectedValue(new UniviewClientError('authentication'));
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:503,availability:'TEMPORARILY_UNAVAILABLE'});
 expect(f.event.snapshots[1]!).toMatchObject({nvrPictureName:'crop',referenceStatus:'TEMPORARILY_UNAVAILABLE'});expect(f.searchObjects).not.toHaveBeenCalled();await f.api.close();
});
it('not-found is provisional and never claims permanent expiry',async()=>{
 const f=setup();f.historicalPicture.mockRejectedValue(new UniviewClientError('unavailable',undefined,404));f.searchObjects.mockResolvedValue([]);
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:404,availability:'NOT_FOUND'});expect(f.event.snapshots[1]!.referenceStatus).toBe('NOT_FOUND');await f.api.close();
});
it('queues bounded parallel media requests and cleanly aborts active and waiting work on shutdown',async()=>{
 const f=setup();f.historicalPicture.mockImplementation((_picture,signal)=>new Promise((_resolve,reject)=>{signal?.addEventListener('abort',()=>reject(new UniviewClientError('aborted')),{once:true});}));
 const pending=[f.api.image(eventId,cropId),f.api.image(eventId,fullId),...Array.from({length:MEDIA_WORK_LIMITS.queued},()=>f.api.image(eventId,randomUUID()))];
 const settled=Promise.allSettled(pending);
 await vi.waitFor(()=>expect(f.historicalPicture).toHaveBeenCalledTimes(2));
 await expect(f.api.image(eventId,randomUUID())).rejects.toMatchObject({status:503,code:'NVR_BUSY'});
 await f.api.close();expect((await settled).every((r)=>r.status==='rejected')).toBe(true);
 expect(f.historicalPicture).toHaveBeenCalledTimes(2);
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:503});
});
it('explicit enrichment projects historical objects, resolves references, enriches zones and does not invoke AI',async()=>{
 const f=setup(false);const result=await f.api.enrich(eventId) as {projection:{inserted:number};images:{snapshots:{status:string}[]};zones:unknown;aiInvoked:boolean};
 expect(result.projection.inserted).toBe(0);expect(result.images.snapshots.every((s)=>s.status==='VERIFIED')).toBe(true);expect(result.zones).toEqual([]);expect(result.aiInvoked).toBe(false);
 expect(f.database.projectObjects).toHaveBeenCalledWith(eventId,settings.UNIVIEW_INSTALLATION_ID,expect.any(AbortSignal));await f.api.close();
});
it('HTTP media is bearer-authenticated, no-store JPEG and validates UUIDs/query allowlists',async()=>{
 const f=setup();const service=buildApp(settings,f.database,undefined,f.api);apps.push(service);const url=`/api/events/${eventId}/images/${cropId}`;
 expect((await service.app.inject(url)).statusCode).toBe(401);expect(f.historicalPicture).not.toHaveBeenCalled();
 expect((await service.app.inject({url:url+'?url=http://internal/',headers:{authorization}})).statusCode).toBe(400);
 expect((await service.app.inject({url:'/api/events/not-uuid/images/'+cropId,headers:{authorization}})).statusCode).toBe(400);
 const response=await service.app.inject({url,headers:{authorization}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('image/jpeg');expect(response.headers['cache-control']).toBe('no-store');expect(response.rawPayload).toEqual(f.images.get('crop'));
});
it('HTTP failures expose only safe availability codes and never credentials or backend errors',async()=>{
 const f=setup();f.historicalPicture.mockRejectedValue(new Error('rtsp://secret:password@internal'));
 const service=buildApp(settings,f.database,undefined,f.api);apps.push(service);
 const response=await service.app.inject({url:`/api/events/${eventId}/images/${cropId}`,headers:{authorization}});
 expect(response.statusCode).toBe(503);expect(response.json().availability).toEqual({state:'TEMPORARILY_UNAVAILABLE',permanentExpiryConfirmed:false});expect(response.headers['retry-after']).toBe('2');expect(response.body).not.toMatch(/secret|password|rtsp/);
});
it('unconfigured NVR does not prevent metadata API/authentication startup',async()=>{
 expect(createNvrApi({...settings,UNIVIEW_USERNAME:undefined},{checkReady:async()=>{},disconnect:async()=>{}})).toBeUndefined();
 const service=buildApp({...settings,UNIVIEW_USERNAME:undefined},{checkReady:async()=>{},disconnect:async()=>{}});apps.push(service);
 const response=await service.app.inject({url:`/api/events/${eventId}/images/${cropId}`,headers:{authorization}});expect(response.statusCode).toBe(503);expect(response.json().code).toBe('NVR_NOT_CONFIGURED');
});

it('serializes simultaneous cold resolutions and returns the already verified crop without a second download',async()=>{
 const f=setup(false);let active=0,peak=0;
 const search=f.searchObjects.getMockImplementation()!;
 f.searchObjects.mockImplementation(async()=>{active++;peak=Math.max(active,peak);try{await new Promise(r=>setTimeout(r,5));return await search();}finally{active--;}});
 const [crop,full]=await Promise.all([f.api.image(eventId,cropId),f.api.image(eventId,fullId)]);
 expect(crop).toEqual(f.images.get('crop'));expect(full).toEqual(f.images.get('full'));expect(peak).toBe(1);
 expect(f.historicalPicture.mock.calls.filter(([p])=>p.Name==='crop')).toHaveLength(1);
 expect(f.historicalPicture).toHaveBeenCalledTimes(3); // crop+associated scene, then requested full frame
 expect(f.save).toHaveBeenCalledTimes(2);await f.api.close();
});
it('fills thirty distinct cold gallery images without resolver-busy rejections',async()=>{
 const f=setup(false),events=new Map<string,ResolutionEvent>();
 for(let i=0;i<30;i++){const e=structuredClone(f.event);e.id=randomUUID();e.snapshots.forEach(s=>{s.eventId=e.id;});e.notifications.forEach(n=>{n.eventId=e.id;});events.set(e.id,e);}
 f.store.load=vi.fn(async id=>structuredClone(events.get(id)??null));
 f.save.mockImplementation(async(_installation,s,u)=>{const row=events.get(s.eventId)!.snapshots.find(x=>x.id===s.id)!;if(row.referenceVersion!==s.referenceVersion)return false;row.referenceVersion++;row.referenceStatus=u.status;if(u.reference)Object.assign(row,{nvrPictureName:u.reference.picture.Name,nvrPictureSize:u.reference.picture.Size,nvrPictureType:u.reference.picture.Type,referenceResolvedAt:u.checkedAt});return true;});
 const bytes=await Promise.all([...events.keys()].map(id=>f.api.image(id,cropId)));
 expect(bytes).toHaveLength(30);expect(bytes.every(b=>b.equals(f.images.get('crop')!))).toBe(true);
 expect(f.searchObjects).toHaveBeenCalledTimes(30);expect(f.historicalPicture).toHaveBeenCalledTimes(60);await f.api.close();
});
it('deduplicates in-flight images across consumers, without retaining server-side image bytes after completion',async()=>{
 const f=setup();const bytes=await Promise.all(Array.from({length:12},()=>f.api.image(eventId,cropId)));
 expect(bytes.every(b=>b.equals(f.images.get('crop')!))).toBe(true);expect(f.historicalPicture).toHaveBeenCalledOnce();expect(f.save).not.toHaveBeenCalled();
 await f.api.image(eventId,cropId);expect(f.historicalPicture).toHaveBeenCalledTimes(2);expect(f.save).not.toHaveBeenCalled();await f.api.close();
});
it('keeps a shared download running when only one viewer cancels',async()=>{
 const f=setup(),controller=new AbortController();let finish!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;});
 f.historicalPicture.mockImplementation(async(_picture,signal)=>{await gate;signal?.throwIfAborted();return f.images.get('crop')!;});
 const cancelled=f.api.image(eventId,cropId,controller.signal);const cancelledResult=Promise.allSettled([cancelled]);
 const retained=f.api.image(eventId,cropId);await vi.waitFor(()=>expect(f.historicalPicture).toHaveBeenCalledOnce());
 controller.abort();expect((await cancelledResult)[0]!.status).toBe('rejected');finish();
 expect(await retained).toEqual(f.images.get('crop'));expect(f.historicalPicture).toHaveBeenCalledOnce();await f.api.close();
});
it('does not return a matching crop if its associated scene fails verification',async()=>{
 const f=setup(false);f.historicalPicture.mockImplementation(async p=>f.images.get(p.Name==='full'?'crop':p.Name)!);
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:502,code:'IMAGE_INTEGRITY_MISMATCH'});await f.api.close();
});
it('does not reuse captured bytes if reference persistence loses a concurrent update',async()=>{
 const f=setup(false);f.save.mockResolvedValue(false);
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:503});await f.api.close();
});
it('releases failed in-flight entries so a later request can recover',async()=>{
 const f=setup();f.historicalPicture.mockRejectedValueOnce(new UniviewClientError('unavailable'));
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({status:503});
 expect(await f.api.image(eventId,cropId)).toEqual(f.images.get('crop'));
 expect(f.event.snapshots[1]!.referenceStatus).toBe('VERIFIED');await f.api.close();
});

it('cancels the last viewer without poisoning the reference and lets the same image retry',async()=>{
 const f=setup(),controller=new AbortController();
 f.historicalPicture.mockImplementation((_picture,signal)=>new Promise((_resolve,reject)=>{signal?.addEventListener('abort',()=>reject(new UniviewClientError('aborted')),{once:true});}));
 const pending=f.api.image(eventId,cropId,controller.signal);const result=Promise.allSettled([pending]);
 await vi.waitFor(()=>expect(f.historicalPicture).toHaveBeenCalledOnce());controller.abort();await result;
 f.historicalPicture.mockImplementation(async p=>f.images.get(p.Name)!);
 expect(await f.api.image(eventId,cropId)).toEqual(f.images.get('crop'));expect(f.save).not.toHaveBeenCalled();await f.api.close();
});
it('removes cancelled queued requests before they can touch the store or NVR',async()=>{
 const f=setup();let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
 const download=f.historicalPicture.getMockImplementation()!;
 f.historicalPicture.mockImplementation(async(p,s)=>{await gate;return download(p,s);});
 const active=[f.api.image(eventId,cropId),f.api.image(eventId,fullId)];
 await vi.waitFor(()=>expect(f.historicalPicture).toHaveBeenCalledTimes(2));
 const controller=new AbortController(),queuedId=randomUUID();const queued=Promise.allSettled([f.api.image(eventId,queuedId,controller.signal)]);
 controller.abort();await queued;finish();await Promise.all(active);
 expect(f.store.load).toHaveBeenCalledTimes(2);expect(f.historicalPicture).toHaveBeenCalledTimes(2);await f.api.close();
});
it('serializes explicit enrichment with a cold image resolution using the same Smart Search owner',async()=>{
 const f=setup(false);
 const [bytes,extra]=await Promise.all([f.api.image(eventId,cropId),f.api.enrich(eventId)]);
 expect(bytes).toEqual(f.images.get('crop'));expect(extra).toMatchObject({aiInvoked:false});await f.api.close();
});

it('bounds the number of viewers sharing one in-flight image',async()=>{
 const f=setup();let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
 f.historicalPicture.mockImplementation(async()=>{await gate;return f.images.get('crop')!;});
 const viewers=Array.from({length:MEDIA_WORK_LIMITS.consumers},()=>f.api.image(eventId,cropId));
 await expect(f.api.image(eventId,cropId)).rejects.toMatchObject({code:'NVR_BUSY'});
 finish();expect(await Promise.all(viewers)).toHaveLength(MEDIA_WORK_LIMITS.consumers);expect(f.historicalPicture).toHaveBeenCalledOnce();await f.api.close();
});
