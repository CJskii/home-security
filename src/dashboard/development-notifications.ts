import { z } from 'zod';
import type { Config } from '../config.js';
import type { NotificationStore } from '../notifications/store.js';
import { notificationSave,notificationArchive,notificationSettingsResponse,evaluationMetadata } from '../notifications/contracts.js';
// Fixed metadata-only operations, matching the existing preference/proposal bridge.
// No arbitrary path, media URL, target address or browser credential forwarding.
export function developmentNotificationWriter(config:Config,token:string|undefined,request:typeof fetch=fetch):Pick<NotificationStore,'save'|'archive'> {
  if(!token||!/^[A-Za-z0-9_-]{32,256}$/.test(token))return {};
  async function forward(installation:string,path:'settings'|'evaluations',method:'PUT'|'POST',value:unknown){
    if(installation!==config.UNIVIEW_INSTALLATION_ID)throw new Error('Unknown notification scope');
    const response=await request('http://127.0.0.1:3000/api/notifications/'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw new Error('Compatible notification API and migration required');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing notification response');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw new Error('Notification response too large');chunks.push(next.value);}}
    finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  return {save:async(installation,expectedRevision,configuration)=>notificationSettingsResponse.parse(await forward(installation,'settings','PUT',notificationSave.parse({expectedRevision,configuration}))),
    archive:async(installation,window,expectedRevision,fingerprint)=>evaluationMetadata.extend({deliveryAvailable:z.literal(false)}).strict().parse(await forward(installation,'evaluations','POST',notificationArchive.parse({...window,expectedRevision,fingerprint})))};
}
