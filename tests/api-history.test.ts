import { afterEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { buildApp } from '../src/app.js';
import { historySchema } from '../src/events/queries.js';
import { createEventQueries, historyFilters } from '../src/events/store.js';
import { presentEvent } from '../src/events/presentation.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { NvrApi } from '../src/events/nvr-service.js';
import { createStreamDiscovery } from '../src/uniview/verified-streams.js';
import { streamFixture } from './stream-fixtures.js';
const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb', other='27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const timestamp=new Date('2026-10-14T12:00:00Z');
const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',EVENTS_TOKEN:'e'.repeat(32),LOG_LEVEL:'silent',UNIVIEW_NVR_IP:'192.168.50.30',UNIVIEW_INSTALLATION_ID:id,UNIVIEW_CAMERA_MAP:'{"1":"camera_1","2":"camera_2"}'});
const authorization='Bearer '+'e'.repeat(32);
const instances: ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(instances.splice(0).map((s)=>s.app.close()));});
function setup(rows:Record<string,unknown>[]=[{id,occurredAt:null,eventTime:timestamp,timestampSource:'STRUCTURE_REPORTED_AT',sourceNotificationId:other,categories:['PERSON','MOTOR_VEHICLE']}]) {
 const events={history:vi.fn(async()=>rows),get:vi.fn(async()=>rows[0]??null),notifications:vi.fn(async()=>[]),snapshots:vi.fn(async()=>[])};
 const database:Database={events,checkReady:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{})};
 const nvr:NvrApi={image:vi.fn(),enrich:vi.fn(async()=>({eventId:id,aiInvoked:false})),close:vi.fn(async()=>{})};
 const streams=createStreamDiscovery(config,{videoStreams:vi.fn(async()=>streamFixture()),liveStreamReference:vi.fn(async()=>({URL:'rtsp://private'}))});
 const service=buildApp(config,database,undefined,nvr,streams); instances.push(service);return{...service,events,nvr,database};
}
it('defaults to 30, paginates by effective source time and UUID, and never invokes NVR during browsing',async()=>{
 const f=setup(Array.from({length:31},(_,i)=>({id:i===29?id:other,eventTime:timestamp,categories:['PERSON']})));
 const response=await f.app.inject({url:'/api/events?camera=camera_1&category=person',headers:{authorization}});
 expect(response.statusCode).toBe(200);expect(response.json().events).toHaveLength(30);
 expect(f.events.history).toHaveBeenCalledWith(expect.objectContaining({limit:30,camera:'camera_1',category:'person'}));
 const cursor=response.json().nextCursor; expect(JSON.parse(Buffer.from(cursor,'base64url').toString())).toEqual({eventTime:timestamp.toISOString(),id});
 await f.app.inject({url:'/api/events?cursor='+cursor,headers:{authorization}});
 expect(f.events.history).toHaveBeenLastCalledWith(expect.objectContaining({cursor:{eventTime:timestamp,id}}));
 expect(f.nvr.image).not.toHaveBeenCalled();expect(f.nvr.enrich).not.toHaveBeenCalled();
});
it('reports Structure-only timestamps without manufacturing occurredAt or a capture time',async()=>{
 const f=setup();const response=await f.app.inject({url:'/api/events/'+id,headers:{authorization}});
 expect(response.json()).toMatchObject({occurredAt:null,categories:['person','motor_vehicle'],timestamp:{value:timestamp.toISOString(),source:'STRUCTURE_REPORTED_AT',notificationId:other,imageCaptureTime:false},enrichment:{method:'POST',automaticOnRead:false}});
 expect(f.nvr.enrich).not.toHaveBeenCalled();
});
it('date/zone/category filters are SQL parameters and Structure time is computed before pagination',()=>{
 const q=historySchema.parse({camera:"x' OR true --",category:'person',zoneId:id,occurredAfter:'2026-10-14T00:00:00Z',occurredBefore:'2026-10-15T00:00:00Z',zoneRelation:'membership'});
 const filters=historyFilters(q);const text=filters.map((f)=>f.sql).join(' '),values=filters.flatMap((f)=>f.values);
 expect(text).not.toContain("x' OR true");expect(values).toContain("x' OR true --");expect(values).toContain('PERSON');expect(values).toContain(id);
 expect(text).toContain('COALESCE(e."occurredAt",s."reportedAt",e."firstReceivedAt")');expect(text).toContain("m.relationship IN ('WITHIN','INTERSECTS')");
 expect(text).toContain('o."eventId"=e.id');expect(text).toContain('m."objectId"=o.id');
});
it('trigger and historical/current name filters remain distinct',()=>{
 const historical=historyFilters(historySchema.parse({zoneName:'Driveway',category:'motor_vehicle'}));
 expect(historical.map((f)=>f.sql).join(' ')).toContain("a.status='CONFIRMED_GEOMETRY_MATCH'");expect(historical.map((f)=>f.sql).join(' ')).toContain('v."displayName"=');
 const current=historyFilters(historySchema.parse({zoneName:'Driveway',zoneNameScope:'current'}));expect(current.map((f)=>f.sql).join(' ')).toContain('z."displayName"=');
});
it('preserves page order after hydration and selects earliest Structure across all notifications',async()=>{
 const query=vi.fn(async()=>[{id:other,eventTime:timestamp,timestampSource:'STRUCTURE_REPORTED_AT',sourceNotificationId:id,categories:['PERSON']},{id,eventTime:timestamp,timestampSource:'FIRST_RECEIVED_AT',sourceNotificationId:null,categories:[]}]);
 const findMany=vi.fn(async()=>[{id,objects:[]},{id:other,objects:[]}]);
 const store=createEventQueries({$queryRaw:query,securityEvent:{findMany},univiewZoneVersion:{findMany:async()=>[]}} as unknown as PrismaClient);
 const rows=await store.history(historySchema.parse({limit:1}));expect(rows.map((r)=>r.id)).toEqual([other,id]);
 const sql=query.mock.calls[0] as unknown as [{sql:string;values:unknown[]}];expect(sql[0].sql).toContain('ORDER BY n."reportedAt",n.id LIMIT 1');expect(sql[0].values.at(-1)).toBe(2);
});
it.each(['?limit=101','?category=car','?cursor=garbage','?occurredAfter=2026-10-15T00:00:00Z&occurredBefore=2026-10-14T00:00:00Z','?url=http://internal/'])('rejects invalid filters %s',async(query)=>{
 const f=setup();expect((await f.app.inject({url:'/api/events'+query,headers:{authorization}})).statusCode).toBe(400);expect(f.events.history).not.toHaveBeenCalled();
});
it.each(['/api/events','/api/events/'+id,'/api/events/'+id+'/images/'+other,'/api/cameras','/api/cameras/camera_1/zones','/api/cameras/camera_1/streams'])('authenticates %s before queries/media work',async(url)=>{
 const f=setup();expect((await f.app.inject(url)).statusCode).toBe(401);expect((await f.app.inject(url+'?token='+'e'.repeat(32))).statusCode).toBe(401);
 expect(f.events.history).not.toHaveBeenCalled();expect(f.events.get).not.toHaveBeenCalled();expect(f.nvr.image).not.toHaveBeenCalled();
});
it('authenticates explicit enrichment and invokes no AI',async()=>{
 const f=setup();const url='/api/events/'+id+'/enrich';
 expect((await f.app.inject({method:'POST',url})).statusCode).toBe(401);
 const response=await f.app.inject({method:'POST',url,headers:{authorization},payload:{}});expect(response.statusCode).toBe(200);expect(response.json().aiInvoked).toBe(false);
 expect(f.nvr.enrich).toHaveBeenCalledOnce();
});
it('presents multiple object classes, source rectangles, historical/current zones and safe image URLs',()=>{
 const source={id,sourceIdentifiers:{PersonID:1},category:'PERSON',coordinateStatus:'VALID',xMin:1,yMin:2,xMax:100,yMax:200,fullFrameSnapshotId:other,cropSnapshotId:id,
 zoneEvidence:{status:'CONFIRMED_GEOMETRY_MATCH',sourceRules:[{rule:{PointNum:4,PointList:[{X:1,Y:2,InternalUrl:'rtsp://secret'}]}}],zoneVersion:{id:'old',displayName:'Old name',polygon:[],zone:{id:'slot',slot:1,displayName:'Current name',versions:[{id:'new'}]}}},memberships:[]};
 const response=presentEvent({id,eventTime:timestamp,objects:[source,{...source,id:other,category:'MOTOR_VEHICLE'}],snapshots:[{id:other,eventId:id,origin:'NVR_PUSH',imageType:'1',nvrPictureName:'internal-secret',nvrUrl:'rtsp://secret',referenceStatus:'VERIFIED'}],analysis:{shortDescription:'Synthetic activity',detailedDescription:'Synthetic fixture'}});
 expect(response.objects).toHaveLength(2);expect(response.objects[0]).toMatchObject({rectangle:{imageId:other,scale:10000,coordinateSpace:'original_full_frame'},images:{cropId:id},triggeringZone:{version:{displayName:'Old name',currentName:'Current name',currentVersionId:'new'}}});
 expect(response.images[0]!.url).toBe(`/api/events/${id}/images/${other}`);expect(JSON.stringify(response)).not.toContain('secret');
});
it('profile metadata is honest about missing playback, exposes no URLs/passwords, and requires configured host',async()=>{
 const f=setup();const response=await f.app.inject({url:'/api/cameras/camera_1/streams',headers:{authorization}});
 expect(response.json().profiles).toHaveLength(3);expect(response.json().profiles[0]).toMatchObject({videoCodec:'hevc',width:3840,fps:25,playback:{state:'gateway_not_configured',endpoint:null}});
 expect(response.json().profiles[1]).toMatchObject({videoCodec:'h264',width:1280,height:720});expect(response.body).not.toContain('rtsp://');expect(response.body).not.toContain('192.168');
 const cameras=await f.app.inject({url:'/api/cameras',headers:{authorization}});expect(cameras.json().cameras).toHaveLength(2);
 expect((await f.app.inject({url:'/api/cameras/unknown/streams',headers:{authorization}})).statusCode).toBe(404);
});
it('returns persisted current and historical zones without NVR calls, including disabled slots',async()=>{
 const f=setup();
 const versions=[{id:other,revision:2,displayName:'Walkway',enabled:false,polygon:[{X:1,Y:2}],observedAt:timestamp,lastObservedAt:timestamp},
   {id,revision:1,displayName:'Previous name',enabled:true,polygon:[{X:3,Y:4}],observedAt:timestamp,lastObservedAt:timestamp}];
 const list=vi.fn(async()=>[{id,slot:0,displayName:'Walkway',versions}]);
 f.database.zones={list} as unknown as NonNullable<Database['zones']>;
 const response=await f.app.inject({url:'/api/cameras/camera_1/zones',headers:{authorization}});
 expect(response.statusCode).toBe(200);expect(list).toHaveBeenCalledWith(config.UNIVIEW_INSTALLATION_ID,1);
 expect(response.json().zones[0]).toMatchObject({slot:0,name:'Walkway',current:{id:other,enabled:false,currentVersionId:other},versions:[{displayName:'Walkway'},{displayName:'Previous name',currentName:'Walkway'}]});
 expect(f.nvr.enrich).not.toHaveBeenCalled();expect(f.nvr.image).not.toHaveBeenCalled();
 list.mockRejectedValue(new Error('private driver error'));const unavailable=await f.app.inject({url:'/api/cameras/camera_1/zones',headers:{authorization}});
 expect(unavailable.statusCode).toBe(503);expect(unavailable.body).not.toContain('private');
 expect((await f.app.inject({url:'/api/cameras/unknown/zones',headers:{authorization}})).statusCode).toBe(404);
});
it('keeps persistence failures separate from static camera metadata',async()=>{
 const f=setup();f.events.history.mockRejectedValue(new Error('database password'));
 expect((await f.app.inject({url:'/api/events',headers:{authorization}})).statusCode).toBe(503);
 expect((await f.app.inject({url:'/api/cameras/camera_2/zones',headers:{authorization}})).statusCode).toBe(503);
 const streams=await f.app.inject({url:'/api/cameras/camera_2/streams',headers:{authorization}});
 expect(streams.statusCode).toBe(200);expect(streams.json().profiles[0]).toMatchObject({fps:25,videoCodec:'hevc'});expect(streams.json().profiles[1]).toMatchObject({fps:5,videoCodec:'h264'});
});

it('encodes oldest-first cursors and rejects reusing them with newest-first filters',async()=>{
 const f=setup([{id,eventTime:timestamp,categories:['PERSON']},{id:other,eventTime:timestamp,categories:['PERSON']}]);
 const response=await f.app.inject({url:'/api/events?sort=oldest&limit=1&aiOutcome=completed&notificationOutcome=accepted',headers:{authorization}});expect(response.statusCode).toBe(200);const cursor=response.json().nextCursor;expect(JSON.parse(Buffer.from(cursor,'base64url').toString())).toEqual({eventTime:timestamp.toISOString(),id,sort:'oldest'});
 expect((await f.app.inject({url:'/api/events?sort=oldest&cursor='+cursor,headers:{authorization}})).statusCode).toBe(200);
 expect((await f.app.inject({url:'/api/events?cursor='+cursor,headers:{authorization}})).statusCode).toBe(400);
});
