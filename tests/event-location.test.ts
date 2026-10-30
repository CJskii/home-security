import { expect,it,vi } from 'vitest';
import { locateObject,compareLocationMethods,type LocationZone } from '../src/uniview/object-location.js';
import { historySchema } from '../src/events/queries.js';
import { historyFilters,createEventQueries } from '../src/events/store.js';
import { locationsCte,annotateLocations } from '../src/events/locations.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
const at=new Date('2026-10-20T12:00:00Z');
const polygon=[{X:1000,Y:1000},{X:9000,Y:1000},{X:9000,Y:9000},{X:1000,Y:9000}];
const zones:LocationZone[]=Array.from({length:4},(_,slot)=>({id:`00000000-0000-4000-8000-00000000000${slot}`,zoneId:`10000000-0000-4000-8000-00000000000${slot}`,revision:1,slot,channel:1,sourceInstallationId:'20000000-0000-4000-8000-000000000000',name:`Slot ${slot}`,interested:slot===0,enabled:slot===0,ruleEnabled:true,polygon:slot===0?polygon:[],observedAt:new Date(+at-10000),lastObservedAt:new Date(+at+10000),nameEffectiveAt:new Date(+at-10000)}));
const object={coordinateStatus:'VALID',xMin:4000,xMax:6000,yMin:4000,yMax:6000,sourceTimestamp:at,fullFrameSnapshotId:'scene'};
it('pins multiple overlapping source versions without deduplicating source identities',()=>{
 const overlapping=zones.map(z=>z.slot===1?{...z,enabled:true,polygon}:z);
 const result=locateObject(object,overlapping);expect(result.status).toBe('MATCHED');expect(result.matches.map(z=>z.slot)).toEqual([0,1]);expect(result.matches[0]?.revision).toBe(1);expect(result.evaluatedVersionIds).toHaveLength(4);
 const annotated=annotateLocations({sourceInstallationId:zones[0]!.sourceInstallationId,nvrChannel:1,objects:[{id:'original',...object},{id:'related',...object,coordinateStatus:'MISSING'}]},overlapping);
 expect(annotated.objects.map(o=>o.id)).toEqual(['original','related']);expect(annotated.objects[1]?.location.status).toBe('UNKNOWN');
});
it('uses observation brackets and refuses current geometry for historical gaps or conflicting versions',()=>{
 expect(locateObject({...object,sourceTimestamp:new Date(+at-20000)},zones).reason).toBe('missing_or_conflicting_historical_configuration');
 expect(locateObject(object,[...zones,{...zones[0]!,id:'another'}]).status).toBe('UNKNOWN');
 expect(locateObject(object,zones.slice(0,3)).status).toBe('UNKNOWN');
 const next=zones.map(z=>({...z,revision:2,id:`next-${z.id}`,observedAt:new Date(+at+30000),nameEffectiveAt:new Date(+at+30000),lastObservedAt:new Date(+at+40000),polygon:[]}));
 expect(locateObject(object,[...zones,...next])).toEqual(locateObject(object,zones));
});
it('retains unknowns, rejects invalid geometry, and distinguishes unmatched from ambiguous boundary cases',()=>{
 for(const patch of[{coordinateStatus:'MISSING'},{xMin:null},{xMin:-1},{xMin:6000},{fullFrameSnapshotId:null},{sourceTimestamp:null}])expect(locateObject({...object,...patch},zones).status).toBe('UNKNOWN');
 expect(locateObject(object,zones.map(z=>z.slot===0?{...z,polygon:[{X:0,Y:0},{X:9000,Y:9000},{X:9000,Y:0},{X:0,Y:9000}]}:z)).reason).toBe('invalid_historical_polygon');
 expect(locateObject({...object,xMin:9200,xMax:9800},zones).status).toBe('UNMATCHED');
 expect(locateObject({...object,yMin:8000,yMax:9500},zones)).toMatchObject({status:'AMBIGUOUS',reason:'anchor_disagreement'});
 expect(locateObject({...object,xMin:1000,xMax:1100},zones).reason).toBe('near_zone_boundary');
 const full=zones.map(z=>z.slot===0?{...z,polygon:[{X:0,Y:0},{X:10000,Y:0},{X:10000,Y:10000},{X:0,Y:10000}]}:z);
 expect(locateObject({...object,yMin:0},full).status).toBe('MATCHED');
 expect(locateObject({...object,xMin:0},full).reason).toBe('clipped_rectangle');
});
it('evaluates concave multi-vertex polygons and shows why bbox overlap is not a reliable location',()=>{
 const concave=[{X:1000,Y:1000},{X:9000,Y:1000},{X:9000,Y:9000},{X:7000,Y:9000},{X:7000,Y:3000},{X:1000,Y:3000}];
 const regions=zones.map(z=>z.slot===0?{...z,polygon:concave}:z);
 const overlappingObject={...object,yMin:2000,yMax:6500};
 const comparison=compareLocationMethods(overlappingObject,regions);expect(comparison.overlap).toHaveLength(1);expect(comparison.bottom).toHaveLength(0);expect(locateObject(overlappingObject,regions).status).toBe('UNMATCHED');
});
it('filters reliably matched zones before cursor pagination and returns each event once',async()=>{
 const cursor=Buffer.from(JSON.stringify({eventTime:at.toISOString(),id:zones[0]!.id})).toString('base64url');
 const query=historySchema.parse({locationZoneId:zones[0]!.zoneId,interestedZonesOnly:'true',cursor,limit:30});
 const filters=historyFilters(query),sql=filters.map(s=>s.sql).join(' ');
 expect(sql).toContain("l.status='MATCHED'");expect(sql).toContain('ANY(l.zones)');expect(sql).toContain('l.interested');expect(sql).toContain('EXISTS');
 const raw=vi.fn(async()=>[]);await createEventQueries({$queryRaw:raw,univiewZoneVersion:{findMany:async()=>[]},securityEvent:{findMany:async()=>[]}} as unknown as PrismaClient).history(query);
 const statement=(raw.mock.calls[0] as unknown as [{sql:string;values:unknown[]}])[0];
 expect(statement.sql.indexOf('ANY(l.zones)')).toBeLessThan(statement.sql.indexOf('ORDER BY COALESCE'));expect(statement.values.at(-1)).toBe(31);
 expect(locationsCte(zones).sql).toContain('count(DISTINCT z.slot)<>4');
 const unknown=historyFilters(historySchema.parse({locationStatus:'uncertain'})).map(s=>s.sql).join(' ');expect(unknown).toContain("IN ('UNKNOWN','AMBIGUOUS')");expect(unknown).toContain('OR NOT EXISTS');
 for(const q of[{locationZoneId:'bad'},{locationStatus:'triggered'},{interestedZonesOnly:'yes'}])expect(historySchema.safeParse(q).success).toBe(false);
});
it('filters interested/other cohorts before pagination and excludes mixed property events from other zones',async()=>{
 const own=historyFilters(historySchema.parse({zoneInterest:'interested'})).map(s=>s.sql).join(' ');expect(own).toContain("l.status='MATCHED' AND l.interested");
 const other=historyFilters(historySchema.parse({zoneInterest:'other'})).map(s=>s.sql).join(' ');expect(other).toContain('NOT COALESCE(l.interested,false)');expect(other).toContain('NOT EXISTS (SELECT 1 FROM object_locations own');expect(other).toContain("own.status='MATCHED' AND own.interested");
 const raw=vi.fn(async()=>[]);await createEventQueries({$queryRaw:raw,univiewZoneVersion:{findMany:async()=>[]},securityEvent:{findMany:async()=>[]}} as unknown as PrismaClient).history(historySchema.parse({zoneInterest:'other',limit:4}));const statement=(raw.mock.calls[0] as unknown as [{sql:string;values:unknown[]}])[0];expect(statement.sql).toContain('WITH location_catalog');expect(statement.sql.indexOf('NOT COALESCE(l.interested,false)')).toBeLessThan(statement.sql.indexOf('ORDER BY COALESCE'));expect(statement.values.at(-1)).toBe(5);
});

