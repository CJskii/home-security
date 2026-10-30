import { z } from 'zod';
import type { Database } from '../database.js';
import { historySchema } from '../events/queries.js';
import { presentEvent } from '../events/presentation.js';
import { compactDetection, compactNotification } from './compact-history.js';
import { mediaLink, type NotificationMedia } from '../notifications/media.js';

const cursor = historySchema.shape.cursor;
export const haZoneQuery = z.object({ zoneId:z.uuid(), until:z.iso.datetime().optional(), cursor }).strict();
export const HA_ZONE_PAGE = 24;
export const haEventQuery=z.object({eventId:z.uuid()}).strict();
const match = z.object({status:z.literal('MATCHED'),matches:z.array(z.object({zoneId:z.uuid()}))});
export const haZonePage = z.object({version:z.literal(1),zone:z.object({id:z.uuid(),name:z.string(),channel:z.number().int()}),
  from:z.iso.datetime(),until:z.iso.datetime(),nextCursor:z.string().nullable(),ledgerAvailable:z.boolean(),
  items:z.array(z.object({eventId:z.uuid(),category:z.string(),camera:z.string(),zone:z.string(),time:z.string(),timestamp:z.iso.datetime().optional(),description:z.string(),
    notification:z.string(),thumbnail:z.string().url().nullable(),fullFrame:z.string().url().nullable()})).max(HA_ZONE_PAGE)}).strict();
export class HaZoneNotFound extends Error {}
export async function homeAssistantZoneHistory(db:Database,installation:string,input:z.infer<typeof haZoneQuery>,media?:NotificationMedia,now=new Date()) {
  if(!db.events||!db.zoneActivity||!db.notifications?.history)throw Error('History unavailable');
  const until=input.until?new Date(input.until):now;
  // A dialog's paging window stays fixed, and expires after one hour.
  if(until.getTime()>now.getTime()+60000||until.getTime()<now.getTime()-3600000)throw new RangeError('Refresh the history window');
  const from=new Date(until.getTime()-7*86400000);
  const zone=(await db.zoneActivity(installation,now)).find(z=>z.zoneId===input.zoneId);
  if(!zone)throw new HaZoneNotFound();
  const query=historySchema.parse({sourceInstallationId:installation,nvrChannel:zone.channel,locationZoneId:zone.zoneId,
    occurredAfter:from.toISOString(),occurredBefore:until.toISOString(),limit:HA_ZONE_PAGE});
  if(input.cursor)query.cursor=input.cursor;
  const result=await db.events.history(query),rows=result.slice(0,HA_ZONE_PAGE),last=rows.at(-1);
  const history=await db.notifications.history(installation,undefined,false,rows.map(r=>String(r.id)));
  const signedAt=new Date(Math.floor(now.getTime()/600000)*600000);
  const items=rows.flatMap(row=>{
    const event=presentEvent(row);
    const objects=event.objects.filter(o=>{const l=match.safeParse(o.location);return l.success&&l.data.matches.some(m=>m.zoneId===zone.zoneId);});
    const object=objects.find(o=>o.images.cropId)??objects[0];if(!object)return [];
    const compact=compactDetection(row,{...event,objects:[object]},'http://ha.invalid/',new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(String(event.timestamp.value))),'object');
    const sign=(id:unknown,type:number)=>{
      const imageId=z.uuid().safeParse(id);if(!imageId.success)return null;
      const image=event.images.find(i=>(i as Record<string,unknown>).id===imageId.data&&i.type===type);
      return image&&media?mediaLink(media,String(row.id),imageId.data,String(row.id),signedAt).url:null;
    };
    const notification=history.items.find(i=>i.eventId===row.id);
    return [{eventId:row.id,category:compact.title.split(' · ')[0],camera:zone.channel===1?'Driveway':'Side Walkway',zone:zone.name,time:compact.time,timestamp:new Date(String(event.timestamp.value)).toISOString(),
      description:compact.subtitle,notification:notification?compactNotification(notification,'http://ha.invalid/',compact.time).status:history.available?'No notification recorded':'Notification ledger unavailable',
      thumbnail:sign(object.images.cropId,2),fullFrame:sign(object.images.fullFrameId,1)}];
  });
  return haZonePage.parse({version:1,zone:{id:zone.zoneId,name:zone.name,channel:zone.channel},from:from.toISOString(),until:until.toISOString(),ledgerAvailable:history.available,
    nextCursor:result.length>HA_ZONE_PAGE&&last?Buffer.from(JSON.stringify({eventTime:last.eventTime,id:last.id})).toString('base64url'):null,items});
}

// Direct read for an event card: same seven-day scope, installation and signed media.
// It must also work for notification rows with no confirmed geometric zone match.
export async function homeAssistantEvent(db:Database,installation:string,eventId:string,media?:NotificationMedia,now=new Date()) {
  if(!db.events||!db.notifications?.history)throw Error('History unavailable');
  const row=await db.events.get(eventId);
  if(!row||row.sourceInstallationId!==installation)throw new HaZoneNotFound();
  const event=presentEvent(row),time=new Date(String(event.timestamp.value));
  if(!Number.isFinite(+time)||+time<+now-7*86400000||+time>+now+60000)throw new HaZoneNotFound();
  const history=await db.notifications.history(installation,undefined,false,[eventId]);
  const notification=history.items.find(i=>i.eventId===eventId);
  const selectedIds=notification?.decisions.flatMap(d=>d.objectIds)??[];
  const selected=event.objects.filter(o=>selectedIds.includes(String((o as Record<string,unknown>).id)));
  const reliable=event.objects.filter(o=>{const l=match.safeParse(o.location);return l.success&&l.data.matches.length;});
  const candidates=selected.length?selected:reliable.length?reliable:event.objects;
  const object=candidates.find(o=>o.images.cropId)??candidates.find(o=>o.images.fullFrameId)??candidates[0];
  const local=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(time);
  const compact=compactDetection(row,{...event,objects:object?[object]:[]},'http://ha.invalid/',local,'object');
  const sign=(imageId:unknown,type:number)=>{const id=z.uuid().safeParse(imageId);return id.success&&media&&event.images.some(i=>(i as Record<string,unknown>).id===id.data&&i.type===type)?mediaLink(media,eventId,id.data,eventId,now).url:null;};
  const location=object?.location as {status?:string;matches?:{name:string}[]}|null;
  const zone=location?.status==='MATCHED'?location.matches?.map(m=>m.name).join(', '):location?.status==='AMBIGUOUS'?'Boundary uncertain':location?.status==='UNMATCHED'?'Unmatched':'Zone unknown';
  return haZonePage.shape.items.element.parse({eventId,category:compact.title.split(' · ')[0]||'Detection',camera:row.nvrChannel===1?'Driveway':'Side Walkway',zone:zone||'Zone unknown',time:local,timestamp:new Date(String(event.timestamp.value)).toISOString(),description:compact.subtitle,notification:notification?compactNotification(notification,'http://ha.invalid/',local).status:history.available?'No notification recorded':'Notification ledger unavailable',thumbnail:sign(object?.images.cropId,2),fullFrame:sign(object?.images.fullFrameId,1)});
}
