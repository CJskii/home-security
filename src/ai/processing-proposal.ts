import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ObjectLocation } from '../uniview/object-location.js';
const fallback=z.enum(['analyse','exclude']);
export const processingProposalInput=z.object({
  enabled:z.boolean(),unmatched:fallback,uncertain:fallback,
  zones:z.array(z.object({zoneId:z.uuid(),enabled:z.boolean()}).strict()).max(8),
}).strict().refine(v=>new Set(v.zones.map(z=>z.zoneId)).size===v.zones.length,{message:'Duplicate zone'});
export type ProcessingProposal=z.infer<typeof processingProposalInput>;
export interface ProcessingProposalStore {
  read(installation:string):Promise<unknown>;
  save?:(installation:string,input:ProcessingProposal)=>Promise<unknown>;
}
// Dry-run only; deliberately not imported by ingestion/evidence/receiver.
export function previewEligibility(proposal:ProcessingProposal,objects:readonly ObjectLocation[]) {
  if(!proposal.enabled)return {eligible:false,reason:'ai_disabled'};
  const selected=new Set(proposal.zones.filter(z=>z.enabled).map(z=>z.zoneId));
  if(objects.some(o=>o.status==='MATCHED'&&o.matches.some(z=>selected.has(z.zoneId))))return {eligible:true,reason:'selected_zone'};
  if(!objects.length||objects.some(o=>o.status==='UNKNOWN'||o.status==='AMBIGUOUS'))return {eligible:proposal.uncertain==='analyse',reason:proposal.uncertain==='analyse'?'uncertain_fallback':'zone_uncertain_not_selected'};
  if(objects.some(o=>o.status==='UNMATCHED'))return {eligible:proposal.unmatched==='analyse',reason:proposal.unmatched==='analyse'?'unmatched_fallback':'zone_unmatched_not_selected'};
  return {eligible:false,reason:'zone_not_selected'};
}
export function createProcessingProposalStore(prisma:PrismaClient):ProcessingProposalStore {
  async function read(installation:string) {
    const zones=await prisma.univiewZone.findMany({where:{sourceInstallationId:installation},include:{preference:true},orderBy:[{channel:'asc'},{slot:'asc'}],take:8});
    let saved:null|{configuration:unknown;updatedAt:Date}=null,available=true;
    try{saved=await prisma.aiProcessingProposal.findUnique({where:{sourceInstallationId:installation}});}
    catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='P2021')available=false;else throw error;}
    const parsed=processingProposalInput.safeParse(saved?.configuration);
    const latest=await prisma.eventAnalysis.findFirst({where:{event:{sourceInstallationId:installation}},orderBy:{completedAt:'desc'},select:{model:true,promptVersion:true,schemaVersion:true,completedAt:true}});
    const counts=await prisma.evidenceProcessing.groupBy({by:['status','reason'],where:{startedAt:{gte:new Date(Date.now()-86400000)},event:{sourceInstallationId:installation}},_count:true});
    // Legacy field describes API activation capability, never receiver runtime status.
    return {enforcementAvailable:false,available,updatedAt:saved?.updatedAt.toISOString()??null,
      configuration:parsed.success?parsed.data:{enabled:true,unmatched:'exclude',uncertain:'analyse',zones:zones.map(z=>({zoneId:z.id,enabled:(z.channel===1||z.channel===2)&&z.slot===0}))},
      zones:zones.map(z=>({zoneId:z.id,channel:z.channel,slot:z.slot,name:z.preference?.displayName??z.displayName,interested:z.preference?.interested??false})),
      latestRecordedAnalysis:latest?{...latest,completedAt:latest.completedAt.toISOString()}:null,
      recent:counts.map(c=>({status:c.status,reason:c.reason,count:c._count})),metricsWindowHours:24};
  }
  return {read,async save(installation,input){
    const value=processingProposalInput.parse(input);
    await prisma.$transaction(async tx=>{
      const zones=await tx.univiewZone.findMany({where:{sourceInstallationId:installation},select:{id:true},take:9});
      if(value.zones.length!==zones.length||zones.some(z=>!value.zones.some(v=>v.zoneId===z.id)))throw new Error('Zone catalog changed');
      const previous=await tx.aiProcessingProposal.findUnique({where:{sourceInstallationId:installation}});
      if(previous&&isDeepStrictEqual(previous.configuration,value))return;
      await tx.aiProcessingProposal.upsert({where:{sourceInstallationId:installation},create:{sourceInstallationId:installation,configuration:value},update:{configuration:value}});
    },{isolationLevel:'Serializable',timeout:5000});
    return read(installation);
  }};
}
