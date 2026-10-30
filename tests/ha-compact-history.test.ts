import { expect,it,vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { compactDetection,compactNotification } from '../src/dashboard/compact-history.js';
import { presentEvent } from '../src/events/presentation.js';
import { activityCatalog,createZoneActivity } from '../src/dashboard/zone-activity.js';
import { locateObject,type LocationZone } from '../src/uniview/object-location.js';
import type { Prisma,PrismaClient } from '../src/generated/prisma/client.js';
import type { DeliveryHistory } from '../src/notifications/history.js';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now=new Date('2026-10-21T12:00:00Z'),url='https://dashboard.example/explore?event='+id(1);
const polygon=[{X:1000,Y:1000},{X:9000,Y:1000},{X:9000,Y:9000},{X:1000,Y:9000}];
const zones:LocationZone[]=Array.from({length:4},(_,slot)=>({id:id(10+slot),zoneId:id(20+slot),slot,revision:2,channel:1,sourceInstallationId:id(1),name:'Zone '+slot,interested:slot===0,enabled:slot<2,ruleEnabled:true,polygon:slot<2?polygon:[],observedAt:new Date(+now-3600000),nameEffectiveAt:new Date(+now-3600000),lastObservedAt:new Date(+now-60000)}));
it('produces compact source-category rows, concise AI skips and no speculative zone name',()=>{
 const row={id:id(1),occurredAt:now.toISOString(),camera:'Driveway',nvrChannel:1,categories:['PERSON','MOTOR_VEHICLE'],processing:{status:'SKIPPED',reason:'capacity_exceeded'},objects:[{category:'PERSON',location:{status:'AMBIGUOUS',matches:[{name:'My Driveway'}]}}]};
 const result=compactDetection(row,presentEvent(row),url,'21 Oct, 13:00 BST');expect(result.title).toBe('Person + Vehicle · Boundary uncertain');expect(result.subtitle).toBe('Person + Vehicle detected');expect(result.url).toBe(url);expect(result).not.toHaveProperty('html');
 const accepted={...row,processing:{status:'COMPLETE'},analysis:{shortDescription:'A person appears to be walking.'},objects:[{location:{status:'MATCHED',matches:[{name:'My Driveway'}]}}]};expect(compactDetection(accepted,presentEvent(accepted),url,'time').subtitle).toBe('A person appears to be walking.');
});
const item:DeliveryHistory['items'][number]={id:id(2),eventId:id(1),createdAt:now.toISOString(),revision:1,state:'EVALUATED',receivedAt:now.toISOString(),channel:1,deliveryHeldReason:null,decisions:[],intent:null};
it('chooses the delivery state over irrelevant disabled rules and distinguishes acceptance from geometry uncertainty',()=>{
 const delivered={id:id(3),state:'DELIVERED',attemptCount:1,createdAt:now.toISOString(),deliveredAt:now.toISOString(),lastError:null,nextAttemptAt:now.toISOString(),attempts:[]};
 expect(compactNotification({...item,intent:delivered},url,'time').status).toBe('Webhook accepted');
 expect(compactNotification({...item,deliveryHeldReason:'global_delivery_disabled'},url,'time').status).toBe('Delivery held');
 for(const[state,expected]of[['FAILED','Delivery failed'],['UNCERTAIN','Acceptance uncertain'],['READY','Delivery pending'],['EXPIRED','Delivery expired']])expect(compactNotification({...item,intent:{...delivered,state:state!}},url,'time').status).toBe(expected);
 for(const[reason,expected]of[['cooldown_active','Cooldown suppressed'],['unknown_excluded','Unknown zone excluded'],['ambiguous_excluded','Boundary excluded'],['category_not_selected','Not selected']]){
  const decision={ruleId:id(4),ruleName:'Driveway people',outcome:'SUPPRESSED',reason:reason!,scopeKey:'scope',cooldownUntil:null,reservationId:null,objectIds:[],zoneVersionIds:[]};
  expect(compactNotification({...item,decisions:[decision,{...decision,reason:'rule_disabled'}]},url,'time').status).toBe(expected);
 }
});
it('bounds carry-forward and never applies replacement geometry to old event times',()=>{
 const selected=activityCatalog(zones,now);expect(selected).toHaveLength(4);expect(selected.every(v=>v.cached)).toBe(true);
 const object={coordinateStatus:'VALID',xMin:4000,xMax:6000,yMin:4000,yMax:6000,fullFrameSnapshotId:id(50),sourceTimestamp:new Date(+now-1000)};
 expect(locateObject(object,selected.map(v=>v.effective)).status).toBe('MATCHED');
 expect(locateObject({...object,sourceTimestamp:new Date(+now-7200000)},selected.map(v=>v.effective)).status).toBe('UNKNOWN');
 const stale=activityCatalog(zones.map(z=>({...z,lastObservedAt:new Date(+now-1200001)})),now);expect(stale.some(v=>v.cached)).toBe(false);
 expect(locateObject(object,stale.map(v=>v.effective)).status).toBe('UNKNOWN');
 expect(activityCatalog([...zones,{...zones[0]!,id:id(99)}],now)).toHaveLength(0);expect(activityCatalog(zones.slice(0,3),now)).toHaveLength(0);
});
it('aggregates exact source timestamps in SQL; excludes boundaries, missing, future, old-geometry and other-installation observations',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE "SecurityEvent"(id uuid PRIMARY KEY,"sourceInstallationId" uuid,"nvrChannel" int); CREATE TABLE "UniviewObject"(id uuid PRIMARY KEY,"eventId" uuid,"coordinateStatus" text,"sourceTimestamp" timestamptz,"xMin" int,"yMin" int,"xMax" int,"yMax" int,"fullFrameSnapshotId" uuid,category text)');
  await db.query('INSERT INTO "SecurityEvent" VALUES ($1,$2,1),($3,$4,1)',[id(1),id(1),id(2),id(2)]);
  const insert=async(n:number,time:Date|null,status='VALID',xMin=4000,xMax=6000,event=id(1),frame:string|null=id(50))=>db.query('INSERT INTO "UniviewObject" VALUES ($1,$2,$3,$4,$5,4000,$6,6000,$7,\'MOTOR_VEHICLE\')',[id(n),event,status,time,xMin,xMax,frame]);
  await insert(100,new Date(+now-600000));await insert(101,new Date(+now-1000),'VALID',1000,1100);await insert(102,new Date(+now-1000),'MISSING');await insert(103,new Date(+now-7200000));await insert(104,new Date(+now+60000));await insert(105,new Date(+now-1000),'VALID',4000,6000,id(2));await insert(106,null);await insert(107,new Date(+now-1000),'VALID',4000,6000,id(1),null);
  const raw=zones.map(z=>({...z,displayName:z.name,zone:{slot:z.slot,channel:z.channel,sourceInstallationId:z.sourceInstallationId,preference:{displayName:z.name,interested:z.interested}}}));
  const prisma={univiewZoneVersion:{findMany:vi.fn(async()=>raw)},$queryRaw:async(sql:Prisma.Sql)=>{const result=await db.query<{zoneId:string;lastActivityAt:Date|string}>(sql.text,sql.values);return result.rows.map(r=>({...r,lastActivityAt:new Date(r.lastActivityAt)}));}};
  const result=await createZoneActivity(prisma as unknown as PrismaClient)(id(1),now);
  expect(result.filter(z=>z.lastActivityAt).map(z=>z.lastActivityAt)).toEqual([new Date(+now-600000).toISOString(),new Date(+now-600000).toISOString()]);expect(result.filter(z=>!z.enabled).every(z=>z.lastActivityAt===null)).toBe(true);
  await db.query('INSERT INTO "UniviewObject" VALUES ($1,$2,\'VALID\',$3,1000,500,1100,1200,$4,\'PERSON\')',[id(200),id(1),new Date(+now-5000),id(50)]);
  const people=await createZoneActivity(prisma as unknown as PrismaClient)(id(1),now);expect(people.filter(z=>z.lastActivityAt).map(z=>z.lastActivityAt)).toEqual([new Date(+now-5000).toISOString(),new Date(+now-5000).toISOString()]);
 }finally{await db.close();}
});
it('uses only the qualifying property object for category and AI text, with clean source fallbacks',()=>{
 const row={id:id(1),occurredAt:now.toISOString(),camera:'Driveway',processing:{status:'COMPLETE'},categories:['PERSON','MOTOR_VEHICLE'],analysis:{shortDescription:'A red vehicle is visible.',objectAnalyses:[{objectId:id(2),shortDescription:'A red vehicle is visible.'},{objectId:id(3),shortDescription:'A person appears to be walking.'}]},objects:[{id:id(2),category:'MOTOR_VEHICLE',location:{status:'MATCHED',matches:[{name:'Road',interested:false}]},analysis:{shortDescription:'A red vehicle is visible.'}},{id:id(3),category:'PERSON',location:{status:'MATCHED',matches:[{name:'My Driveway',interested:true}]},analysis:{shortDescription:'A person appears to be walking.'}}]};
 const result=compactDetection(row,presentEvent(row),url,'time','property');expect(result.title).toBe('Person · My Driveway');expect(result.subtitle).toBe('A person appears to be walking.');expect(result.subtitle).not.toContain('Road');
 const skipped={...row,processing:{status:'SKIPPED'}};expect(compactDetection(skipped,presentEvent(skipped),url,'time','property').subtitle).toBe('Person detected');
});
it('keeps ambiguous-only events out of both groups and a mixed event in property only',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE "SecurityEvent"(id int PRIMARY KEY);CREATE TABLE "UniviewObject"(id int PRIMARY KEY,"eventId" int);CREATE TABLE object_locations(id int,"eventId" int,status text,interested bool);INSERT INTO "SecurityEvent" VALUES(1),(2),(3),(4);INSERT INTO "UniviewObject" VALUES(1,1),(2,2),(3,3),(4,4),(5,4);INSERT INTO object_locations VALUES(1,1,\'MATCHED\',true),(2,2,\'MATCHED\',false),(3,3,\'AMBIGUOUS\',true),(4,4,\'MATCHED\',true),(5,4,\'MATCHED\',false)');
  const {historyFilters}=await import('../src/events/store.js'),{historySchema}=await import('../src/events/queries.js'),{Prisma:sql}=await import('../src/generated/prisma/client.js');
  for(const[scope,expected]of[['interested',[1,4]],['other',[2]]] as const){const clauses=historyFilters(historySchema.parse({zoneInterest:scope}));const statement=sql.sql`SELECT e.id FROM "SecurityEvent" e WHERE ${sql.join(clauses,' AND ')} ORDER BY e.id LIMIT 4`;expect((await db.query<{id:number}>(statement.text,statement.values)).rows.map(r=>r.id)).toEqual(expected);}
 }finally{await db.close();}
});
