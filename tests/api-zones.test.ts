import {afterEach,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {zoneDatabase,configuration,installation,at} from './zone-fixtures.js';
import {observedZones} from '../src/uniview/zones.js';
const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',EVENTS_TOKEN:'e'.repeat(32),LOG_LEVEL:'silent',UNIVIEW_INSTALLATION_ID:installation,UNIVIEW_CAMERA_MAP:'{"1":"camera_1","2":"camera_2"}'});
const headers={authorization:'Bearer '+'e'.repeat(32)};
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(s=>s.app.close()));});
async function setup(){
 const f=zoneDatabase();await f.store.observe(installation,1,observedZones(configuration()),at(0));await f.store.observe(installation,2,observedZones(configuration()),at(0));
 const refresh=vi.fn<()=>Promise<{channel:number;status:'SYNCED'|'FAILED'}[]>>(async()=>[{channel:1,status:'SYNCED' as const},{channel:2,status:'SYNCED' as const}]),close=vi.fn(async()=>{});
 const app=buildApp(config,{zones:f.store,checkReady:async()=>{},disconnect:async()=>{}},undefined,undefined,undefined,{refresh,close});apps.push(app);
 return {...f,...app,refresh,close,id:f.state().zones[0]!.id};
}
it('authenticates zone name and refresh operations before side effects',async()=>{
 const f=await setup();
 expect((await f.app.inject({method:'PATCH',url:`/api/cameras/camera_1/zones/${f.id}`,payload:{name:'Driveway'}})).statusCode).toBe(401);
 expect((await f.app.inject({method:'POST',url:'/api/cameras/zones/refresh'})).statusCode).toBe(401);expect(f.refresh).not.toHaveBeenCalled();expect(f.state().versions).toHaveLength(8);
});
it('renames locally, preserves history and makes repeated naming idempotent',async()=>{
 const f=await setup(),url=`/api/cameras/camera_1/zones/${f.id}`;
 const response=await f.app.inject({method:'PATCH',url,headers:{...headers},payload:{name:' Driveway '}});
 expect(response.statusCode).toBe(200);expect(response.json()).toEqual({id:f.id,slot:0,name:'Driveway',configurationChanged:false});expect(f.state().versions).toHaveLength(9);
 expect(f.state().versions[0]!.displayName).toBe('Channel 1 zone 0');
 expect((await f.app.inject({method:'PATCH',url,headers:{...headers},payload:{name:'Driveway'}})).statusCode).toBe(200);expect(f.state().versions).toHaveLength(9);expect(f.refresh).not.toHaveBeenCalled();
});
it('checks camera/zone ownership and rejects attempts to change NVR geometry or invalid names',async()=>{
 const f=await setup();
 expect((await f.app.inject({method:'PATCH',url:`/api/cameras/camera_2/zones/${f.id}`,headers:{...headers},payload:{name:'Elsewhere'}})).statusCode).toBe(404);
 expect((await f.app.inject({method:'PATCH',url:`/api/cameras/unknown/zones/${f.id}`,headers:{...headers},payload:{name:'Name'}})).statusCode).toBe(404);
 for(const payload of [{name:' '},{name:'x',polygon:[]},{name:'bad\nname'}])expect((await f.app.inject({method:'PATCH',url:`/api/cameras/camera_1/zones/${f.id}`,headers:{...headers},payload})).statusCode).toBe(400);
 expect(f.state().versions).toHaveLength(8);
});
it('refreshes through the existing synchronizer and exposes partial failure without private errors',async()=>{
 const f=await setup();const url='/api/cameras/zones/refresh';
 expect((await f.app.inject({method:'POST',url,headers:{...headers},payload:{}})).statusCode).toBe(200);expect(f.refresh).toHaveBeenCalledOnce();
 f.refresh.mockResolvedValueOnce([{channel:1,status:'SYNCED'},{channel:2,status:'FAILED'}]);
 const partial=await f.app.inject({method:'POST',url,headers:{...headers}});expect(partial.statusCode).toBe(503);expect(partial.json().channels[1].status).toBe('FAILED');
 f.refresh.mockRejectedValueOnce(new Error('private database password'));const failed=await f.app.inject({method:'POST',url,headers:{...headers}});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('password');
 await f.app.close();expect(f.close).toHaveBeenCalledOnce();
});
it('fails closed when the deployment lacks persistence/NVR configuration',async()=>{
 const app=buildApp(config,{checkReady:async()=>{},disconnect:async()=>{}});apps.push(app);
 expect((await app.app.inject({method:'POST',url:'/api/cameras/zones/refresh',headers:{...headers}})).statusCode).toBe(503);
 expect((await app.app.inject({method:'PATCH',url:'/api/cameras/camera_1/zones/'+installation,headers:{...headers},payload:{name:'Name'}})).statusCode).toBe(503);
});
