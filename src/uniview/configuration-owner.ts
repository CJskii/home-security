import type { Config } from '../config.js';
import { z } from 'zod';
import { ConfigurationRefreshBusy } from './zone-sync.js';
export const refreshResultSchema=z.object({channels:z.array(z.object({channel:z.number().int().min(1).max(2),status:z.enum(['SYNCED','FAILED'])}).strict()).min(1).max(2)}).strict().refine(v=>new Set(v.channels.map(c=>c.channel)).size===v.channels.length);
// No API-local NVR poller or writer. Manual conflicts are rejected by the owner.
export function createConfigurationOwnerClient(config:Config,request:typeof fetch=fetch) {
  let active:Promise<z.infer<typeof refreshResultSchema>['channels']>|undefined;
  const controller=new AbortController();
  return {
    refresh(channel?:number, rejectOverlap=false) {
      if(channel!==undefined && ![1,2].includes(channel))return Promise.reject(new Error('Unknown camera channel'));
      if(active)return rejectOverlap?Promise.reject(new ConfigurationRefreshBusy()):active;
      if(!config.CAMERA_SYNC_OWNER_URL || !config.CAMERA_SYNC_TOKEN) return Promise.reject(new Error('Configuration owner unavailable'));
      active=(async()=>{
        const response=await request(new URL('/internal/cameras/configuration/refresh'+(channel===undefined?'':`/${channel}`),config.CAMERA_SYNC_OWNER_URL),{
          method:'POST',headers:{authorization:`Bearer ${config.CAMERA_SYNC_TOKEN}`},redirect:'error',
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(55000)])});
        if(![200,503].includes(response.status)){await response.body?.cancel();if(response.status===409)throw new ConfigurationRefreshBusy();throw new Error('Configuration owner unavailable');}
        // Only two fixed result records, never arbitrary receiver responses.
        const reader=response.body?.getReader();if(!reader)throw new Error('Invalid configuration response');
        const chunks:Uint8Array[]=[];let length=0;
        try { for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>2048)throw new Error('Invalid configuration response');chunks.push(next.value);} }
        finally { await reader.cancel(); }
        const bytes=Buffer.concat(chunks).toString('utf8');
        const result=refreshResultSchema.parse(JSON.parse(bytes)).channels;
        const expected=channel===undefined?[1,2]:[channel];
        if(result.length!==expected.length || result.some(r=>!expected.includes(r.channel)))throw new Error('Invalid configuration response');
        return result;
      })().finally(()=>{active=undefined;});return active;
    },
    async close(){controller.abort();await active?.catch(()=>{});},
  };
}
