import {expect,it} from 'vitest';
import {previewSelectedZoneEligibility,type EligibilityObservation} from '../src/ai/selected-zone-eligibility.js';
import type {LocationZone} from '../src/uniview/object-location.js';
const at=new Date('2026-10-20T18:00:00Z'),installation='installation',eventId='event';
const polygon=[{X:2000,Y:2000},{X:7000,Y:2000},{X:7000,Y:8000},{X:2000,Y:8000}];
const versions:LocationZone[]=Array.from({length:4},(_,slot)=>({id:`v${slot}`,zoneId:`z${slot}`,slot,channel:1,sourceInstallationId:installation,enabled:slot===0,ruleEnabled:true,polygon:slot===0?polygon:[],name:`Zone ${slot}`,interested:false,observedAt:new Date(+at-10000),lastObservedAt:new Date(+at+10000),nameEffectiveAt:new Date(+at-10000)}));
const proposal={enabled:true,unmatched:'exclude' as const,uncertain:'analyse' as const,zones:versions.map(z=>({zoneId:z.zoneId,enabled:z.slot===0}))};
const person:EligibilityObservation={id:'structure',eventId,category:'PERSON',sourceList:'StructureInfo.ObjInfo.PersonInfoList',sourceIdentifiers:{PersonID:42,PersonDoforFaceID:0},coordinateStatus:'VALID',sourceTimestamp:at,fullFrameSnapshotId:'original',xMin:4000,xMax:5000,yMin:3000,yMax:5000};
const event=(objects:EligibilityObservation[])=>({id:eventId,sourceInstallationId:installation,channel:1,objects});
it('keeps selected and boundary-overlapping objects, but excludes disjoint road objects independently of other zones',()=>{
 expect(previewSelectedZoneEligibility(proposal,event([person]),versions).reason).toBe('selected_zone');
 // Both anchors outside; bbox still overlaps the interested polygon at its edge.
 const edge={...person,xMin:1000,xMax:2500};
 expect(previewSelectedZoneEligibility(proposal,event([edge]),versions)).toMatchObject({eligible:true,reason:'zone_uncertain_fallback'});
 const road={...person,xMin:8000,xMax:9000};
 expect(previewSelectedZoneEligibility(proposal,event([road]),versions)).toMatchObject({eligible:false,reason:'zone_not_selected'});
 const otherZone=versions.map(z=>z.slot===1?{...z,enabled:true,polygon:[{X:7800,Y:0},{X:10000,Y:0},{X:10000,Y:10000},{X:7800,Y:10000}]}:z);
 expect(previewSelectedZoneEligibility(proposal,event([road]),otherZone).reason).toBe('zone_not_selected');
 expect(previewSelectedZoneEligibility({...proposal,unmatched:'analyse'},event([road]),versions).reason).toBe('zone_unmatched_fallback');
});
it('uses exact same-event source identifier correspondence without merging UUIDs',()=>{
 const road={...person,xMin:8000,xMax:9000};
 const report={...person,id:'related',sourceList:'RelatedObjects.ObjectList',sourceIdentifiers:{ObjectID:42},coordinateStatus:'MISSING',fullFrameSnapshotId:null,xMin:null,xMax:null,yMin:null,yMax:null};
 const input=event([road,report]),before=structuredClone(input),result=previewSelectedZoneEligibility(proposal,input,versions);
 expect(result.eligible).toBe(false);expect(result.observations).toHaveLength(2);expect(result.observations[1]).toMatchObject({id:'related',coveredBy:'structure',reason:'exact_same_event_nvr_identifier'});expect(input).toEqual(before);
 for(const patch of[{sourceIdentifiers:{ObjectID:99}},{sourceIdentifiers:{ObjectID:0}},{category:'MOTOR_VEHICLE'},{eventId:'other'},{sourceTimestamp:new Date(+at+1001)},{coordinateStatus:'INVALID'}])expect(previewSelectedZoneEligibility(proposal,event([road,{...report,...patch}]),versions).eligible).toBe(true);
 const duplicate={...road,id:'another'};expect(previewSelectedZoneEligibility(proposal,event([road,duplicate,report]),versions).eligible).toBe(true);
});
it('handles true multi-object events, historical gaps, missing frames and both camera scopes conservatively',()=>{
 const road={...person,id:'road',xMin:8000,xMax:9000};
 expect(previewSelectedZoneEligibility(proposal,event([road,person]),versions).reason).toBe('selected_zone');
 for(const objects of[[],[{...person,fullFrameSnapshotId:null}],[{...person,sourceTimestamp:new Date(+at-20000)}]] )expect(previewSelectedZoneEligibility(proposal,event(objects),versions).eligible).toBe(true);
 const cam2=versions.map(z=>({...z,channel:2}));
 expect(previewSelectedZoneEligibility(proposal,{...event([person]),channel:2},cam2).reason).toBe('selected_zone');
 expect(previewSelectedZoneEligibility({...proposal,enabled:false},event([person]),versions).reason).toBe('ai_disabled');
});
