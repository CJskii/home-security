import {afterEach,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app.js';
import {buildDevelopmentApp} from '../src/dashboard/development.js';
import {loadConfig} from '../src/config.js';
import {developmentNotificationWriter} from '../src/dashboard/development-notifications.js';
import type {NotificationStore} from '../src/notifications/store.js';
import {NotificationLimit,NotificationConflict} from '../src/notifications/contracts.js';
const installation='10000000-0000-4000-8000-000000000001',id='10000000-0000-4000-8000-000000000002',configuration={deliveryEnabled:false,rules:[]},window={from:'2026-10-20T12:00:00.000Z',to:'2026-10-20T13:00:00.000Z'},payload={...window,expectedRevision:0,fingerprint:'a'.repeat(64)};
const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',UNIVIEW_INSTALLATION_ID:installation,EVENTS_TOKEN:'e'.repeat(32),DASHBOARD_ORIGIN:'http://127.0.0.1:5173',DASHBOARD_PASSWORD:'p'.repeat(32),DASHBOARD_SESSION_KEY:'a'.repeat(64),LOG_LEVEL:'silent'});
const apps:ReturnType<typeof buildApp>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(s=>s.app.close()));});
const response={available:true,writable:true,archivable:true,deliveryAvailable:false,revision:0,updatedAt:null,configuration,cameras:[],zones:[],evaluations:[]};
function setup(){const store={history:vi.fn(async()=>({available:true,producerEnabled:false,deliveryEnabled:false,nextCursor:null,items:[]})),read:vi.fn(async()=>response),save:vi.fn(async()=>response),preview:vi.fn<NotificationStore['preview']>(async()=>({deliveryAvailable:false})),archive:vi.fn(async()=>({deliveryAvailable:false})),evaluation:vi.fn(async()=>null)};const service=buildApp(config,{notifications:store,checkReady:async()=>{},disconnect:async()=>{}});apps.push(service);return {app:service.app,store};}
it('authenticates all notification operations and protects saves/preview/archive with session Origin',async()=>{
 const {app,store}=setup();for(const path of['/api/notifications/settings','/api/notifications/evaluations/'+id])expect((await app.inject(path)).statusCode).toBe(401);
 for(const[path,method,body]of[['/api/notifications/settings','PUT',{expectedRevision:0,configuration}],['/api/notifications/preview','POST',window],['/api/notifications/evaluations','POST',payload]] as const){expect((await app.inject({method,url:path,payload:body})).statusCode).toBe(401);}
 const login=await app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}}),cookie=login.headers['set-cookie'] as string;
 for(const headers of[{cookie},{cookie,origin:'https://bad.example'},{cookie,origin:config.DASHBOARD_ORIGIN!,'sec-fetch-site':'cross-site'}])for(const[path,method,body]of[['/api/notifications/settings','PUT',{expectedRevision:0,configuration}],['/api/notifications/preview','POST',window],['/api/notifications/evaluations','POST',payload]] as const)expect([401,403]).toContain((await app.inject({method,url:path,headers,payload:body})).statusCode);
 expect(store.save).not.toHaveBeenCalled();expect(store.preview).not.toHaveBeenCalled();expect(store.archive).not.toHaveBeenCalled();
 const headers={cookie,origin:config.DASHBOARD_ORIGIN!};expect((await app.inject({method:'PUT',url:'/api/notifications/settings',headers,payload:{expectedRevision:0,configuration:{deliveryEnabled:true,rules:[]}}})).statusCode).toBe(200);expect(store.save).toHaveBeenCalledWith(installation,0,{deliveryEnabled:true,rules:[]});
 expect((await app.inject({method:'POST',url:'/api/notifications/preview',headers,payload:window})).statusCode).toBe(200);expect(store.archive).not.toHaveBeenCalled();
 expect((await app.inject({method:'POST',url:'/api/notifications/evaluations',headers,payload})).statusCode).toBe(200);
 expect((await app.inject({url:'/api/notifications/evaluations/'+id,headers})).statusCode).toBe(404);expect(store.evaluation).toHaveBeenCalledWith(installation,id);
 expect((await app.inject({method:'PUT',url:'/api/notifications/settings',headers,payload:{expectedRevision:0,configuration,senderEnabled:true}})).statusCode).toBe(400);
});
it('bounds overlapping preview/archive work and reports stale revisions and oversized windows',async()=>{
 const {app,store}=setup(),headers={authorization:'Bearer '+config.EVENTS_TOKEN};
 store.preview.mockRejectedValueOnce(new NotificationLimit('Select shorter window'));expect((await app.inject({method:'POST',url:'/api/notifications/preview',headers,payload:window})).statusCode).toBe(413);
 store.save.mockRejectedValueOnce(new NotificationConflict('Settings changed'));expect((await app.inject({method:'PUT',url:'/api/notifications/settings',headers,payload:{expectedRevision:0,configuration}})).statusCode).toBe(409);
 expect((await app.inject({method:'POST',url:'/api/notifications/evaluations',headers,payload:{...payload,to:payload.from}})).statusCode).toBe(400);
 let finish!:(v:unknown)=>void;store.preview.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));const request=app.inject({method:'POST',url:'/api/notifications/preview',headers,payload:window}).then(v=>v);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 expect((await app.inject({method:'POST',url:'/api/notifications/evaluations',headers,payload})).statusCode).toBe(409);finish({deliveryAvailable:false});expect((await request).statusCode).toBe(200);
});
it('keeps local SQL read-only while allowing only scoped fixed-path metadata forwarding',async()=>{
 const calls:Parameters<typeof fetch>[]=[],request=vi.fn<typeof fetch>(async(...args)=>{calls.push(args);return Response.json(args[1]?.method==='PUT'?response:{id,fingerprint:payload.fingerprint,configurationRevision:0,createdAt:window.from,deliveryAvailable:false})});
 const writer=developmentNotificationWriter(config,config.EVENTS_TOKEN,request);await writer.save!(installation,0,configuration);await writer.archive!(installation,window,0,payload.fingerprint);
 expect(calls.map(([url])=>url)).toEqual(['http://127.0.0.1:3000/api/notifications/settings','http://127.0.0.1:3000/api/notifications/evaluations']);expect(calls.every(([,v])=>v?.redirect==='error'&&!!v.signal)).toBe(true);
 await expect(writer.save!(id,0,configuration)).rejects.toThrow('Unknown notification scope');expect(request).toHaveBeenCalledTimes(2);expect(developmentNotificationWriter(config,undefined,request)).toEqual({});
 const local={...config,EVENTS_TOKEN:undefined,AI_ENABLED:false,AI_ZONE_SELECTION_ENABLED:false,UNIVIEW_ENABLED:false,METRICS_ENABLED:false},preview=vi.fn(async()=>({deliveryAvailable:false}));
 const service=buildDevelopmentApp(local,{notifications:{...writer,read:async()=>response,evaluation:async()=>null,preview},historicalImages:{load:async()=>null,save:async()=>false},checkReady:async()=>{},disconnect:async()=>{}});apps.push(service);
 const login=await service.app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}}),headers={cookie:login.headers['set-cookie'] as string,origin:config.DASHBOARD_ORIGIN!};
 expect((await service.app.inject({method:'POST',url:'/api/notifications/preview',headers,payload:window})).statusCode).toBe(200);expect(preview).toHaveBeenCalledOnce();
 expect((await service.app.inject({method:'POST',url:'/api/events/'+id+'/enrich',headers,payload:{}})).statusCode).toBe(405);
});
it('rejects unsafe upstream settings responses and does not forward unvalidated input',async()=>{
 const request=vi.fn<typeof fetch>(async()=>Response.json({...response,credential:'must never pass through'})),writer=developmentNotificationWriter(config,config.EVENTS_TOKEN,request);
 await expect(writer.save!(installation,0,configuration)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 await expect(writer.archive!(installation,window,0,'not-a-fingerprint')).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 request.mockResolvedValueOnce(new Response('x'.repeat(65537)));await expect(writer.save!(installation,0,configuration)).rejects.toThrow('response too large');
});

it('protects read-only delivery history, validates cursors and never invokes preview or a sender',async()=>{
 const {app,store}=setup();expect((await app.inject('/api/notifications/history')).statusCode).toBe(401);
 const login=await app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}}),cookie=login.headers['set-cookie'] as string;
 expect((await app.inject({url:'/api/notifications/history?before=bad',headers:{cookie}})).statusCode).toBe(400);
 const response=await app.inject({url:'/api/notifications/history?before='+id,headers:{cookie}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({producerEnabled:false,deliveryEnabled:false,items:[]});expect(store.history).toHaveBeenCalledWith(installation,id);expect(store.preview).not.toHaveBeenCalled();expect(store.save).not.toHaveBeenCalled();
});
it('cannot arm a producer or configure an outbound endpoint through dashboard settings',async()=>{
 const {app,store}=setup(),headers={authorization:'Bearer '+'e'.repeat(32)};
 for(const extra of [{producerEnabled:true},{liveFromAt:window.from},{webhookUrl:'http://127.0.0.1/secret'}])expect((await app.inject({method:'PUT',url:'/api/notifications/settings',headers,payload:{expectedRevision:0,configuration,...extra}})).statusCode).toBe(400);
 expect(store.save).not.toHaveBeenCalled();
});
