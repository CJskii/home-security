import { afterEach, expect, it, vi } from 'vitest';
import { createStreamDiscovery, STREAM_METADATA_TTL_MS } from '../src/uniview/verified-streams.js';
import { createUniviewClient, type VideoStreamSettings } from '../src/uniview/snapshot-client.js';
import { buildApp } from '../src/app.js';
import { config } from './uniview-fixtures.js';
import { streamFixture } from './stream-fixtures.js';
const settings={...config,UNIVIEW_CAMERA_MAP:{'1':'camera_1','2':'camera_2'},UNIVIEW_USERNAME:'test',UNIVIEW_PASSWORD:'secret'};
const json=(Data:unknown)=>new Response(JSON.stringify({Response:{ResponseCode:0,StatusCode:0,Data}}),{headers:{'content-type':'application/json'}});
function setup(live=false){
 let time=0;const source=streamFixture();const client={videoStreams:vi.fn(async()=>structuredClone(source)),liveStreamReference:vi.fn(async()=>({URL:'rtsp://private:secret@internal/source'}))};
 const discovery=createStreamDiscovery({...settings,LIVE_GATEWAY_ENABLED:live},client,()=>time);
 return {source,client,discovery,advance:(ms=STREAM_METADATA_TTL_MS)=>{time+=ms;}};
}
afterEach(()=>vi.useRealTimers());
it('uses fixed read-only Digest transport endpoints and strips unneeded source properties',async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(json({...streamFixture(),privateURL:'rtsp://secret'})).mockResolvedValueOnce(json({URL:'rtsp://private/source'}));
 const client=createUniviewClient(settings,request);expect(await client.videoStreams(1)).toEqual(streamFixture());await client.liveStreamReference(2,1);
 expect(request.mock.calls.map(([url])=>String(url))).toEqual(['http://10.0.0.1/LAPI/V1.0/Channels/1/Media/Video/Streams/DetailInfos','http://10.0.0.1/LAPI/V1.0/Channels/2/Media/Video/Streams/1/LiveStreamURL?TransProtocol=0']);
 expect(request.mock.calls.every(([,o])=>o?.method==='GET')).toBe(true);
 await expect(client.liveStreamReference(1,3)).rejects.toMatchObject({code:'invalid_request'});
});
it('bounds and validates stream configuration responses',async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(json({...streamFixture(),Num:3})).mockResolvedValueOnce(new Response('x'.repeat(131073),{headers:{'content-type':'application/json'}}));
 const client=createUniviewClient(settings,request);await expect(client.videoStreams(1)).rejects.toMatchObject({code:'invalid_response'});await expect(client.videoStreams(1)).rejects.toMatchObject({code:'limit'});
});
it('refreshes codec/resolution/FPS/enabled without restart after five minutes and preserves logical IDs',async()=>{
 const f=setup();const first=await f.discovery.get(1);expect(first.discovery).toMatchObject({state:'fresh',stale:false});expect(first.profiles[0]).toMatchObject({id:'main',videoCodec:'hevc',fps:25});
 expect(first.profiles[2]!.enabled).toBe(false);expect(first.profiles[1]).toMatchObject({sampleFps:null,approximateBitrateBps:null,rtsp:{referenceAvailable:true,reachability:'unprobed'}});
 f.source.VideoStreamInfos[0]!.VideoEncodeInfo={EncodeFormat:1,Resolution:{Width:1920,Height:1080},FrameRate:15};f.source.VideoStreamInfos[0]!.Enabled=0;
 expect((await f.discovery.get(1)).profiles[0]!.fps).toBe(25);expect(f.client.videoStreams).toHaveBeenCalledOnce();f.advance();
 const changed=await f.discovery.get(1);expect(changed.profiles[0]).toMatchObject({id:'main',videoCodec:'h264',width:1920,height:1080,fps:15,enabled:false});expect(f.client.videoStreams).toHaveBeenCalledTimes(2);await f.discovery.close();
});
it('marks stale results, backs off failures and recovers without erasing last-known values',async()=>{
 const f=setup();await f.discovery.get(1);f.advance();f.client.videoStreams.mockRejectedValueOnce(new Error('private credential error'));
 const stale=await f.discovery.get(1);expect(stale.discovery).toMatchObject({state:'stale',stale:true,reason:'nvr_unavailable'});expect(stale.profiles[0]!.width).toBe(3840);
 await f.discovery.get(1);expect(f.client.videoStreams).toHaveBeenCalledTimes(2);f.advance(30000);expect((await f.discovery.get(1)).discovery.state).toBe('fresh');await f.discovery.close();
});
it('does not invent metadata when configuration or optional fields are absent',async()=>{
 const f=setup();f.client.videoStreams.mockRejectedValueOnce(new Error('secret'));const unavailable=await f.discovery.get(1);expect(unavailable).toMatchObject({profiles:[],discovery:{state:'unavailable',stale:false}});
 f.advance(30000);f.source.VideoStreamInfos=[{ID:0,Enabled:1,VideoEncodeInfo:{EncodeFormat:998}},{ID:0,MainStreamType:1,VideoEncodeInfo:{EncodeFormat:1}}];f.source.Num=2;
 const current=await f.discovery.get(1);expect(current.profiles[0]).toMatchObject({videoCodec:null,fps:null,width:null,configured:{encodeFormat:998,bitRate:null}});expect(current.profiles[1]!.configurationState).toBe('not_reported');await f.discovery.close();
});
it('coalesces simultaneous refreshes and bounds cross-channel requests with clean shutdown',async()=>{
 const f=setup();f.client.videoStreams.mockImplementation(()=>new Promise((resolve)=>{setTimeout(()=>resolve(streamFixture()),10);}));
 await Promise.all([f.discovery.get(1),f.discovery.get(1),f.discovery.get(2)]);expect(f.client.videoStreams).toHaveBeenCalledTimes(2);await f.discovery.close();expect((await f.discovery.get(1)).discovery.state).toBe('unavailable');
});
it('handles ambiguous normal-main rows and URL failures without claiming stream reachability',async()=>{
 const f=setup();f.source.VideoStreamInfos.push({...f.source.VideoStreamInfos[0]!});f.source.Num++;
 f.client.liveStreamReference.mockRejectedValue(new Error('secret'));const result=await f.discovery.get(1);
 expect(result.profiles[0]).toMatchObject({configurationState:'ambiguous',videoCodec:null,fps:null,rtsp:{referenceAvailable:null,reachability:'unprobed'}});expect(JSON.stringify(result)).not.toContain('secret');await f.discovery.close();
});
it('authenticates discovery before NVR reads and exposes only logical gateway URLs',async()=>{
 const f=setup(true);const authConfig={...settings,EVENTS_TOKEN:'e'.repeat(32),LIVE_GATEWAY_ENABLED:true};
 const app=buildApp(authConfig,{checkReady:async()=>{},disconnect:async()=>{}},undefined,undefined,f.discovery).app;
 try{
  expect((await app.inject('/api/cameras/camera_1/streams')).statusCode).toBe(401);expect(f.client.videoStreams).not.toHaveBeenCalled();
  const response=await app.inject({url:'/api/cameras/camera_1/streams',headers:{authorization:'Bearer '+'e'.repeat(32)}});expect(response.statusCode).toBe(200);expect(response.json().profiles[1].playback.endpoint).toBe('/api/live/ws?src=camera_1_sub');expect(response.body).not.toMatch(/rtsp:|secret|internal/);expect(response.json().profiles[0].playback.endpoint).toBeNull();
  expect((await app.inject({url:'/api/cameras/unknown/streams',headers:{authorization:'Bearer '+'e'.repeat(32)}})).statusCode).toBe(404);
 }finally{await app.close();}
});
it('caps metadata entries, never accepts an unconfigured channel, and isolates caller mutations',async()=>{
 const f=setup();const first=await f.discovery.get(1);first.profiles[0]!.width=7;expect((await f.discovery.get(1)).profiles[0]!.width).toBe(3840);
 expect((await f.discovery.get(3)).profiles).toEqual([]);expect(f.client.videoStreams).toHaveBeenCalledOnce();await f.discovery.close();
 const client=f.client,channels=Object.fromEntries(Array.from({length:9},(_,i)=>[String(i+1),'camera_'+(i+1)]));
 const bounded=createStreamDiscovery({...settings,UNIVIEW_CAMERA_MAP:channels},client);
 for(let channel=1;channel<=9;channel++)await bounded.get(channel);
 const before=client.videoStreams.mock.calls.length;await bounded.get(1);expect(client.videoStreams.mock.calls.length).toBe(before+1);await bounded.close();
});
it('aborts a refresh on shutdown without retaining partial metadata',async()=>{
 const f=setup();
 const client={videoStreams:vi.fn(async(channel:number,signal?:AbortSignal)=>{void channel;return new Promise<VideoStreamSettings>((_resolve,reject)=>{signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}),liveStreamReference:f.client.liveStreamReference};
 const discovery=createStreamDiscovery(settings,client);const request=discovery.get(1);await vi.waitFor(()=>expect(client.videoStreams).toHaveBeenCalledOnce());await discovery.close();expect((await request).discovery.state).toBe('unavailable');
});
