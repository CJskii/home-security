import {afterEach,expect,it,vi} from 'vitest';
import type {Database} from '../src/database.js';
import {homeAssistantZoneHistory,haZoneQuery,HA_ZONE_PAGE} from '../src/dashboard/ha-zone-history.js';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {verifyMedia} from '../src/notifications/media.js';
const installation='11111111-1111-4111-8111-111111111111',zone='22222222-2222-4222-8222-222222222222',event='33333333-3333-4333-8333-333333333333',object='44444444-4444-4444-8444-444444444444',crop='55555555-5555-4555-8555-555555555555',frame='66666666-6666-4666-8666-666666666666';
const now=new Date('2026-10-22T10:00:00Z'),media={key:'ab'.repeat(32),origin:'http://192.168.50.10:3000'};
function fixture(channel=1){
 const row={id:event,eventTime:now,nvrChannel:channel,categories:['person','motor_vehicle'],processing:{status:'SKIPPED',reason:'capacity_exceeded'},analysis:{shortDescription:'Unrelated vehicle scene'},objects:[{id:object,category:'PERSON',cropSnapshotId:crop,fullFrameSnapshotId:frame,location:{status:'MATCHED',matches:[{zoneId:zone,name:'My Driveway',interested:true}]}}],snapshots:[{id:crop,eventId:event,imageType:'2',origin:'NVR_PUSH'},{id:frame,eventId:event,imageType:'1',origin:'NVR_PUSH'}]};
 const db:Database={checkReady:vi.fn(),disconnect:vi.fn(),events:{history:vi.fn(async()=>[row]),get:vi.fn(),snapshots:vi.fn(),notifications:vi.fn()},zoneActivity:vi.fn(async()=>[{zoneId:zone,channel,slot:0,name:channel===1?'My Driveway':'My Walkway',enabled:true,versionId:zone,lastActivityAt:now.toISOString(),basis:'observed_configuration_bracket' as const,stale:false}]),notifications:{read:vi.fn(),evaluation:vi.fn(),preview:vi.fn(),history:vi.fn(async()=>({available:true,producerEnabled:true,deliveryEnabled:true,nextCursor:null,items:[]}))}};
 return {db,row};
}
it('queries a full seven-day zone cohort before pagination, including AI-skipped and unnotified detections',async()=>{
 const {db}=fixture();const r=await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),media,now);
 expect(db.events!.history).toHaveBeenCalledWith(expect.objectContaining({sourceInstallationId:installation,nvrChannel:1,locationZoneId:zone,occurredAfter:new Date('2026-10-15T10:00:00Z'),occurredBefore:now,limit:24}));
 expect(r.items[0]).toMatchObject({eventId:event,category:'Person',description:'Person detected',camera:'Driveway',notification:'No notification recorded'});expect(r.items[0]?.time).toContain('11:00:00 BST');expect(db.notifications!.preview).not.toHaveBeenCalled();
});
it('signs only the exact qualifying object crop and full frame without retrieving any image',async()=>{
 const {db,row}=fixture();row.objects.unshift({...row.objects[0]!,id:event,category:'MOTOR_VEHICLE',cropSnapshotId:event,location:{status:'MATCHED',matches:[{zoneId:installation,name:'Road',interested:false}]}});
 const r=await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),media,now),i=r.items[0]!;
 expect(verifyMedia(media,new URL(i.thumbnail!).searchParams.get('token')!,event,crop,now.getTime())).toBe(true);
 expect(verifyMedia(media,new URL(i.fullFrame!).searchParams.get('token')!,event,frame,now.getTime())).toBe(true);
 expect(verifyMedia(media,new URL(i.thumbnail!).searchParams.get('token')!,installation,crop,now.getTime())).toBe(false);expect(db.events!.get).not.toHaveBeenCalled();
});
it('batch-loads persisted notification outcomes by exact event IDs before the ledger page limit',async()=>{
 const {db}=fixture();const r=await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),undefined,now);expect(db.notifications!.history).toHaveBeenCalledWith(installation,undefined,false,[event]);expect(r.items[0]!.thumbnail).toBeNull();
 const {notificationHistory}=await import('../src/notifications/history.js');const findMany=vi.fn(async()=>[]),tx={notificationConfiguration:{findUnique:vi.fn(async()=>null)},notificationEvaluation:{findMany}};const prisma={$transaction:vi.fn(async(fn:(v:typeof tx)=>Promise<unknown>)=>fn(tx))};await notificationHistory(prisma as unknown as Parameters<typeof notificationHistory>[0],installation,undefined,false,[event]);expect(findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({kind:'LIVE',sourceInstallationId:installation,eventId:{in:[event]}})}));
});
it('preserves a fixed window and advances a stable canonical cursor without touching historical records',async()=>{
 const {db,row}=fixture();db.events!.history=vi.fn(async()=>Array.from({length:HA_ZONE_PAGE+1},()=>row));const r=await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),undefined,now);expect(r.items).toHaveLength(24);expect(r.nextCursor).toBeTruthy();await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone,until:r.until,cursor:r.nextCursor!}),undefined,new Date(now.getTime()+10000));expect(db.events!.history).toHaveBeenLastCalledWith(expect.objectContaining({occurredBefore:now,cursor:{id:event,eventTime:now}}));
});
it('does not promote boundary/unknown matches or use an unrelated crop as a fallback',async()=>{
 const {db,row}=fixture();row.objects[0]!.location.status='AMBIGUOUS';expect((await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),media,now)).items).toEqual([]);
 row.objects[0]!.location.status='MATCHED';row.objects[0]!.cropSnapshotId=installation;const r=await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),media,now);expect(r.items[0]!.thumbnail).toBeNull();
});
it('handles Camera 2 and retained historical membership, independently of current enablement or interest',async()=>{
 const {db}=fixture(2);expect((await homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone}),undefined,now)).items[0]!.camera).toBe('Side Walkway');expect(db.events!.history).toHaveBeenCalledWith(expect.objectContaining({nvrChannel:2,locationZoneId:zone}));
});
it('rejects unknown installations/zones, stale windows and malformed cursors',async()=>{
 const {db}=fixture();await expect(homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:event}),undefined,now)).rejects.toThrow();await expect(homeAssistantZoneHistory(db,installation,haZoneQuery.parse({zoneId:zone,until:'2026-10-22T12:00:00Z'}),undefined,now)).rejects.toThrow('Refresh');expect(haZoneQuery.safeParse({zoneId:zone,cursor:'invalid'}).success).toBe(false);
});
const apps:ReturnType<typeof buildApp>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(s=>s.app.close()))});
it('allows only authenticated read history with bounded parameters; the HA token still cannot read general APIs or write',async()=>{
 const {db}=fixture();const service=buildApp(loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',LOG_LEVEL:'silent',UNIVIEW_INSTALLATION_ID:installation,HA_HISTORY_TOKEN:'h'.repeat(32)}),db);apps.push(service);const headers={authorization:'Bearer '+'h'.repeat(32)},url='/api/dashboard/home-assistant/zone-history?zoneId='+zone;
 expect((await service.app.inject(url)).statusCode).toBe(401);expect((await service.app.inject({url,headers})).statusCode).toBe(200);expect((await service.app.inject({url:url+'&limit=10000',headers})).statusCode).toBe(400);expect((await service.app.inject({url:'/api/events',headers})).statusCode).toBe(401);expect((await service.app.inject({url,headers,method:'POST'})).statusCode).toBe(404);
});

it('reads an exact seven-day event and signs its original frame without requiring confirmed zone membership',async()=>{
 const {homeAssistantEvent}=await import('../src/dashboard/ha-zone-history.js');const {db,row}=fixture();Object.assign(row,{sourceInstallationId:installation});row.objects[0]!.location.status='AMBIGUOUS';db.events!.get=vi.fn(async()=>row);
 const r=await homeAssistantEvent(db,installation,event,media,now);expect(r).toMatchObject({eventId:event,zone:'Boundary uncertain',category:'Person'});expect(r.fullFrame).toContain(frame);expect(db.events!.history).not.toHaveBeenCalled();
 await expect(homeAssistantEvent(db,zone,event,media,now)).rejects.toThrow();row.eventTime=new Date(+now-8*86400000);await expect(homeAssistantEvent(db,installation,event,media,now)).rejects.toThrow();
});
it('scopes exact event reads with the HA token and rejects arbitrary filters, foreign events and writes',async()=>{
 const {db,row}=fixture();Object.assign(row,{sourceInstallationId:installation,eventTime:new Date()});db.events!.get=vi.fn(async()=>row);const service=buildApp(loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',LOG_LEVEL:'silent',UNIVIEW_INSTALLATION_ID:installation,HA_HISTORY_TOKEN:'h'.repeat(32)}),db);apps.push(service);const headers={authorization:'Bearer '+'h'.repeat(32)},url='/api/dashboard/home-assistant/event?eventId='+event;
 expect((await service.app.inject(url)).statusCode).toBe(401);expect((await service.app.inject({url,headers})).statusCode).toBe(200);expect((await service.app.inject({url:url+'&imageId='+frame,headers})).statusCode).toBe(400);expect((await service.app.inject({url,headers,method:'POST'})).statusCode).toBe(404);Object.assign(row,{sourceInstallationId:zone});expect((await service.app.inject({url,headers})).statusCode).toBe(404);
});
