import {expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import type {PrismaClient,Prisma} from '../src/generated/prisma/client.js';
import {historySchema} from '../src/events/queries.js';
import {createEventQueries} from '../src/events/store.js';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
it('filters actual SQL before pagination in both directions, with timestamp fallback, ties and outcome precedence',async()=>{
 const db=new PGlite();try{
  await db.exec(`CREATE TYPE "NotificationKind" AS ENUM ('ALARM','STRUCTURE'); CREATE TABLE "SecurityEvent"(id uuid PRIMARY KEY,"sourceInstallationId" uuid,"nvrChannel" int,camera text,"alarmType" text,"alarmSeen" bool,"occurredAt" timestamptz,"firstReceivedAt" timestamptz); CREATE TABLE "UniviewNotification"(id uuid,"eventId" uuid,kind "NotificationKind","reportedAt" timestamptz); CREATE TABLE "UniviewObject"(id uuid,"eventId" uuid,category text); CREATE TABLE "EventAnalysis"("eventId" uuid); CREATE TABLE "EvidenceProcessing"("eventId" uuid,status text,reason text); CREATE TABLE "NotificationEvaluation"(id uuid,"eventId" uuid,"sourceInstallationId" uuid,kind text,state text,result jsonb); CREATE TABLE "NotificationIntent"(id uuid,"eventId" uuid,mode text,state text);`);
  for(let n=1;n<=9;n++){
   await db.query('INSERT INTO "SecurityEvent" VALUES($1,$2,$3,$4,\'EnterArea\',true,$5,$6)',[id(n),id(99),n===9?2:1,n===9?'camera_2':'camera_1',n===2?null:`2026-10-25T0${n<5?0:1}:30:00Z`,'2026-10-25T02:00:00Z']);
   await db.query('INSERT INTO "UniviewObject" VALUES($1,$2,$3)',[id(n+100),id(n),n===8?'MOTOR_VEHICLE':'PERSON']);
   if(n===2)await db.query('INSERT INTO "UniviewNotification" VALUES($1,$2,\'STRUCTURE\',\'2026-10-25T00:30:00Z\')',[id(202),id(n)]);
   if(n===1)await db.query('INSERT INTO "EventAnalysis" VALUES($1)',[id(n)]);
   if(n!==7)await db.query('INSERT INTO "EvidenceProcessing" VALUES($1,$2,$3)',[id(n),n===1?'COMPLETE':n===4?'FAILED':'SKIPPED',n===1?'ai_complete':n===2?'zone_not_selected':n===3?'capacity_exceeded':n===4?'invalid_model_output':'no_full_frame']);
   if(n!==7)await db.query('INSERT INTO "NotificationEvaluation" VALUES($1,$2,$3,\'LIVE\',$4,$5)',[id(n+300),id(n),id(99),n===6?'WAITING':'EVALUATED',JSON.stringify({decisions:[{outcome:n===2?'cooldown':n===6?'reserved':'unmatched',reason:n===2?'cooldown_after_delivery':n===5?'unknown_excluded':n===6?'cooldown_reserved':'category_not_selected'},{outcome:'rule_disabled',reason:'rule_disabled'}]})]);
  }
  for(const[n,state]of [[1,'DELIVERED'],[3,'UNCERTAIN'],[4,'FAILED']] as const)await db.query('INSERT INTO "NotificationIntent" VALUES($1,$2,\'LIVE\',$3)',[id(n+400),id(n),state]);
  // A TEST and enrichment must never make an unrelated event appear delivered.
  await db.query('INSERT INTO "NotificationIntent" VALUES($1,$2,\'UPDATE\',\'DELIVERED\')',[id(499),id(8)]);
  const prisma={univiewZoneVersion:{findMany:vi.fn(async()=>[])},$queryRaw:async(s:Prisma.Sql)=>(await db.query(s.text,s.values)).rows,securityEvent:{findMany:async({where}:{where:{id:{in:string[]}}})=>where.id.in.map(id=>({id,objects:[]}))}} as unknown as PrismaClient;
  const store=createEventQueries(prisma),fetch=async(q:Record<string,unknown>)=>(await store.history(historySchema.parse(q))).map(r=>r.id);
  expect(await fetch({camera:'camera_1',category:'person',aiOutcome:'completed',notificationOutcome:'accepted'})).toEqual([id(1)]);
  for(const[key,value,expected]of [['aiOutcome','excluded',2],['aiOutcome','capacity',3],['aiOutcome','failed',4],['aiOutcome','pending',7],['notificationOutcome','cooldown',2],['notificationOutcome','failed',4],['notificationOutcome','pending',6],['notificationOutcome','not_evaluated',7]] as const)expect(await fetch({camera:'camera_1',category:'person',[key]:value})).toEqual([id(expected)]);
  expect(await fetch({notificationOutcome:'uncertain',category:'person',camera:'camera_1'})).toEqual([id(5),id(3)]);
  expect(await fetch({notificationOutcome:'accepted',category:'motor_vehicle'})).toEqual([]);
  for(const sort of ['newest','oldest']){
   let cursor:string|undefined;const seen:string[]=[];for(let page=0;page<5;page++){const rows=await store.history(historySchema.parse({sort,limit:2,...(cursor?{cursor}:{})}));const items=rows.slice(0,2);seen.push(...items.map(r=>String(r.id)));if(rows.length<=2)break;const last=items.at(-1)!;cursor=Buffer.from(JSON.stringify({id:last.id,eventTime:last.eventTime,...(sort==='oldest'?{sort}:{})})).toString('base64url');}
   expect(seen).toEqual(Array.from({length:9},(_,i)=>id(sort==='newest'?9-i:i+1)));expect(new Set(seen).size).toBe(9);
  }
  expect(await fetch({occurredAfter:'2026-10-25T00:30:00Z',occurredBefore:'2026-10-25T00:30:00Z',sort:'oldest'})).toEqual([1,2,3,4].map(id));
 }finally{await db.close();}
});
it('rejects a cursor from the opposite ordering and preserves legacy newest cursors',()=>{
 const cursor=(sort?:string)=>Buffer.from(JSON.stringify({id:id(1),eventTime:'2026-10-25T00:00:00Z',...(sort?{sort}:{})})).toString('base64url');
 expect(historySchema.safeParse({sort:'oldest',cursor:cursor()}).success).toBe(false);expect(historySchema.safeParse({cursor:cursor('oldest')}).success).toBe(false);expect(historySchema.parse({cursor:cursor()}).sort).toBe('newest');
});
