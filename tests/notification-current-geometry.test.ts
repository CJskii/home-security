import { expect, it } from 'vitest';
import { notificationGeometry, NOTIFICATION_GEOMETRY_MAX_AGE_MS } from '../src/notifications/current-geometry.js';
import { projectNotificationEvent } from '../src/notifications/geometry.js';
import { locateObject, type LocationZone } from '../src/uniview/object-location.js';
const now=new Date('2026-10-21T12:05:00Z'), observed=new Date('2026-10-21T12:00:00Z');
const zones:LocationZone[]=Array.from({length:4},(_,slot)=>({id:`v${slot}`,zoneId:`z${slot}`,slot,channel:2,sourceInstallationId:'installation',enabled:slot===0,ruleEnabled:true,polygon:slot===0?[{X:100,Y:100},{X:4900,Y:100},{X:4900,Y:9900},{X:100,Y:9900}]:[],observedAt:observed,lastObservedAt:observed,nameEffectiveAt:observed,name:'My Walkway',interested:slot===0}));
const object={id:'source-report-a',category:'PERSON',coordinateStatus:'VALID',sourceTimestamp:new Date('2026-10-21T12:04:59Z'),fullFrameSnapshotId:'exact-frame',xMin:1000,yMin:2000,xMax:2000,yMax:5000,memberships:[]};
const event={id:'event',nvrChannel:2,firstReceivedAt:now,objects:[object]};
it('uses persisted latest geometry immediately, including after a process restart, without changing source versions or historical projection',()=>{
 const original=structuredClone(zones);expect(projectNotificationEvent(event,zones).objects[0]?.status).toBe('UNKNOWN');
 for(let restart=0;restart<2;restart++)expect(projectNotificationEvent(event,structuredClone(zones),now).objects[0]).toMatchObject({status:'MATCHED',zoneIds:['z0'],versionIds:['v0','v1','v2','v3'],basis:'latest_confirmed_geometry_assumed_unchanged'});
 expect(zones).toEqual(original);expect(locateObject(object,zones).status).toBe('UNKNOWN');
});
it('does not carry an old version across a detected change or use a new polygon retroactively',()=>{
 const changed={...zones[0]!,id:'changed',observedAt:new Date('2026-10-21T12:05:30Z'),lastObservedAt:new Date('2026-10-21T12:06:00Z'),nameEffectiveAt:new Date('2026-10-21T12:05:30Z'),polygon:[{X:6000,Y:100},{X:9900,Y:100},{X:9900,Y:9900},{X:6000,Y:9900}]};
 expect(projectNotificationEvent(event,[...zones,changed],new Date('2026-10-21T12:06:01Z')).objects[0]?.status).toBe('UNKNOWN');
 const after={...event,objects:[{...object,sourceTimestamp:new Date('2026-10-21T12:06:01Z')}]};expect(projectNotificationEvent(after,[...zones,changed],new Date('2026-10-21T12:06:02Z')).objects[0]?.status).toBe('UNMATCHED');
});
it('fails closed on stale, missing, duplicate or invalid current configuration',()=>{
 expect(notificationGeometry(object,zones,new Date(observed.getTime()+NOTIFICATION_GEOMETRY_MAX_AGE_MS+1)).cached).toBe(false);
 for(const catalog of [zones.slice(0,3),[...zones,{...zones[0]!,id:'conflict'}],zones.map(z=>z.slot===0?{...z,polygon:[]}:z)])expect(projectNotificationEvent(event,catalog,now).objects[0]?.status).toBe('UNKNOWN');
});
it('retains missing-position, boundary and exact multi-object/source-frame handling',()=>{
 const mixed={...event,objects:[{...object,id:'alarm-observation',coordinateStatus:'MISSING',xMin:null},{...object,id:'boundary',xMax:4900,xMin:4800},{...object,id:'other-frame',fullFrameSnapshotId:'another-frame',xMin:7000,xMax:8000},object]};
 const result=projectNotificationEvent(mixed,zones,now);expect(result.objects.map(o=>[o.id,o.status])).toEqual([['alarm-observation','UNKNOWN'],['boundary','MATCHED'],['other-frame','UNMATCHED'],['source-report-a','MATCHED']]);
});
it('retains historical brackets and does not invent configuration before the first observation',()=>{
 const old={...object,sourceTimestamp:new Date('2026-10-20T12:00:00Z')};expect(projectNotificationEvent({...event,objects:[old]},zones,now).objects[0]?.status).toBe('UNKNOWN');
 const bracket=zones.map(z=>({...z,lastObservedAt:now}));expect(notificationGeometry(object,bracket,now).cached).toBe(false);expect(projectNotificationEvent(event,bracket,now).objects[0]?.basis).toBe('stored_geometry_projection');
});
