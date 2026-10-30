import {afterEach,expect,it,vi} from 'vitest';
import {createCameraConfigurationStore,configurationStatus} from '../src/uniview/camera-configuration.js';
import {createZoneSynchronizer,ZONE_SYNC_INTERVAL_MS} from '../src/uniview/zone-sync.js';
import {createConfigurationOwnerClient} from '../src/uniview/configuration-owner.js';
import {createUniviewClient} from '../src/uniview/snapshot-client.js';
import {observedZones} from '../src/uniview/zones.js';
import {buildApp} from '../src/app.js';
import {buildReceiver} from '../src/uniview/app.js';
import {loadConfig} from '../src/config.js';
import {config as receiverConfig,fixtureStore} from './uniview-fixtures.js';
import {zoneDatabase,configuration,installation,at} from './zone-fixtures.js';
const streams={Num:1,VideoStreamInfos:[{ID:1,Enabled:1 as const,VideoEncodeInfo:{EncodeFormat:1,FrameRate:25,Resolution:{Width:1280,Height:720}}}]};
const snapshot={name:'NVR channel name',streams};
const apps:{close():Promise<void>}[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.useRealTimers();});
it('commits configuration with zone history atomically; identical checks update observation times only',async()=>{
 const f=zoneDatabase(),store=createCameraConfigurationStore(f.prisma),zones=observedZones(configuration());
 await store.observe(installation,1,zones,snapshot,at(0));
 const original=structuredClone(f.state().versions);
 await store.observe(installation,1,zones,snapshot,at(1));
 expect(f.state().versions).toHaveLength(4);expect(f.state().versions.map(v=>v.id)).toEqual(original.map(v=>v.id));
 expect(f.snapshotUpdates.at(-1)).not.toHaveProperty('snapshot');
 expect((await store.get(installation,1))?.lastSuccessfulAt).toEqual(at(1));
 const invalid=structuredClone(zones);invalid[1]!.polygon=[];
 const before=structuredClone(f.state());await expect(store.observe(installation,1,invalid,{...snapshot,name:'Bad'},at(2))).rejects.toThrow();expect(f.state()).toEqual(before);
 await store.failed(installation,1,at(2));expect(configurationStatus(await store.get(installation,1),at(2).getTime())).toMatchObject({state:'stale',lastSuccessfulAt:at(1).toISOString()});
 expect((await store.get(installation,1))?.snapshot).toEqual(snapshot);
});
it('versions multi-vertex and rule changes, preserves coordinate order and rejects invalid geometry',async()=>{
 const f=zoneDatabase(),raw=configuration();const polygon=[{X:100,Y:100},{X:5000,Y:100},{X:9000,Y:4000},{X:8000,Y:9000},{X:100,Y:8000}];
 raw.Areas.PolygonInfoList[0]!.PointNum=5;raw.Areas.PolygonInfoList[0]!.PointList=polygon;
 await f.store.observe(installation,1,observedZones(raw),at(0));expect(f.state().versions[0]!.polygon).toEqual(polygon);
 raw.Areas.PolygonInfoList[0]!.Sensitivity=75;await f.store.observe(installation,1,observedZones(raw),at(1));expect(f.state().versions).toHaveLength(5);
 await f.store.observe(installation,1,observedZones(raw),at(2));expect(f.state().versions).toHaveLength(5);
 raw.Areas.PolygonInfoList[0]!.Name='NVR rule';await f.store.observe(installation,1,observedZones(raw),at(3));expect(f.state().versions.at(-1)?.displayName).toBe('NVR rule');
 expect(f.state().versions[0]!.displayName).toBe('Channel 1 zone 0');
 raw.Areas.PolygonInfoList[0]!.PointList=[polygon[0]!,polygon[2]!,polygon[4]!,polygon[1]!,polygon[3]!];expect(()=>observedZones(raw)).toThrow();
});
it('refreshes full metadata on the existing ten-minute timer; failures retain the snapshot and do not block other channels',async()=>{
 vi.useFakeTimers();const f=zoneDatabase(),store=createCameraConfigurationStore(f.prisma);
 const client={accessZone:vi.fn(async()=>configuration()),cameraName:vi.fn(async()=>snapshot.name),videoStreams:vi.fn(async()=>streams)};
 const sync=createZoneSynchronizer(f.store,client,installation,[1,2],vi.fn(),()=>new Date(),{store,client});
 expect(ZONE_SYNC_INTERVAL_MS).toBe(600000);sync.start();const first=sync.refresh();expect(sync.refresh()).toBe(first);await first;
 expect(f.state().configurations).toHaveLength(2);client.videoStreams.mockRejectedValueOnce(new Error('private failure'));
 await vi.advanceTimersByTimeAsync(600000);expect(f.state().configurations[0]?.failed).toBe(true);expect(f.state().configurations[1]?.failed).toBe(false);
 expect(f.state().versions).toHaveLength(8);await sync.close();
});
it('forwards one bounded fixed operation to the receiver, without redirects or browser credentials',async()=>{
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',CAMERA_SYNC_OWNER_URL:'http://receiver:18080/',CAMERA_SYNC_TOKEN:'s'.repeat(32)});
 let resolve!:(r:Response)=>void;
 const request=vi.fn<typeof fetch>(()=>new Promise(r=>{resolve=r;})),owner=createConfigurationOwnerClient(config,request);
 const first=owner.refresh();expect(owner.refresh()).toBe(first);expect(request).toHaveBeenCalledOnce();
 expect(String(request.mock.calls[0]![0])).toBe('http://receiver:18080/internal/cameras/configuration/refresh');
 expect(request.mock.calls[0]![1]).toMatchObject({method:'POST',redirect:'error'});
 resolve(new Response(JSON.stringify({channels:[{channel:1,status:'SYNCED'},{channel:2,status:'FAILED'}]}),{status:503}));expect(await first).toHaveLength(2);await owner.close();
});
it('serves synchronized names and profiles from persistence only, keeping identifiers and playback URLs stable',async()=>{
 const f=zoneDatabase(),store=createCameraConfigurationStore(f.prisma);await store.observe(installation,1,observedZones(configuration()),snapshot,new Date());
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',UNIVIEW_INSTALLATION_ID:installation,UNIVIEW_CAMERA_MAP:'{"1":"camera_1","2":"camera_2"}',EVENTS_TOKEN:'e'.repeat(32),LIVE_GATEWAY_ENABLED:'true',LOG_LEVEL:'silent'});
 const get=vi.fn(async()=>{throw new Error('API must not poll NVR');});
 const {app}=buildApp(config,{cameraConfiguration:store,zones:f.store,checkReady:async()=>{},disconnect:async()=>{}},undefined,undefined,{get,close:async()=>{}});apps.push(app);
 const headers={authorization:'Bearer '+'e'.repeat(32)};
 const cameras=(await app.inject({url:'/api/cameras',headers})).json();expect(cameras.cameras[0]).toMatchObject({id:'camera_1',name:snapshot.name,synchronization:{state:'fresh'}});
 const result=(await app.inject({url:'/api/cameras/camera_1/streams',headers})).json();expect(result.profiles[1]).toMatchObject({enabled:true,videoCodec:'h264',width:1280,height:720,fps:25,playback:{endpoint:'/api/live/ws?src=camera_1_sub'}});expect(get).not.toHaveBeenCalled();
});
it('requires a same-origin authenticated session for the sole dashboard mutation',async()=>{
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',DASHBOARD_ORIGIN:'http://127.0.0.1:5173',DASHBOARD_PASSWORD:'p'.repeat(32),DASHBOARD_SESSION_KEY:'a'.repeat(64),LOG_LEVEL:'silent'});
 const refresh=vi.fn(async()=>[{channel:1,status:'SYNCED' as const},{channel:2,status:'SYNCED' as const}]);
 const {app}=buildApp(config,{checkReady:async()=>{},disconnect:async()=>{}},undefined,undefined,undefined,{refresh,close:async()=>{}});apps.push(app);
 const url='/api/cameras/configuration/refresh';expect((await app.inject({method:'POST',url})).statusCode).toBe(401);
 const login=await app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}});
 const cookie=login.headers['set-cookie'] as string;
 expect((await app.inject({method:'POST',url,headers:{cookie}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://evil.test'}})).statusCode).not.toBe(200);
 expect((await app.inject({method:'POST',url,headers:{cookie,origin:config.DASHBOARD_ORIGIN!}})).statusCode).toBe(200);expect(refresh).toHaveBeenCalledOnce();
 expect((await app.inject({method:'POST',url:'/api/events/'+installation+'/enrich',headers:{cookie,origin:config.DASHBOARD_ORIGIN!}})).statusCode).toBe(401);
});
it('receiver control rejects unauthorized/parameterized operations before refresh and shares its existing synchronizer',async()=>{
 const f=zoneDatabase(),config={...receiverConfig,CAMERA_SYNC_TOKEN:'s'.repeat(32)},store=createCameraConfigurationStore(f.prisma);
 const sync=createZoneSynchronizer(f.store,{accessZone:async()=>configuration()},installation,[1,2],vi.fn());
 const refresh=vi.spyOn(sync,'refresh');const {app}=buildReceiver(config,{uniview:fixtureStore().store,cameraConfiguration:store,checkReady:async()=>{},disconnect:async()=>{}},undefined,sync);apps.push(app);
 const url='/internal/cameras/configuration/refresh';await app.ready();
 expect((await app.inject({method:'POST',url})).statusCode).toBe(401);
 const headers={authorization:'Bearer '+'s'.repeat(32)};
 expect((await app.inject({method:'POST',url:url+'?url=evil',headers})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url,headers,payload:'{}'})).statusCode).toBe(400);
 expect(refresh).not.toHaveBeenCalled();expect((await app.inject({method:'POST',url,headers})).statusCode).toBe(200);expect(refresh).toHaveBeenCalledOnce();
});
it('reads only the configured OSD channel name through the authenticated existing transport',async()=>{
 const request=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({Response:{ResponseCode:0,StatusCode:0,Data:{Num:1,ContentList:[{ID:0,ContentInfo:[{ContentType:12,Value:'Camera name'},{ContentType:1,Value:'Do not use text'}]}]}}}),{headers:{'content-type':'application/json'}}));
 const client=createUniviewClient({...receiverConfig,UNIVIEW_USERNAME:'test',UNIVIEW_PASSWORD:'secret'},request);
 expect(await client.cameraName(1)).toBe('Camera name');expect(String(request.mock.calls[0]![0])).toContain('/Channels/1/Media/OSDs');expect(request.mock.calls[0]![1]?.method).toBe('GET');
});

