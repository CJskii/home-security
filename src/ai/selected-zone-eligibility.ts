import type { ProcessingProposal } from './processing-proposal.js';
import { locateObject, rectangleSchema, type LocationObject, type LocationZone } from '../uniview/object-location.js';
import { distanceToPolygonEdge, pointInPolygon, rectangleMembership } from '../uniview/zone-geometry.js';

export interface EligibilityObservation extends LocationObject {
  id:string;eventId:string;category:string;sourceList:string;
  sourceIdentifiers:Record<string,unknown>;
}
interface ObservationDecision {
  id:string;status:'inside'|'outside'|'uncertain';reason:string;
  versionIds:string[];outsideAll?:boolean;coveredBy?:string;
}
export interface ZoneEligibilityDecision {
  eligible:boolean;reason:string;
  observations:ObservationDecision[];
}
// Receiver enforcement is separately armed by AI_ZONE_SELECTION_ENABLED;
// saving the proposal through the API cannot activate the receiver switch.
// Correspondence is scoped to one canonical event; UUIDs/observations are never merged.
export function previewSelectedZoneEligibility(proposal:ProcessingProposal,
  event:{id:string;sourceInstallationId:string;channel:number;objects:EligibilityObservation[]},
  catalog:readonly LocationZone[]):ZoneEligibilityDecision {
  if(!proposal.enabled)return {eligible:false,reason:'ai_disabled',observations:[]};
  const selectedIds=new Set(proposal.zones.filter(z=>z.enabled).map(z=>z.zoneId));
  if(proposal.zones.some(z=>z.enabled&&!catalog.some(v=>v.zoneId===z.zoneId&&v.sourceInstallationId===event.sourceInstallationId)))
    return {eligible:proposal.uncertain==='analyse',reason:'zone_uncertain_fallback',observations:event.objects.map(o=>({id:o.id,status:'uncertain',reason:'missing_selected_configuration',versionIds:[]}))};
  const versions=catalog.filter(z=>z.sourceInstallationId===event.sourceInstallationId&&z.channel===event.channel);
  const decisions:ObservationDecision[]=event.objects.map(o=>{
    const unknown=(reason:string):ObservationDecision=>({id:o.id,status:'uncertain',reason,versionIds:[]});
    if(o.eventId!==event.id)return unknown('event_scope_mismatch');
    // Reuse the established rectangle, image-anchor and historical coverage checks.
    const history=locateObject(o,versions);
    if(history.status==='UNKNOWN')return unknown(history.reason);
    const applicable=versions.filter(z=>history.evaluatedVersionIds.includes(z.id));
    const selected=applicable.filter(z=>selectedIds.has(z.zoneId)&&z.enabled&&z.ruleEnabled);
    const rectangle=rectangleSchema.parse(o),bottom={X:(rectangle.xMin+rectangle.xMax)/2,Y:rectangle.yMax},centre={X:bottom.X,Y:(rectangle.yMin+rectangle.yMax)/2};
    const active=applicable.filter(z=>z.enabled&&z.ruleEnabled);
    const versionIds=applicable.map(z=>z.id);
    if(selected.some(z=>pointInPolygon(bottom,z.polygon)&&pointInPolygon(centre,z.polygon)
      &&distanceToPolygonEdge(bottom,z.polygon)>100&&distanceToPolygonEdge(centre,z.polygon)>100)
      &&rectangle.xMin!==0&&rectangle.xMax!==10000&&rectangle.yMax!==10000)
      return {id:o.id,status:'inside',reason:'selected_anchor_consensus',versionIds};
    const overlap=selected.some(z=>rectangleMembership(rectangle,z.polygon)!=='OUTSIDE'
      ||distanceToPolygonEdge(bottom,z.polygon)<=100||distanceToPolygonEdge(centre,z.polygon)<=100);
    if(overlap||rectangle.xMin===0||rectangle.xMax===10000||rectangle.yMax===10000)
      return {id:o.id,status:'uncertain',reason:overlap?'selected_polygon_overlap_or_boundary':'clipped_rectangle',versionIds};
    return {id:o.id,status:'outside',reason:'disjoint_selected_polygons',versionIds,
      outsideAll:active.every(z=>rectangleMembership(rectangle,z.polygon)==='OUTSIDE')};
  });
  // Related ObjectID -> PersonID / vehicle ID only. No fuzzy IDs, ordinals,
  // proximity, face IDs, cross-event matching or unvalidated identity reassignment.
  for(const [index,report] of event.objects.entries()) {
    if(report.eventId!==event.id||report.sourceList!=='RelatedObjects.ObjectList'||report.coordinateStatus!=='MISSING')continue;
    const native=identifier(report.sourceIdentifiers.ObjectID);
    if(native===null||!report.sourceTimestamp)continue;
    const matches=event.objects.flatMap((candidate,i)=>{
      const key=candidate.category==='PERSON'&&candidate.sourceList==='StructureInfo.ObjInfo.PersonInfoList'?'PersonID'
        :['MOTOR_VEHICLE','NON_MOTOR_VEHICLE'].includes(candidate.category)&&['StructureInfo.ObjInfo.VehicleInfoList','StructureInfo.ObjInfo.NonMotorVehicleInfoList'].includes(candidate.sourceList)?'ID':null;
      return key&&candidate.eventId===event.id&&candidate.category===report.category
        &&identifier(candidate.sourceIdentifiers[key])===native&&candidate.sourceTimestamp
        &&Math.abs(candidate.sourceTimestamp.getTime()-report.sourceTimestamp!.getTime())<=1000?[i]:[];
    });
    if(matches.length!==1)continue;
    const target=decisions[matches[0]!]!;
    if(target.status==='uncertain')continue;
    decisions[index]={...target,id:report.id,coveredBy:target.id,reason:'exact_same_event_nvr_identifier'};
  }
  if(decisions.some(d=>d.status==='inside'))return {eligible:true,reason:'selected_zone',observations:decisions};
  if(!decisions.length||decisions.some(d=>d.status==='uncertain'))return {eligible:proposal.uncertain==='analyse',reason:proposal.uncertain==='analyse'?'zone_uncertain_fallback':'zone_uncertain_not_selected',observations:decisions};
  if(decisions.some(d=>d.outsideAll)&&proposal.unmatched==='analyse')return {eligible:true,reason:'zone_unmatched_fallback',observations:decisions};
  return {eligible:false,reason:'zone_not_selected',observations:decisions};
}
function identifier(value:unknown):string|null {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
  return typeof value==='string'&&value.length>0&&value.length<=256&&value!=='0'?value:null;
}
