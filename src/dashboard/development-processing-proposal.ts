import { z } from 'zod';
import type { Config } from '../config.js';
import { processingProposalInput,type ProcessingProposalStore } from '../ai/processing-proposal.js';
const responseSchema=z.object({enforcementAvailable:z.literal(false),available:z.boolean(),writable:z.boolean(),updatedAt:z.iso.datetime().nullable(),configuration:processingProposalInput,
  zones:z.array(z.object({zoneId:z.uuid(),channel:z.number().int().min(1).max(2),slot:z.number().int().min(0).max(3),name:z.string().max(128),interested:z.boolean()}).strict()).max(8),
  latestRecordedAnalysis:z.object({model:z.string().max(128),promptVersion:z.number().int(),schemaVersion:z.number().int(),completedAt:z.iso.datetime()}).strict().nullable(),
  recent:z.array(z.object({status:z.string().max(32),reason:z.string().max(64).nullable(),count:z.number().int().nonnegative()}).strict()).max(128),metricsWindowHours:z.literal(24)}).strict();
// Same fixed loopback metadata-write pattern as local zone preferences. The SQL
// pool stays read-only, bearer stays server-side, and no runtime switch is exposed.
export function developmentProcessingProposalWriter(config:Config,token:string|undefined,request:typeof fetch=fetch):ProcessingProposalStore['save'] {
  if(!token||!/^[A-Za-z0-9_-]{32,256}$/.test(token))return undefined;
  return async(installation,input)=>{
    if(installation!==config.UNIVIEW_INSTALLATION_ID)throw new Error('Unknown AI proposal scope');
    const value=processingProposalInput.parse(input),response=await request('http://127.0.0.1:3000/api/ai/processing',{
      method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(7000)});
    if(!response.ok){await response.body?.cancel();throw new Error('AI settings unavailable. Compatible API and proposal migration required.');}
    const reader=response.body?.getReader();if(!reader)throw new Error('AI settings unavailable');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw new Error('AI settings response too large');chunks.push(next.value);}}
    finally{await reader.cancel();}
    return responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  };
}
