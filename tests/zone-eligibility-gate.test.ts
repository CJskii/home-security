import {expect,it,vi} from 'vitest';
import {createZoneEligibilityGate} from '../src/ai/zone-eligibility-gate.js';
import {createZoneEligibilityStore,ELIGIBILITY_OBJECT_LIMIT,type EligibilityMetadata} from '../src/ai/zone-eligibility-store.js';
import {geometryFingerprint} from '../src/uniview/zone-geometry.js';
import type {PrismaClient} from '../src/generated/prisma/client.js';
import type {AccessZoneConfiguration} from '../src/uniview/client-schemas.js';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,installation=uuid(1),eventId=uuid(2),at=new Date('2026-10-20T18:00:00Z');
const polygon=[{X:2000,Y:2000},{X:7000,Y:2000},{X:7000,Y:8000},{X:2000,Y:8000}];
function fixture(channel=1):EligibilityMetadata {
 const catalog=Array.from({length:4},(_,slot)=>({id:uuid(slot+10),zoneId:uuid(slot+20),slot,revision:2,channel,sourceInstallationId:installation,enabled:slot===0,ruleEnabled:true,polygon:slot===0?polygon:[],name:`Slot ${slot}`,interested:slot!==0,observedAt:new Date(+at-600000),lastObservedAt:new Date(+at-300000),nameEffectiveAt:new Date(+at-600000)}));
 return {savedAt:at,truncated:false,proposal:{enabled:true,uncertain:'analyse',unmatched:'exclude',zones:catalog.map(z=>({zoneId:z.zoneId,enabled:z.slot===0}))},catalog,event:{id:eventId,sourceInstallationId:installation,channel,objects:[{id:uuid(40),eventId,sourceList:'StructureInfo.ObjInfo.PersonInfoList',category:'PERSON',sourceIdentifiers:{PersonID:3},coordinateStatus:'VALID',sourceTimestamp:at,fullFrameSnapshotId:uuid(41),xMin:8000,xMax:9000,yMin:3000,yMax:5000}]}};
}
function live(data:EligibilityMetadata):AccessZoneConfiguration{return {Rule:{Enabled:1},Areas:{Num:4,PolygonInfoList:data.catalog.map(z=>({ID:z.slot,Enabled:z.enabled?1:0,PointNum:z.polygon.length,PointList:z.polygon}))}};}
it('confirms fresh NVR geometry before excluding, uses saved settings and never extends a shared/historical snapshot',async()=>{
 const data=fixture(),before=structuredClone(data),read=vi.fn(async()=>data),accessZone=vi.fn(async()=>live(data));
 const gate=createZoneEligibilityGate(installation,{read},{accessZone},undefined,()=>new Date(+at+100));
 expect(await gate(eventId,new AbortController().signal)).toMatchObject({eligible:false,reason:'zone_not_selected'});
 expect(accessZone).toHaveBeenCalledWith(1,expect.any(AbortSignal));expect(data).toEqual(before);
 data.proposal.zones[0]!.enabled=false;data.proposal.zones[1]!.enabled=true;data.catalog[1]!.polygon=polygon;data.catalog[1]!.enabled=true;
 Object.assign(data.event.objects[0]!,{xMin:4000,xMax:5000});
 expect(await gate(eventId,new AbortController().signal)).toMatchObject({eligible:true,reason:'selected_zone'});
});
it('keeps NVR mismatches, missing settings, truncation, invalid metadata and failed reads eligible',async()=>{
 const data=fixture(),nvr={accessZone:vi.fn(async()=>({...live(data),Rule:{Enabled:0 as const}}))};
 expect(await createZoneEligibilityGate(installation,{read:async()=>data},nvr)(eventId,new AbortController().signal)).toMatchObject({eligible:true,reason:'zone_configuration_changed'});
 nvr.accessZone.mockRejectedValueOnce(new Error('unavailable'));
 expect((await createZoneEligibilityGate(installation,{read:async()=>data},nvr)(eventId,new AbortController().signal)).eligible).toBe(true);
 for(const value of[null,{...data,truncated:true},{...data,proposal:{...data.proposal,uncertain:'exclude' as const}}]){
  expect((await createZoneEligibilityGate(installation,{read:async()=>value},nvr)(eventId,new AbortController().signal)).eligible).toBe(true);
 }
 const off={...data,proposal:{...data.proposal,enabled:false}};expect(await createZoneEligibilityGate(installation,{read:async()=>off},nvr)(eventId,new AbortController().signal)).toMatchObject({eligible:false,reason:'ai_disabled'});
});
it('uses historical brackets without applying current geometry backwards and supports Camera 2 / vehicles / multiple objects',async()=>{
 const data=fixture(2),nvr={accessZone:vi.fn(async()=>live(data))};
 data.catalog.forEach(z=>{z.lastObservedAt=new Date(+at+10000);});
 const first=data.event.objects[0]!;first.category='MOTOR_VEHICLE';first.sourceList='StructureInfo.ObjInfo.VehicleInfoList';first.sourceIdentifiers={ID:3};
 const gate=createZoneEligibilityGate(installation,{read:async()=>data},nvr);
 expect((await gate(eventId,new AbortController().signal)).eligible).toBe(false);expect(nvr.accessZone).not.toHaveBeenCalled();
 data.event.objects.push({...first,id:uuid(50),xMin:4000,xMax:5000});expect((await gate(eventId,new AbortController().signal)).reason).toBe('selected_zone');
 data.event.objects.forEach(o=>{o.sourceTimestamp=new Date(+at-900000);});expect((await gate(eventId,new AbortController().signal)).reason).toBe('zone_uncertain_fallback');expect(nvr.accessZone).not.toHaveBeenCalled();
});
it('reads saved policy, complete object observations and source versions in one scoped repeatable-read transaction',async()=>{
 const data=fixture();const findFirst=vi.fn(async()=>({...data.event,nvrChannel:1})),findMany=vi.fn(async()=>data.catalog.map(z=>({...z,displayName:z.name,zone:{sourceInstallationId:installation,channel:1,slot:z.slot,preference:{interested:true}}}))),saved=vi.fn(async()=>({configuration:data.proposal,updatedAt:at}));
 const tx={securityEvent:{findFirst},univiewZoneVersion:{findMany},aiProcessingProposal:{findUnique:saved}},transaction=vi.fn(async(work:(t:typeof tx)=>Promise<unknown>,options:unknown)=>{expect(options).toBeDefined();return work(tx);});
 const store=createZoneEligibilityStore({$transaction:transaction} as unknown as PrismaClient);
 const result=await store.read(installation,eventId);expect(result?.event.objects).toHaveLength(1);expect(result?.proposal.zones[0]?.enabled).toBe(true);
 expect(transaction.mock.calls[0]?.[1]).toMatchObject({isolationLevel:'RepeatableRead',timeout:2000});
 expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:eventId,sourceInstallationId:installation},select:expect.objectContaining({objects:expect.objectContaining({take:ELIGIBILITY_OBJECT_LIMIT+1})})}));
 expect(findMany).toHaveBeenCalledWith(expect.objectContaining({where:{zone:{sourceInstallationId:installation}}}));
 saved.mockResolvedValueOnce(null as never);expect(await store.read(installation,eventId)).toBeNull();
 const before=structuredClone(data.proposal);data.catalog[0]!.revision=3;data.catalog[0]!.polygon=[...polygon,{X:1000,Y:5000}];await store.read(installation,eventId);expect(data.proposal).toEqual(before);
 expect(geometryFingerprint(polygon)).toMatch(/^[a-f0-9]{64}$/);
});
it('distinguishes a synthetic four-vertex walkway from a five-vertex neighbour and protects their shared boundary',async()=>{
 const data=fixture(2);data.catalog.forEach(z=>{z.lastObservedAt=new Date(+at+10000);});
 data.catalog[0]!.polygon=[{X:2500,Y:1000},{X:5000,Y:1000},{X:5000,Y:9000},{X:2500,Y:9000}];
 data.catalog[1]!.enabled=true;data.catalog[1]!.polygon=[{X:5000,Y:1000},{X:9500,Y:1000},{X:9500,Y:5000},{X:8500,Y:9000},{X:5000,Y:9000}];
 const nvr={accessZone:vi.fn(async()=>live(data))},gate=createZoneEligibilityGate(installation,{read:async()=>data},nvr),object=data.event.objects[0]!;
 Object.assign(object,{xMin:3000,xMax:4000});expect((await gate(eventId,new AbortController().signal)).reason).toBe('selected_zone');
 Object.assign(object,{xMin:6000,xMax:7000});expect((await gate(eventId,new AbortController().signal)).reason).toBe('zone_not_selected');
 Object.assign(object,{xMin:4800,xMax:5200});expect((await gate(eventId,new AbortController().signal)).reason).toBe('zone_uncertain_fallback');expect(nvr.accessZone).not.toHaveBeenCalled();
});
it('handles driveway vehicles on a concave six-vertex region and preserves settings through a source geometry revision',async()=>{
 const data=fixture();data.catalog.forEach(z=>{z.lastObservedAt=new Date(+at+500);});
 data.catalog[0]!.polygon=[{X:2000,Y:2000},{X:7000,Y:2000},{X:7000,Y:8000},{X:5000,Y:8000},{X:5000,Y:6000},{X:2000,Y:6000}];
 const object=data.event.objects[0]!;Object.assign(object,{category:'MOTOR_VEHICLE',sourceList:'StructureInfo.ObjInfo.VehicleInfoList',sourceIdentifiers:{ID:3},xMin:3000,xMax:4000});
 const saved=structuredClone(data.proposal),gate=createZoneEligibilityGate(installation,{read:async()=>data},{accessZone:vi.fn()});
 expect((await gate(eventId,new AbortController().signal)).reason).toBe('selected_zone');
 const revised=data.catalog.map(z=>({...z,id:uuid(100+z.slot),revision:3,observedAt:new Date(+at+1000),nameEffectiveAt:new Date(+at+1000),lastObservedAt:new Date(+at+3000),polygon:z.slot===0?[{X:7000,Y:1000},{X:9500,Y:1000},{X:9500,Y:9000},{X:7000,Y:9000}]:z.polygon}));
 data.catalog.push(...revised);expect((await gate(eventId,new AbortController().signal)).reason).toBe('selected_zone'); // Old event still uses v2.
 object.sourceTimestamp=new Date(+at+2000);expect((await gate(eventId,new AbortController().signal)).reason).toBe('zone_not_selected');expect(data.proposal).toEqual(saved);
});
