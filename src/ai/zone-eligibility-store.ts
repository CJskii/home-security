import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { locationCatalog } from '../events/locations.js';
import { processingProposalInput, type ProcessingProposal } from './processing-proposal.js';
import type { EligibilityObservation } from './selected-zone-eligibility.js';
import type { LocationZone } from '../uniview/object-location.js';
export const ELIGIBILITY_OBJECT_LIMIT=128;
export interface EligibilityMetadata {
  proposal:ProcessingProposal;savedAt:Date;catalog:LocationZone[];
  event:{id:string;sourceInstallationId:string;channel:number;objects:EligibilityObservation[]};
  truncated:boolean;
}
export interface ZoneEligibilityStore { read(installation:string,eventId:string):Promise<EligibilityMetadata|null> }
// One repeatable-read snapshot pins settings, source UUIDs and zone versions.
// No AI target filtering, NVR operations, migrations or writes in this store.
export function createZoneEligibilityStore(prisma:PrismaClient):ZoneEligibilityStore {
  return {read:async(installation,eventId)=>{
    z.uuid().parse(installation);z.uuid().parse(eventId);
    return prisma.$transaction(async tx=>{
      const saved=await tx.aiProcessingProposal.findUnique({where:{sourceInstallationId:installation}});
      if(!saved)return null; // Unsaved UI defaults never arm production selection.
      const proposal=processingProposalInput.parse(saved.configuration);
      const catalog=await locationCatalog(tx,installation),zoneIds=new Set(catalog.map(z=>z.zoneId));
      if(proposal.zones.length!==zoneIds.size||proposal.zones.some(z=>!zoneIds.has(z.zoneId)))return null;
      const row=await tx.securityEvent.findFirst({where:{id:eventId,sourceInstallationId:installation},select:{id:true,sourceInstallationId:true,nvrChannel:true,
        objects:{take:ELIGIBILITY_OBJECT_LIMIT+1,orderBy:{id:'asc'},select:{id:true,eventId:true,category:true,sourceList:true,sourceIdentifiers:true,coordinateStatus:true,
          sourceTimestamp:true,timestampBasis:true,xMin:true,xMax:true,yMin:true,yMax:true,fullFrameSnapshotId:true}}}});
      if(!row)return null;
      return {proposal,savedAt:saved.updatedAt,catalog,truncated:row.objects.length>ELIGIBILITY_OBJECT_LIMIT,
        event:{id:row.id,sourceInstallationId:row.sourceInstallationId,channel:row.nvrChannel,objects:row.objects.slice(0,ELIGIBILITY_OBJECT_LIMIT).map(o=>({...o,sourceIdentifiers:z.record(z.string(),z.unknown()).parse(o.sourceIdentifiers)}))}};
    },{isolationLevel:'RepeatableRead',maxWait:1000,timeout:2000});
  }};
}
