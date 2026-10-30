import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { homeAssistantHistory, markdownText } from '../src/dashboard/home-assistant.js';
import { verifyMedia } from '../src/notifications/media.js';
import type { DeliveryHistory } from '../src/notifications/history.js';
const id='11111111-1111-4111-8111-111111111111', image='22222222-2222-4222-8222-222222222222', now=new Date('2026-10-21T18:45:00Z');
const media={key:'ab'.repeat(32),origin:'http://192.168.50.10:3000'};
const ledger:DeliveryHistory={available:true,producerEnabled:true,deliveryEnabled:true,nextCursor:null,items:[]};
function fixture() {
  const row={id,sourceInstallationId:id,nvrChannel:1,camera:'Driveway',occurredAt:now,eventTime:now,processing:{status:'SKIPPED',reason:'capacity_exceeded'},categories:['PERSON'],objects:[{id:image,category:'PERSON',cropSnapshotId:image,location:{status:'MATCHED',matches:[{name:'My Driveway'}]}}],snapshots:[{id:image,eventId:id,origin:'NVR_PUSH',imageType:'2'}]};
  const db:Database={checkReady:vi.fn(),disconnect:vi.fn(),events:{history:vi.fn(async()=>Array.from({length:12},()=>row)),get:vi.fn(),notifications:vi.fn(),snapshots:vi.fn()},notifications:{read:vi.fn(),evaluation:vi.fn(),preview:vi.fn(),history:vi.fn(async()=>ledger)}};
  return {db,row};
}
it('returns eight canonical detections independently of notifications and AI; signs only two native crops without fetching media',async()=>{
  const {db}=fixture();const result=await homeAssistantHistory(db,id,'https://dashboard.example',media,now);
  expect(result.eventCount).toBe(8);expect(result.detectionsMarkdown).toContain('skipped · capacity exceeded');expect(result.detectionsMarkdown).toContain('My Driveway');expect(result.detectionsMarkdown).toContain('19:45:00 BST');
  const urls=[...result.detectionsMarkdown.matchAll(/!\[Original NVR detection crop\]\(([^)]+)\)/g)].map(m=>new URL(m[1]!));expect(urls).toHaveLength(2);
  expect(verifyMedia(media,urls[0]!.searchParams.get('token')!,id,image,now.getTime())).toBe(true);
  const repeated=await homeAssistantHistory(db,id,'https://dashboard.example',media,new Date(now.getTime()+1000));expect(repeated.detectionsMarkdown).toBe(result.detectionsMarkdown);
  expect(db.events!.get).not.toHaveBeenCalled();expect(db.notifications!.preview).not.toHaveBeenCalled();
});
it('escapes untrusted descriptions/names and retains uncertain/unmatched/missing states without inventing a zone',async()=>{
  const {db,row}=fixture();Object.assign(row,{analysis:{shortDescription:'<img src=x> [Open](https://evil.invalid)'}});row.objects[0]!.location={status:'AMBIGUOUS',matches:[]};
  const result=await homeAssistantHistory(db,id,'http://localhost:5173',undefined,now);expect(result.detectionsMarkdown).toContain('Boundary uncertain');expect(result.detectionsMarkdown).toContain('&lt;img');expect(result.detectionsMarkdown).not.toContain('[Open](');expect(result.detectionsMarkdown).not.toContain('notification-media');expect(markdownText('a\nb')).toBe('a b');
});
it('shows acknowledged delivery and reasons without asserting phone receipt, creates no jobs',async()=>{
  const {db}=fixture();const item={id,eventId:id,createdAt:now.toISOString(),revision:1,state:'EVALUATED',receivedAt:now.toISOString(),channel:1,deliveryHeldReason:null,decisions:[{ruleId:id,ruleName:'Driveway people',outcome:'SUPPRESSED',reason:'cooldown_active',scopeKey:'rule-camera',cooldownUntil:now.toISOString(),reservationId:null,objectIds:[image],zoneVersionIds:[]}],intent:{id,state:'DELIVERED',attemptCount:1,createdAt:now.toISOString(),deliveredAt:now.toISOString(),lastError:null,nextAttemptAt:now.toISOString(),attempts:[]}};
  db.notifications!.history=vi.fn(async()=>({...ledger,items:[item]}));const result=await homeAssistantHistory(db,id,'http://localhost:5173',undefined,now);expect(result.notificationsMarkdown).toContain('Webhook accepted');expect(result.notificationsMarkdown).toContain('cooldown active');expect(result.notificationsMarkdown).toContain('not confirmation');
});
it('reports unavailable dependencies and bounds empty results',async()=>{
  const {db}=fixture();db.events!.history=vi.fn(async()=>[]);const result=await homeAssistantHistory(db,id,'http://localhost:5173',undefined,now);expect(result.eventCount).toBe(0);expect(result.detectionsMarkdown).toContain('No canonical');delete db.notifications!.history;await expect(homeAssistantHistory(db,id,'http://localhost:5173')).rejects.toThrow();
});
const apps:ReturnType<typeof buildApp>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.app.close()));});
it('scopes the HA token to GET summary only; rejects unauthenticated access, query expansion and writes',async()=>{
  const {db}=fixture();const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',LOG_LEVEL:'silent',UNIVIEW_INSTALLATION_ID:id,EVENTS_TOKEN:'e'.repeat(32),HA_HISTORY_TOKEN:'h'.repeat(32),NOTIFICATION_DASHBOARD_ORIGIN:'http://localhost:5173'});
  const service=buildApp(config,db);apps.push(service);const {app}=service;const headers={authorization:'Bearer '+'h'.repeat(32)};
  expect((await app.inject('/api/dashboard/home-assistant')).statusCode).toBe(401);
  const ok=await app.inject({url:'/api/dashboard/home-assistant',headers});expect(ok.statusCode).toBe(200);expect(ok.headers['cache-control']).toBe('no-store');expect(JSON.stringify(ok.json())).not.toContain('h'.repeat(32));
  expect((await app.inject({url:'/api/events',headers})).statusCode).toBe(401);
  expect((await app.inject({url:'/api/dashboard/home-assistant?limit=1000',headers})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/dashboard/home-assistant',method:'POST',headers})).statusCode).toBe(404);
});
it('queries attempted deliveries independently so exclusions cannot bury accepted alerts',async()=>{
  const {db}=fixture();db.notifications!.history=vi.fn(async(_installation,_cursor,attempted)=>({...ledger,items:attempted?[{id,eventId:id,createdAt:now.toISOString(),revision:1,state:'EVALUATED',receivedAt:null,channel:2,deliveryHeldReason:null,decisions:[],intent:{id,state:'FAILED',attemptCount:2,createdAt:now.toISOString(),deliveredAt:null,lastError:'network_timeout',nextAttemptAt:now.toISOString(),attempts:[]}}]:[]}));const result=await homeAssistantHistory(db,id,'http://localhost:5173',undefined,now);expect(result.notificationsMarkdown).toContain('failed');expect(result.notificationsMarkdown).toContain('network timeout');expect(db.notifications!.history).toHaveBeenCalledWith(id,undefined,true);
});
it('filters attempted history in PostgreSQL before its cursor/page limit',async()=>{
  const {notificationHistory}=await import('../src/notifications/history.js');
  const findMany=vi.fn(async()=>[]);
  const tx={notificationConfiguration:{findUnique:vi.fn(async()=>null)},notificationEvaluation:{findMany}};
  const prisma={$transaction:vi.fn(async(fn:(value:typeof tx)=>Promise<unknown>)=>fn(tx))};
  await notificationHistory(prisma as unknown as Parameters<typeof notificationHistory>[0],id,undefined,true);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({sourceInstallationId:id,kind:'LIVE',intent:{isNot:null}}),take:51}));
});
it('formats UK winter timestamps in compact rows without treating sensor refresh as event activity',async()=>{
 const {db,row}=fixture();row.eventTime=new Date('2026-12-01T12:00:00Z');const result=await homeAssistantHistory(db,id,'http://localhost:5173',undefined,now);expect(result.detections).toHaveLength(4);expect(result.detections[0]!.time).toContain('12:00:00 GMT');expect(result.detections[0]!.time).not.toContain('18:45');
});
it('queries complete zone cohorts and signs only the qualifying property crop, never a Road object crop',async()=>{
 const {db,row}=fixture();const qualified={...row,objects:[{id:image,category:'MOTOR_VEHICLE',cropSnapshotId:image,location:{status:'MATCHED',matches:[{name:'Road',interested:false}]}},{id:id,category:'PERSON',cropSnapshotId:id,location:{status:'MATCHED',matches:[{name:'My Driveway',interested:true}]}}],snapshots:[...row.snapshots,{id,eventId:id,origin:'NVR_PUSH',imageType:'2'}]};
 db.events!.history=vi.fn(async q=>q.zoneInterest==='other'?[]:[qualified]);
 const result=await homeAssistantHistory(db,id,'https://dashboard.example',media,now);expect(result.propertyDetections).toHaveLength(1);const item=result.propertyDetections[0]!;expect(item.subtitle).toContain('Person detected');expect(item.subtitle).not.toMatch(/skipped|capacity|Road/);expect(item.title).not.toContain('Vehicle');expect(item.thumbnail).toBeTruthy();expect(verifyMedia(media,new URL(item.thumbnail!).searchParams.get('token')!,id,id,now.getTime())).toBe(true);expect(result.otherDetections).toHaveLength(0);
});