it('refreshes a selected channel and rejects overlapping manual work without starting another NVR read',async()=>{
 const f=zoneDatabase();let finish!:(v:ReturnType<typeof configuration>)=>void;
 const accessZone=vi.fn<(channel:number)=>Promise<ReturnType<typeof configuration>>>(()=>new Promise(r=>{finish=r;}));
 const sync=createZoneSynchronizer(f.store,{accessZone},installation,[1,2],vi.fn());
 const first=sync.refresh(2,true);
 await expect(sync.refresh(1,true)).rejects.toThrow('already in progress');
 expect(accessZone).toHaveBeenCalledOnce();expect(accessZone.mock.calls[0]?.[0]).toBe(2);
 finish(configuration());expect(await first).toEqual([{channel:2,status:'SYNCED'}]);
 await expect(sync.refresh(3,true)).rejects.toThrow('Unknown camera');await sync.close();
});
it('forwards only a validated selected channel and propagates receiver conflicts',async()=>{
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',CAMERA_SYNC_OWNER_URL:'http://receiver:18080/',CAMERA_SYNC_TOKEN:'s'.repeat(32)});
 const request=vi.fn<typeof fetch>(async()=>Response.json({channels:[{channel:2,status:'SYNCED'}]}));
 const owner=createConfigurationOwnerClient(config,request);
 expect(await owner.refresh(2,true)).toEqual([{channel:2,status:'SYNCED'}]);
 expect(String(request.mock.calls[0]![0])).toBe('http://receiver:18080/internal/cameras/configuration/refresh/2');
 request.mockResolvedValueOnce(new Response(null,{status:409}));await expect(owner.refresh(undefined,true)).rejects.toThrow('already in progress');
 request.mockResolvedValueOnce(Response.json({channels:[{channel:1,status:'SYNCED'}]}));await expect(owner.refresh(2,true)).rejects.toThrow('Invalid configuration response');
 await owner.close();
});
it('session refresh selects configured cameras, rejects overlaps and forbids arbitrary selections',async()=>{
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',UNIVIEW_CAMERA_MAP:'{"1":"camera_1","2":"camera_2"}',DASHBOARD_ORIGIN:'http://127.0.0.1:5173',DASHBOARD_PASSWORD:'p'.repeat(32),DASHBOARD_SESSION_KEY:'a'.repeat(64),LOG_LEVEL:'silent'});
 let finish!:(v:{channel:number;status:'SYNCED'}[])=>void;
 const refresh=vi.fn(()=>new Promise<{channel:number;status:'SYNCED'}[]>(r=>{finish=r;}));
 const {app}=buildApp(config,{checkReady:async()=>{},disconnect:async()=>{}},undefined,undefined,undefined,{refresh,close:async()=>{}});apps.push(app);
 const login=await app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}});
 const headers={cookie:login.headers['set-cookie'] as string,origin:config.DASHBOARD_ORIGIN!};const url='/api/cameras/configuration/refresh';
 expect((await app.inject({method:'POST',url,headers,payload:{cameraId:'http://untrusted'}})).statusCode).toBe(404);
 expect((await app.inject({method:'POST',url,headers,payload:{channel:1}})).statusCode).toBe(400);
 const first=app.inject({method:'POST',url,headers,payload:{cameraId:'camera_2'}});void first.then(()=>{});
 await vi.waitFor(()=>expect(refresh).toHaveBeenCalledOnce());expect(refresh).toHaveBeenCalledWith(2,true);
 expect((await app.inject({method:'POST',url,headers})).statusCode).toBe(409);
 finish([{channel:2,status:'SYNCED'}]);expect((await first).statusCode).toBe(200);
});
it('receiver rejects manual conflicts with startup synchronization',async()=>{
 const f=zoneDatabase(),store=createCameraConfigurationStore(f.prisma);let finish!:(v:ReturnType<typeof configuration>)=>void;
 const accessZone=vi.fn<(channel:number)=>Promise<ReturnType<typeof configuration>>>(()=>new Promise(r=>{finish=r;}));
 const sync=createZoneSynchronizer(f.store,{accessZone},installation,[1,2],vi.fn());
 const first=sync.refresh(1);const {app}=buildReceiver({...receiverConfig,CAMERA_SYNC_TOKEN:'s'.repeat(32)},{uniview:fixtureStore().store,cameraConfiguration:store,checkReady:async()=>{},disconnect:async()=>{}},undefined,sync);apps.push(app);
 const reply=await app.inject({method:'POST',url:'/internal/cameras/configuration/refresh/2',headers:{authorization:'Bearer '+'s'.repeat(32)}});
 expect(reply.statusCode).toBe(409);expect(accessZone).toHaveBeenCalledOnce();finish(configuration());await first;
});
it('a scheduled full pass following a selected-camera read still covers the other channel',async()=>{
 vi.useFakeTimers();const f=zoneDatabase();const accessZone=vi.fn<(channel:number)=>Promise<ReturnType<typeof configuration>>>(async()=>configuration());
 const sync=createZoneSynchronizer(f.store,{accessZone},installation,[1,2],vi.fn());
 sync.start();await sync.refresh();await vi.advanceTimersByTimeAsync(599000);
 let finish!:(v:ReturnType<typeof configuration>)=>void;
 accessZone.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const selected=sync.refresh(2,true);
 await vi.advanceTimersByTimeAsync(1000);expect(accessZone).toHaveBeenCalledTimes(3);
 finish(configuration());await selected;await vi.advanceTimersByTimeAsync(0);
 expect(accessZone.mock.calls.map(([channel])=>channel)).toEqual([1,2,2,1,2]);await sync.close();
});
