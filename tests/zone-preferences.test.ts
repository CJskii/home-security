import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createZonePreferenceStore, ZonePreferenceConflict } from '../src/uniview/zone-preferences.js';
import { createZoneSynchronizer, ZONE_SYNC_INTERVAL_MS } from '../src/uniview/zone-sync.js';
import { observedZones } from '../src/uniview/zones.js';
import { developmentPreferenceWriter } from '../src/dashboard/development-zone-preferences.js';
import { buildDevelopmentApp } from '../src/dashboard/development.js';
import { zoneDatabase, configuration, installation, at } from './zone-fixtures.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(apps.splice(0).map(x=>x.app.close()));});
const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',UNIVIEW_INSTALLATION_ID:installation,UNIVIEW_CAMERA_MAP:'{"1":"camera_1","2":"camera_2"}',EVENTS_TOKEN:'e'.repeat(32),DASHBOARD_ORIGIN:'http://127.0.0.1:5173',DASHBOARD_PASSWORD:'p'.repeat(32),DASHBOARD_SESSION_KEY:'a'.repeat(64),LOG_LEVEL:'silent'});
async function fixture(){const f=zoneDatabase();await f.store.observe(installation,1,observedZones(configuration()),at(0));const prefs=createZonePreferenceStore(f.prisma),zone=f.state().zones[0]!,fingerprint=f.state().versions[0]!.geometryFingerprint;return{...f,prefs,zone,input:{displayName:'Local entrance',interested:true,expectedGeometryFingerprint:fingerprint}};}
it('stores local preferences without changing source rows or versions and makes unchanged saves idempotent',async()=>{
 const f=await fixture(),before=structuredClone(f.state());const first=await f.prefs.save(installation,1,f.zone.id,f.input);
 expect(first).toMatchObject({zoneId:f.zone.id,displayName:'Local entrance',interested:true});
 expect(f.state().zones).toEqual(before.zones);expect(f.state().versions).toEqual(before.versions);
 expect(await f.prefs.save(installation,1,f.zone.id,f.input)).toEqual(first);expect(f.state().preferences).toHaveLength(1);
 expect(await f.prefs.list(installation,2)).toEqual([]);
 expect(await f.prefs.save(installation,2,f.zone.id,f.input)).toBeNull();expect(await f.prefs.save('27b01e57-cc3d-4db5-9bdd-f7d89e8149bb',1,f.zone.id,f.input)).toBeNull();
 await expect(f.prefs.save(installation,1,f.zone.id,{...f.input,expectedGeometryFingerprint:'a'.repeat(64)})).rejects.toBeInstanceOf(ZonePreferenceConflict);
 expect(f.state().preferences).toHaveLength(1);
});
it('preserves local preferences through manual and scheduled synchronization, geometry changes and disabled rules',async()=>{
 const f=await fixture();await f.prefs.save(installation,1,f.zone.id,f.input);const original=structuredClone(f.state().preferences);
 let next=configuration();const sync=createZoneSynchronizer(f.store,{accessZone:async()=>next},installation,[1],vi.fn());
 await sync.refresh();expect(f.state().preferences).toEqual(original);
 vi.useFakeTimers();sync.start();await sync.refresh();const count=f.state().versions.length;
 const points=[{X:100,Y:100},{X:9900,Y:100},{X:9900,Y:9900},{X:5000,Y:9900},{X:100,Y:7000}];
 next={...configuration(),Areas:{Num:4,PolygonInfoList:configuration().Areas.PolygonInfoList.map((z,i)=>i===0?{...z,PointNum:5,PointList:points}:z)}};
 await vi.advanceTimersByTimeAsync(ZONE_SYNC_INTERVAL_MS);await sync.refresh();
 expect(f.state().versions.length).toBe(count+1);expect(f.state().preferences).toEqual(original);
 next={...next,Areas:{...next.Areas,PolygonInfoList:next.Areas.PolygonInfoList.map((z,i)=>i===0?{...z,Enabled:0 as const}:z)}};
 await sync.refresh();expect(f.state().versions.filter(v=>v.zoneId===f.zone.id).at(-1)?.enabled).toBe(false);
 expect(f.state().preferences).toEqual(original);await sync.close();
});
it('accepts clearing local names, validates fields, and reports unavailable old development schema without hiding source zones',async()=>{
 const f=await fixture();const p=await f.prefs.save(installation,1,f.zone.id,{...f.input,displayName:' '});expect(p?.displayName).toBeNull();
 for(const input of [{...f.input,displayName:'bad\nname'},{...f.input,enabled:false},{...f.input,interested:'true'}])await expect(f.prefs.save(installation,1,f.zone.id,input as typeof f.input)).rejects.toThrow();
 const missing=createZonePreferenceStore({zonePreference:{findMany:async()=>{throw{code:'P2021'};}}} as unknown as PrismaClient);
 const service=buildApp(config,{zones:f.store,zonePreferences:missing,checkReady:async()=>{},disconnect:async()=>{}});apps.push(service);
 const r=await service.app.inject({url:'/api/cameras/camera_1/zones',headers:{authorization:'Bearer '+config.EVENTS_TOKEN}});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({preferencesAvailable:false,zones:expect.any(Array)});
});
it('requires a same-origin session or trusted bearer, validates camera ownership and keeps legacy source rename inaccessible to sessions',async()=>{
 const f=await fixture(),service=buildApp(config,{zones:f.store,zonePreferences:f.prefs,checkReady:async()=>{},disconnect:async()=>{}});apps.push(service);
 const url=`/api/cameras/camera_1/zones/${f.zone.id}/preferences`;
 expect((await service.app.inject({method:'PATCH',url,payload:f.input})).statusCode).toBe(401);
 const login=await service.app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}}),cookie=login.headers['set-cookie'] as string;
 for(const headers of[{cookie},{cookie,origin:'https://evil.example'},{cookie,origin:config.DASHBOARD_ORIGIN!,'sec-fetch-site':'cross-site'}])expect([401,403]).toContain((await service.app.inject({method:'PATCH',url,headers,payload:f.input})).statusCode);
 const headers={cookie,origin:config.DASHBOARD_ORIGIN!};expect((await service.app.inject({method:'PATCH',url,headers,payload:f.input})).statusCode).toBe(200);
 expect((await service.app.inject({url:'/api/cameras/camera_1/zones',headers})).json()).toMatchObject({preferencesAvailable:true,zones:[{preference:{displayName:'Local entrance',interested:true}},...Array.from({length:3},()=>expect.any(Object))]});
 expect((await service.app.inject({method:'PATCH',url:url.replace('camera_1','camera_2'),headers,payload:f.input})).statusCode).toBe(404);
 expect((await service.app.inject({method:'PATCH',url,headers,payload:{...f.input,polygon:[]}})).statusCode).toBe(400);
 expect((await service.app.inject({method:'PATCH',url,headers,payload:{...f.input,expectedGeometryFingerprint:'a'.repeat(64)}})).statusCode).toBe(409);
 expect((await service.app.inject({method:'PATCH',url:url.replace('/preferences',''),headers,payload:{name:'Source change'}})).statusCode).toBe(401);
 expect(f.state().versions).toHaveLength(4);
});
it('forwards only scoped local-preference writes to the fixed loopback API with server-only credentials',async()=>{
 const f=await fixture(),request=vi.fn<typeof fetch>(async()=>Response.json({preference:{zoneId:f.zone.id,displayName:'Local entrance',interested:true,updatedAt:new Date().toISOString()}})),writer=developmentPreferenceWriter(config,'s'.repeat(32),request)!;
 expect(developmentPreferenceWriter(config,undefined,request)).toBeUndefined();await writer(installation,1,f.zone.id,f.input);
 expect(String(request.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:3000/api/cameras/camera_1/zones/${f.zone.id}/preferences`);expect(request.mock.calls[0]?.[1]).toMatchObject({method:'PATCH',redirect:'error',headers:{authorization:'Bearer '+'s'.repeat(32)}});
 await expect(writer('27b01e57-cc3d-4db5-9bdd-f7d89e8149bb',1,f.zone.id,f.input)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 request.mockResolvedValueOnce(new Response(null,{status:409}));await expect(writer(installation,1,f.zone.id,f.input)).rejects.toBeInstanceOf(ZonePreferenceConflict);
 const save=vi.fn(writer),service=buildDevelopmentApp({...config,EVENTS_TOKEN:undefined},{zones:f.store,zonePreferences:{list:f.prefs.list,save},historicalImages:{load:async()=>null,save:async()=>false},checkReady:async()=>{},disconnect:async()=>{}});apps.push(service);
 const login=await service.app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}});
 expect((await service.app.inject({method:'PATCH',url:`/api/cameras/camera_1/zones/${f.zone.id}/preferences`,headers:{cookie:login.headers['set-cookie'] as string,origin:config.DASHBOARD_ORIGIN!},payload:f.input})).statusCode).toBe(200);expect(save).toHaveBeenCalledOnce();
 expect((await service.app.inject({method:'POST',url:'/api/events/'+f.zone.id+'/enrich'})).statusCode).toBe(405);
});
