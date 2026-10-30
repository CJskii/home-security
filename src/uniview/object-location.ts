import { z } from 'zod';
import { distanceToPolygonEdge, pointInPolygon, rectangleMembership, usablePolygon, type Rectangle, type Vertex } from './zone-geometry.js';
export const LOCATION_ALGORITHM = 'anchor_consensus_v1';
export const LOCATION_MARGIN = 100; // 1% of each NVR axis; a conservative edge band.
export interface LocationZone {
  id:string; zoneId:string; revision?:number; slot:number; channel:number; sourceInstallationId:string;
  enabled:boolean; ruleEnabled:boolean; polygon:Vertex[]; observedAt:Date; lastObservedAt:Date; nameEffectiveAt:Date;
  name:string; interested:boolean;
}
export interface LocationObject {
  category?:string;
  coordinateStatus:string; sourceTimestamp:Date|null; timestampBasis?:string;
  xMin:number|null;yMin:number|null;xMax:number|null;yMax:number|null;
  fullFrameSnapshotId?:string|null;
}
export type LocationStatus='MATCHED'|'AMBIGUOUS'|'UNMATCHED'|'UNKNOWN';
export interface ObjectLocation {
  status:LocationStatus;reason:string;algorithm:typeof LOCATION_ALGORITHM|'person_ground_point_v1';
  temporalBasis:'observed_configuration_bracket'; evaluatedVersionIds:string[];
  matches:{zoneId:string;versionId:string;revision?:number;slot:number;name:string;interested:boolean}[];
}
export const rectangleSchema=z.object({xMin:z.number().min(0).max(10000),yMin:z.number().min(0).max(10000),xMax:z.number().min(0).max(10000),yMax:z.number().min(0).max(10000)})
  .refine(r=>r.xMin<r.xMax&&r.yMin<r.yMax);
export function compareLocationMethods(rect:Rectangle,zones:readonly LocationZone[]) {
  const bottom={X:(rect.xMin+rect.xMax)/2,Y:rect.yMax},centre={X:bottom.X,Y:(rect.yMin+rect.yMax)/2};
  const active=zones.filter(z=>z.enabled&&z.ruleEnabled&&usablePolygon(z.polygon));
  return {bottom:active.filter(z=>pointInPolygon(bottom,z.polygon)),centre:active.filter(z=>pointInPolygon(centre,z.polygon)),
    overlap:active.filter(z=>rectangleMembership(rect,z.polygon)!=='OUTSIDE'),
    boundary:active.some(z=>distanceToPolygonEdge(bottom,z.polygon)<=LOCATION_MARGIN||distanceToPolygonEdge(centre,z.polygon)<=LOCATION_MARGIN)};
}
// Derived geometric location only. No Smart Search, source-rule assertions, AI,
// source mutations, identity merging or current-geometry fallback.
export function locateObject(object:LocationObject,versions:readonly LocationZone[],policy:'consensus'|'person_ground_point'='consensus'):ObjectLocation {
  const result:ObjectLocation={status:'UNKNOWN',reason:'missing_rectangle',algorithm:LOCATION_ALGORITHM,temporalBasis:'observed_configuration_bracket',evaluatedVersionIds:[],matches:[]};
  const parsed=rectangleSchema.safeParse(object);
  if(object.coordinateStatus!=='VALID'||!parsed.success)return result;
  if(!object.fullFrameSnapshotId)return {...result,reason:'missing_original_scene_anchor'};
  const time=object.sourceTimestamp?.getTime();
  if(time===undefined||!Number.isFinite(time))return {...result,reason:'missing_source_timestamp'};
  const applicable=versions.filter(z=>time>=z.observedAt.getTime()&&time>=z.nameEffectiveAt.getTime()&&time<=z.lastObservedAt.getTime());
  result.evaluatedVersionIds=applicable.map(z=>z.id);
  if(new Set(applicable.map(z=>z.slot)).size!==4||applicable.length!==4)return {...result,reason:'missing_or_conflicting_historical_configuration'};
  if(applicable.some(z=>z.enabled&&z.ruleEnabled&&!usablePolygon(z.polygon)))return {...result,reason:'invalid_historical_polygon'};
  const methods=compareLocationMethods(parsed.data,applicable);
  result.matches=methods.bottom.map(z=>({zoneId:z.zoneId,versionId:z.id,...(z.revision===undefined?{}:{revision:z.revision}),slot:z.slot,name:z.name,interested:z.interested}));
  // A person's ground position can enter a zone while their torso projects across
  // its boundary. Explicit opt-in keeps the receiver's AI policy unchanged.
  if(policy==='person_ground_point'&&object.category?.toUpperCase()==='PERSON'&&result.matches.length
    &&parsed.data.xMin!==0&&parsed.data.xMax!==10000&&parsed.data.yMax!==10000)
    return {...result,status:'MATCHED',reason:'person_ground_point',algorithm:'person_ground_point_v1'};
  const same=methods.bottom.length===methods.centre.length&&methods.bottom.every(z=>methods.centre.some(c=>c.id===z.id));
  if(!same||methods.boundary||parsed.data.xMin===0||[parsed.data.xMax,parsed.data.yMax].includes(10000))
    return {...result,status:'AMBIGUOUS',reason:!same?'anchor_disagreement':methods.boundary?'near_zone_boundary':'clipped_rectangle'};
  return {...result,status:result.matches.length?'MATCHED':'UNMATCHED',reason:result.matches.length?'anchor_consensus':'outside_enabled_zones'};
}
