import type { Config } from '../config.js';
import { createUniviewClient, type UniviewClient, type VideoStreamSettings } from './snapshot-client.js';
export const STREAM_METADATA_TTL_MS = 300_000;
const FAILURE_RETRY_MS = 30_000;
const roles = ['main','sub','third'] as const;
const MAX_CACHED_CHANNELS = 8;
function remember<T>(map:Map<number,T>,channel:number,value:T) {
  if (!map.has(channel) && map.size>=MAX_CACHED_CHANNELS) map.delete(map.keys().next().value!);
  map.set(channel,value);
}
type StreamClient = Pick<UniviewClient,'videoStreams'|'liveStreamReference'>;
export function streamProfiles(config:Config,channel:number,settings:VideoStreamSettings,rtsp:(boolean|null)[],observedAt:string) {
  return roles.map((role,profile)=>{
    // ID 0/MainStreamType 1 is an alternate main configuration, not another live profile.
    const matching=settings.VideoStreamInfos.filter((s)=>s.ID===profile && (s.MainStreamType===undefined || s.MainStreamType===0));
    const source=matching.length===1 ? matching[0] : undefined, encode=source?.VideoEncodeInfo;
    const videoCodec=encode?.EncodeFormat===1 ? 'h264' : encode?.EncodeFormat===2 ? 'hevc' : null;
    return {id:role,role,profile,quality:profile===0?'high':profile===1?'low':'auxiliary',enabled:source?.Enabled===undefined?null:source.Enabled===1,
      configurationState:matching.length>1?'ambiguous':source?'available':'not_reported',
      videoCodec,width:encode?.Resolution?.Width??null,height:encode?.Resolution?.Height??null,fps:encode?.FrameRate??null,
      configured:{encodeFormat:encode?.EncodeFormat??null,fps:encode?.FrameRate??null,bitRate:encode?.BitRate??null,bitRateType:encode?.BitRateType??null,
        bitrateUnit:'source_native',bitrateMode:null,mainStreamType:source?.MainStreamType??null},
      // Configuration reads cannot establish measured FPS, throughput, audio, or reachability.
      sampleFps:null,approximateBitrateBps:null,audioCodec:null,
      rtsp:{referenceAvailable:rtsp[profile]??null,reachability:'unprobed'},
      verification:{source:'nvr_lapi_configuration',observedAt,fpsBasis:'configured',currentHealth:'unmonitored'},
      browserCompatibility:videoCodec==='h264'?'h264_video_remux':videoCodec==='hevc'?'requires_client_hevc_support':'unknown',
      playback:{state:config.LIVE_GATEWAY_ENABLED && role==='sub' && [1,2].includes(channel)?'configured_unverified':'gateway_not_configured',protocol:'mse_websocket',videoOnly:true,
        endpoint:config.LIVE_GATEWAY_ENABLED && role==='sub' && [1,2].includes(channel)?`/api/live/ws?src=camera_${channel}_${role}`:null,authentication:'same_origin_authenticated_session_proxy'},
    };
  });
}
interface Cached { profiles:ReturnType<typeof streamProfiles>; refreshedAt:string; expires:number }
export interface StreamMetadata { profiles:ReturnType<typeof streamProfiles>;health:string;discovery:{state:string;stale:boolean;refreshedAt:string|null;ttlSeconds:number;reason:string|null} }
export interface StreamDiscovery { get(channel:number):Promise<StreamMetadata>;close():Promise<void> }
export function createStreamDiscovery(config:Config,supplied?:StreamClient,now:()=>number=Date.now):StreamDiscovery {
  const client=supplied??(config.UNIVIEW_NVR_IP&&config.UNIVIEW_USERNAME&&config.UNIVIEW_PASSWORD?createUniviewClient(config):undefined);
  const cache=new Map<number,Cached>(),pending=new Map<number,Promise<StreamMetadata>>(),retryAt=new Map<number,number>();
  const allowed=new Set(Object.keys(config.UNIVIEW_CAMERA_MAP).map(Number));
  const controllers=new Set<AbortController>();let stopped=false;
  function result(entry:Cached|undefined,state:string,reason:string|null):StreamMetadata {
    return {profiles:entry?structuredClone(entry.profiles):[],health:'unmonitored',discovery:{state,stale:!!entry&&state==='stale',refreshedAt:entry?.refreshedAt??null,ttlSeconds:STREAM_METADATA_TTL_MS/1000,reason}};
  }
  return {
    get(channel) {
      if (!allowed.has(channel) || stopped) return Promise.resolve(result(undefined,'unavailable','not_available'));
      const entry=cache.get(channel);
      if (entry && now()<entry.expires) return Promise.resolve(result(entry,'fresh',null));
      const running=pending.get(channel);if(running)return running;
      if (!client) return Promise.resolve(result(entry,'unavailable','nvr_not_configured'));
      if(now()<(retryAt.get(channel)??0))return Promise.resolve(result(entry,entry?'stale':'unavailable','nvr_unavailable'));
      // Bound channels in memory and concurrent refreshes; only configured cameras are admitted.
      if(pending.size>=2)return Promise.resolve(result(entry,entry?'stale':'unavailable','busy'));
      const controller=new AbortController();controllers.add(controller);
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
      const task=(async()=>{
        try {
          const settings=await client.videoStreams(channel,signal), references:(boolean|null)[]=[];
          for(let profile=0;profile<3;profile++){
            if(signal.aborted)throw new Error('Refresh aborted');
            try {const ref=await client.liveStreamReference(channel,profile,signal);references.push(new URL(ref.URL).protocol==='rtsp:');}
            catch {references.push(null);}
          }
          if(signal.aborted)throw new Error('Refresh aborted');
          const refreshedAt=new Date(now()).toISOString(),next={profiles:streamProfiles(config,channel,settings,references,refreshedAt),refreshedAt,expires:now()+STREAM_METADATA_TTL_MS};
          remember(cache,channel,next);retryAt.delete(channel);return result(next,'fresh',null);
        } catch {remember(retryAt,channel,now()+FAILURE_RETRY_MS);return result(entry,entry?'stale':'unavailable','nvr_unavailable');}
      })().finally(()=>{pending.delete(channel);controllers.delete(controller);});
      pending.set(channel,task);return task;
    },
    async close(){stopped=true;controllers.forEach((c)=>c.abort());await Promise.allSettled(pending.values());cache.clear();retryAt.clear();},
  };
}
export function cameras(config:Config) {
  return Object.entries(config.UNIVIEW_CAMERA_MAP).map(([channel,name])=>({id:name,name,channel:Number(channel),
    profilesVerified:false,defaultProfile:'sub',streamHealth:'unmonitored',
    streamsUrl:`/api/cameras/${encodeURIComponent(name)}/streams`,zonesUrl:`/api/cameras/${encodeURIComponent(name)}/zones` })).sort((a,b)=>a.channel-b.channel);
}
