import {afterEach,expect,it,vi} from 'vitest';
import {evaluateNotifications,type NotificationEvent,type NotificationObject} from '../src/notifications/evaluate.js';
import {notificationConfiguration,notificationArchive,type NotificationRule} from '../src/notifications/contracts.js';
import {createNotificationStore} from '../src/notifications/store.js';
import type {PrismaClient} from '../src/generated/prisma/client.js';
import {loadConfig} from '../src/config.js';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,installation=id(1),zone=id(2),ruleId=id(3);
const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',UNIVIEW_INSTALLATION_ID:installation,UNIVIEW_CAMERA_MAP:'{"1":"camera_1","2":"camera_2"}'});
const rule={id:ruleId,name:'Entrance person',enabled:true,channels:[1],zoneIds:[zone],categories:['PERSON' as const],cooldownSeconds:60,ambiguous:'exclude' as const,unknown:'exclude' as const};
const configuration={deliveryEnabled:false,rules:[rule]},window={from:'2026-10-20T12:00:00.000Z',to:'2026-10-20T13:00:00.000Z'};
const object=(overrides:Partial<NotificationObject>={}):NotificationObject=>({id:id(10),category:'PERSON',status:'MATCHED',zoneIds:[zone],versionIds:[id(20)],basis:'stored_geometry_projection',reason:'anchor_consensus',...overrides});
const event=(n:number,seconds=0,objects=[object()]):NotificationEvent=>({id:id(100+n),channel:1,receivedAt:new Date(Date.parse(window.from)+seconds*1000).toISOString(),objects});
const run=(events:NotificationEvent[],rules:NotificationRule[]=configuration.rules)=>evaluateNotifications(installation,{...configuration,rules},events,window);
afterEach(()=>vi.useRealTimers());
it('deduplicates source reports and overlapping zones but never merges canonical event IDs',()=>{
 const a=event(1,0,[object(),object({id:id(11),zoneIds:[zone,id(9)]})]),b=event(2,20);
 const result=run([b,a,a,event(3,60)]);expect(result.decisions.map(d=>d.outcome)).toEqual(['would_notify','cooldown','would_notify']);expect(result.eventCount).toBe(3);expect(result.decisions[0]?.objectIds).toHaveLength(2);
 expect(result.decisions[0]?.idempotencyKey).not.toContain(ruleId);expect(result.decisions[0]?.idempotencyKey).toContain(a.id);
});
it('matches category and zone on the same object; independent multi-object matches win',()=>{
 const mixed=event(1,0,[object({zoneIds:[id(9)]}),object({id:id(12),category:'MOTOR_VEHICLE'})]);expect(run([mixed]).decisions[0]?.reason).toBe('zone_not_selected');
 mixed.objects.push(object({id:id(13)}));expect(run([mixed]).decisions[0]?.outcome).toBe('would_notify');
});
it('has explicit independent ambiguous/unknown policy, including missing source observations',()=>{
 for(const status of['AMBIGUOUS','UNKNOWN'] as const){const e=event(1,0,[object({status,zoneIds:[]})]);expect(run([e]).decisions[0]?.outcome).toBe('uncertain');const field=status==='AMBIGUOUS'?'ambiguous':'unknown';expect(run([e],[{...rule,[field]:'include'}]).decisions[0]?.outcome).toBe('would_notify');}
 expect(run([event(2,0,[])],[{...rule,unknown:'include'}]).decisions[0]?.reason).toBe('missing_source_objects');
 expect(run([{...event(3,0,[object({zoneIds:[]})]),truncated:true}]).decisions[0]?.outcome).toBe('uncertain');
});
it('does not require AI; delivery preference never makes evaluation send or suppress NVR matches',()=>{
 const skipped={...event(1),processing:{status:'SKIPPED',reason:'zone_not_selected'}};
 for(const deliveryEnabled of[false,true]){const result=evaluateNotifications(installation,{...configuration,deliveryEnabled},[skipped],window);expect(result.deliveryAvailable).toBe(false);expect(result.decisions[0]?.outcome).toBe('would_notify');}
 expect(run([event(1)],[{...rule,enabled:false}]).decisions[0]?.outcome).toBe('rule_disabled');
 expect(run([{...event(1),channel:2}]).decisions[0]?.reason).toBe('camera_not_selected');
});
it('uses fixed per-rule cooldowns and stable UTC/id tie ordering; suppressions do not extend them',()=>{
 const result=run([event(2,59),event(1),event(3,60)]);expect(result.decisions.map(d=>d.outcome)).toEqual(['would_notify','cooldown','would_notify']);expect(result.decisions[1]?.cooldownUntil).toBe('2026-10-20T12:01:00.000Z');
 expect(run([event(2),event(1)],[{...rule,cooldownSeconds:0}]).decisions.map(d=>d.outcome)).toEqual(['would_notify','would_notify']);
 const other={...rule,id:id(4)};expect(run([event(1)],[rule,other]).decisions.map(d=>d.idempotencyKey)).toEqual([`notification:v1:${installation}:${event(1).id}`,`notification:v1:${installation}:${event(1).id}`]);
});
it('rejects unsupported AI categories, duplicate IDs and invalid preview/cooldown windows',()=>{
 expect(notificationConfiguration.safeParse({...configuration,rules:[{...rule,categories:['car']}]}).success).toBe(false);
 expect(notificationConfiguration.safeParse({...configuration,rules:[rule,rule]}).success).toBe(false);
 expect(notificationConfiguration.safeParse({...configuration,rules:[{...rule,cooldownSeconds:-1}]}).success).toBe(false);
 expect(notificationArchive.safeParse({...window,to:window.from,expectedRevision:1,fingerprint:'a'.repeat(64)}).success).toBe(false);
});
function fixture(){
 let saved:{revision:number;configuration:unknown;updatedAt:Date}|null={revision:1,configuration,updatedAt:new Date(window.from)};
 const zones=[0,1,2,3].map(slot=>({id:slot===0?zone:id(30+slot),sourceInstallationId:installation,channel:1,slot,displayName:'Slot '+slot,preference:null}));
 const versions=zones.map(z=>({id:id(40+z.slot),zoneId:z.id,revision:2,zone:z,enabled:z.slot<2,ruleEnabled:z.slot<2,polygon:z.slot===0?[{X:100,Y:100},{X:4800,Y:100},{X:4800,Y:9900},{X:100,Y:9900}]:z.slot===1?[{X:5200,Y:100},{X:9900,Y:100},{X:9900,Y:9900},{X:5200,Y:9900}]:[],observedAt:new Date('2026-10-20T00:00:00Z'),lastObservedAt:new Date('2026-10-20T23:00:00Z'),nameEffectiveAt:new Date('2026-10-20T00:00:00Z'),displayName:'Slot '+z.slot}));
 const row={id:event(1).id,nvrChannel:1,firstReceivedAt:new Date(window.from),objects:[{id:id(10),category:'PERSON',coordinateStatus:'VALID',sourceTimestamp:new Date(window.from),xMin:1000,yMin:3000,xMax:2000,yMax:4000,fullFrameSnapshotId:id(70),memberships:[] as {zoneVersionId:string;relationship:string}[]}]};
 const archive=vi.fn(async(a:{create:unknown})=>({id:id(80),...a.create as object,createdAt:new Date(window.from)})),upsert=vi.fn(async(a:{create:{configuration:unknown}})=>{saved={revision:(saved?.revision??0)+1,configuration:a.create.configuration,updatedAt:new Date()};});
 const tx={univiewZone:{findMany:vi.fn(async()=>zones)},univiewZoneVersion:{findMany:vi.fn(async()=>versions)},cameraConfiguration:{findMany:async()=>[]},notificationConfiguration:{findUnique:vi.fn(async()=>saved),upsert},notificationEvaluation:{findMany:async()=>[],findFirst:vi.fn(async()=>null),upsert:archive},securityEvent:{findMany:vi.fn(async()=>[row])}};
 const prisma={...tx,$transaction:async<T>(fn:(t:typeof tx)=>Promise<T>)=>fn(tx)} as unknown as PrismaClient;
 return {store:createNotificationStore(prisma,config),tx,row,versions,archive,upsert,setSaved:(v:typeof saved)=>{saved=v;}};
}
it('reads actual stored source metadata without AI/NVR or source writes; preview is repeatable and read-only',async()=>{
 const f=fixture(),a=await f.store.preview(installation,window),b=await f.store.preview(installation,window);expect(a).toEqual(b);expect(a).toMatchObject({eventCount:1,decisions:[{outcome:'would_notify'}]});expect(f.archive).not.toHaveBeenCalled();expect(f.upsert).not.toHaveBeenCalled();
 expect(f.tx.securityEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{sourceInstallationId:installation,firstReceivedAt:{gte:new Date(window.from),lt:new Date(window.to)}},take:1001}));
 expect(JSON.stringify(f.tx.securityEvent.findMany.mock.calls)).not.toMatch(/analysis|processing|subjects/);
});
it('reuses stored memberships only with correct historical versions, preserving uncertain gaps',async()=>{
 const f=fixture();f.row.objects[0]!.memberships=f.versions.slice(0,2).map(v=>({zoneVersionId:v.id,relationship:v.zone.slot===0?'WITHIN':'OUTSIDE'}));
 expect(await f.store.preview(installation,window)).toMatchObject({decisions:[{outcome:'would_notify'}],objects:[{objects:[{basis:'stored_membership'}]}]});
 f.row.objects[0]!.memberships[0]!.zoneVersionId=id(999);expect(await f.store.preview(installation,window)).toMatchObject({decisions:[{outcome:'uncertain'}]});
 f.versions.forEach(v=>{v.lastObservedAt=new Date('2026-10-20T10:00:00Z')});expect(await f.store.preview(installation,window)).toMatchObject({objects:[{objects:[{status:'UNKNOWN',reason:'missing_or_conflicting_historical_configuration'}]}]});
});
it('archives explicit snapshots idempotently, rejects changed previews and leaves preview read-only',async()=>{
 const f=fixture(),result=await f.store.preview(installation,window) as {fingerprint:string;revision:number};await f.store.archive!(installation,window,result.revision,result.fingerprint);await f.store.archive!(installation,window,result.revision,result.fingerprint);
 expect(f.archive).toHaveBeenCalledTimes(2);expect(f.archive.mock.calls[0]?.[0]).toMatchObject({where:{sourceInstallationId_fingerprint:{sourceInstallationId:installation,fingerprint:result.fingerprint}},update:{}});
 await expect(f.store.archive!(installation,window,2,result.fingerprint)).rejects.toThrow('Preview changed');expect(f.archive).toHaveBeenCalledTimes(2);
});
it('saves with optimistic revisions, no unchanged writes, and rejects foreign/cross-camera zones',async()=>{
 const f=fixture();await f.store.save!(installation,1,configuration);expect(f.upsert).not.toHaveBeenCalled();
 await expect(f.store.save!(installation,0,configuration)).rejects.toThrow('Settings changed');
 await expect(f.store.save!(installation,1,{...configuration,rules:[{...rule,zoneIds:[id(999)]}]})).rejects.toThrow('Review camera');
 await expect(f.store.save!(installation,1,{...configuration,rules:[{...rule,channels:[1,2]}]})).rejects.toThrow('Review camera');
 await f.store.save!(installation,1,{...configuration,deliveryEnabled:true});expect(f.upsert).toHaveBeenCalledOnce();
});
it('defaults OFF and scopes saved evaluation reads to the installation',async()=>{
 const f=fixture();f.setSaved(null);expect(await f.store.read(installation)).toMatchObject({revision:0,configuration:{deliveryEnabled:false,rules:[]},deliveryAvailable:false});
 await f.store.evaluation(installation,id(80));expect(f.tx.notificationEvaluation.findFirst).toHaveBeenCalledWith({where:{id:id(80),sourceInstallationId:installation,kind:'PREVIEW'},select:{result:true}});
});
it('fails explicitly instead of silently truncating a high-volume preview',async()=>{
 const f=fixture();f.tx.securityEvent.findMany.mockResolvedValueOnce(Array.from({length:1001},()=>f.row));await expect(f.store.preview(installation,window)).rejects.toThrow('1,000 events');
});
it('keeps stored overlaps uncertain and selects historical versions by original source time',async()=>{
 const f=fixture();const original=await f.store.preview(installation,window) as {decisions:unknown};expect(original.decisions).toMatchObject([{outcome:'would_notify'}]);
 const next=f.versions.map(v=>({...v,id:id(200+v.zone.slot),revision:3,observedAt:new Date('2026-10-20T14:00:00Z'),polygon:v.zone.slot===0?f.versions[1]!.polygon:v.polygon}));f.versions.forEach(v=>{v.lastObservedAt=new Date('2026-10-20T13:00:00Z')});f.versions.push(...next);
 expect(await f.store.preview(installation,window)).toMatchObject({decisions:[{outcome:'would_notify',zoneVersionIds:[id(40),id(41),id(42),id(43)]}]});
 f.row.firstReceivedAt=new Date('2026-10-20T15:00:00Z');f.row.objects[0]!.sourceTimestamp=new Date('2026-10-20T15:00:00Z');expect(await f.store.preview(installation,{from:'2026-10-20T15:00:00Z',to:'2026-10-20T16:00:00Z'})).toMatchObject({decisions:[{outcome:'unmatched'}]});
 const overlap=fixture(),o=overlap.row.objects[0]!;o.xMin=4500;o.xMax=5500;o.memberships=overlap.versions.slice(0,2).map(v=>({zoneVersionId:v.id,relationship:'INTERSECTS'}));expect(await overlap.store.preview(installation,window)).toMatchObject({objects:[{objects:[{status:'AMBIGUOUS',basis:'stored_membership'}]}],decisions:[{outcome:'uncertain'}]});
});
it('reports the pending schema without creating defaults or touching historical records',async()=>{
 const f=fixture();f.tx.notificationConfiguration.findUnique.mockRejectedValueOnce({code:'P2021'});expect(await f.store.read(installation)).toMatchObject({available:false,configuration:{deliveryEnabled:false,rules:[]}});expect(f.upsert).not.toHaveBeenCalled();expect(f.archive).not.toHaveBeenCalled();
});
it('uses the person ground point in overlapping zones without requiring the whole rectangle within either zone',async()=>{
 const f=fixture();f.versions[1]!.polygon=[{X:1500,Y:100},{X:9900,Y:100},{X:9900,Y:9900},{X:1500,Y:9900}];f.row.objects[0]!.memberships=f.versions.slice(0,2).map(v=>({zoneVersionId:v.id,relationship:v.zone.slot===0?'WITHIN':'INTERSECTS'}));
 expect(await f.store.preview(installation,window)).toMatchObject({decisions:[{outcome:'would_notify'}],objects:[{objects:[{status:'MATCHED',reliableZoneIds:[zone,f.versions[1]!.zoneId]}]}]});
 f.setSaved({revision:2,updatedAt:new Date(),configuration:{...configuration,rules:[{...rule,zoneIds:[f.versions[1]!.zoneId]}]}});expect(await f.store.preview(installation,window)).toMatchObject({decisions:[{outcome:'would_notify'}]});
});