it('counts a person ground point inside the polygon even when the torso crosses its boundary; vehicles and AI default remain unchanged',()=>{
 const o={...object,category:'PERSON',yMin:500,yMax:1200};
 expect(locateObject(o,zones)).toMatchObject({status:'AMBIGUOUS',reason:'anchor_disagreement'});
 expect(locateObject(o,zones,'person_ground_point')).toMatchObject({status:'MATCHED',reason:'person_ground_point',algorithm:'person_ground_point_v1',matches:[{slot:0}]});
 expect(locateObject({...o,category:'MOTOR_VEHICLE'},zones,'person_ground_point').status).toBe('AMBIGUOUS');
 const annotated=annotateLocations({sourceInstallationId:zones[0]!.sourceInstallationId,nvrChannel:1,objects:[o]},zones);expect(annotated.objects[0]!.location.status).toBe('MATCHED');
 expect(locationsCte(zones).sql).toContain("WHEN o.category='PERSON'");
});
it('does not turn torso overlap, missing/invalid coordinates, historical gaps or clipped feet into confirmed person entry',()=>{
 for(const patch of[{yMin:8500,yMax:9500},{coordinateStatus:'MISSING'},{fullFrameSnapshotId:null},{sourceTimestamp:new Date(+at-20000)},{yMax:10000},{xMin:0}])expect(locateObject({...object,category:'PERSON',...patch},zones,'person_ground_point').status).not.toBe('MATCHED');
 expect(locateObject({...object,category:'PERSON',xMin:800,xMax:1200,yMin:500,yMax:1000},zones,'person_ground_point').status).toBe('MATCHED');
});
