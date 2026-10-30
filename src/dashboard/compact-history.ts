import { z } from 'zod';
import type { DeliveryHistory } from '../notifications/history.js';
const text=(v:unknown,max:number)=>String(v??'').replace(/[\r\n\t]/g,' ').slice(0,max);
export const compactRow=z.object({eventId:z.uuid(),timestamp:z.iso.datetime().optional(),title:z.string().max(180),subtitle:z.string().max(240),time:z.string().max(48),url:z.string().url(),icon:z.enum(['mdi:account','mdi:car','mdi:cctv','mdi:check-circle-outline','mdi:timer-outline','mdi:minus-circle-outline','mdi:help-circle-outline','mdi:alert-circle-outline']),tone:z.enum(['teal','amber','red','grey']),status:z.string().max(40),cameraLabel:z.string().max(80).optional(),thumbnail:z.string().url().nullable().optional()}).strict();
export function compactDetection(row:Record<string,unknown>, event:ReturnType<typeof import('../events/presentation.js').presentEvent>, link:string,time:string,scope:'all'|'property'|'other'|'object'='all') {
  const objects=event.objects.filter(o=>{if(scope==='all'||scope==='object')return true;const l=o.location as {status?:string;matches?:{interested:boolean}[]}|null;return l?.status==='MATCHED'&&l.matches?.some(m=>scope==='property'?m.interested:!m.interested);}),locations=objects.map(o=>o.location as {status?:string;matches?:{name:string;interested?:boolean}[]}|null);
  const reliable=locations.filter(l=>l?.status==='MATCHED'),names=[...new Set(reliable.flatMap(l=>l?.matches?.filter(m=>scope==='all'||scope==='object'||(scope==='property'?m.interested:!m.interested)).map(m=>m.name)??[]))];
  const zone=names.length?names.join(', '):locations.some(l=>l?.status==='AMBIGUOUS')?'Boundary uncertain':locations.some(l=>l?.status==='UNMATCHED')?'Unmatched':'Zone unknown';
  const p=row.processing as {status?:string}|null,a=row.analysis as {shortDescription?:string}|null;
  const categories=scope==='all'?event.categories:[...new Set(objects.map(o=>o.category))];
  const category=categories.map(c=>({person:'Person',motor_vehicle:'Vehicle',non_motor_vehicle:'Non-motor vehicle'}[c]??'Detection')).join(' + ');
  const sourceDescription=category+' detected';
  const rawDescription=scope==='all'?a?.shortDescription:objects.map(o=>(o.analysis as {shortDescription?:string}|null)?.shortDescription).find(Boolean);
  const description=text(rawDescription,130);
  const generic=/^(?:a |an )?(?:person|vehicle|motor vehicle|object)(?: is| appears to be)? (?:visible|present|detected)(?: in (?:the )?(?:image|scene))?\.?$/i.test(description);
  const useful=p?.status==='COMPLETE'&&description&&!generic?description:sourceDescription;
  return compactRow.parse({eventId:row.id,timestamp:new Date(String(event.timestamp.value)).toISOString(),title:text(category+' · '+zone,180),subtitle:text(useful,240),cameraLabel:text(row.nvrChannel?'Camera '+row.nvrChannel:row.camera,80),time,url:link,icon:categories.includes('person')?'mdi:account':categories.includes('motor_vehicle')?'mdi:car':'mdi:cctv',tone:scope==='other'?'grey':'teal',status:p?.status??'PENDING'});
}
export function compactNotification(item:DeliveryHistory['items'][number],url:string,time:string) {
  const state=item.intent?.state;
  let status='Not selected',icon:'mdi:minus-circle-outline'|'mdi:check-circle-outline'|'mdi:alert-circle-outline'|'mdi:help-circle-outline'|'mdi:timer-outline'='mdi:minus-circle-outline',tone:'teal'|'amber'|'red'|'grey'='grey';
  const reasons=item.decisions.filter(d=>!['rule_disabled','camera_not_selected'].includes(d.reason)).map(d=>d.reason);
  if(state==='DELIVERED'){status='Webhook accepted';icon='mdi:check-circle-outline';tone='teal';}
  else if(state==='UNCERTAIN'){status='Acceptance uncertain';icon='mdi:help-circle-outline';tone='amber';}
  else if(state==='FAILED'||state==='EXPIRED'||state==='CANCELLED'){status=state==='FAILED'?'Delivery failed':state==='EXPIRED'?'Delivery expired':'Delivery cancelled';icon='mdi:alert-circle-outline';tone='red';}
  else if(state){status='Delivery pending';icon='mdi:timer-outline';tone='amber';}
  else if(item.deliveryHeldReason){status='Delivery held';icon='mdi:minus-circle-outline';}
  else if(reasons.some(r=>r.includes('cooldown'))){status='Cooldown suppressed';icon='mdi:timer-outline';}
  else if(reasons.some(r=>r.includes('ambiguous'))){status='Boundary excluded';icon='mdi:help-circle-outline';}
  else if(reasons.some(r=>r.includes('unknown'))){status='Unknown zone excluded';icon='mdi:help-circle-outline';}
  else if(item.state==='WAITING'){status='Awaiting source geometry';icon='mdi:timer-outline';tone='amber';}
  const rules=[...new Set(item.decisions.filter(d=>!['rule_disabled','camera_not_selected'].includes(d.reason)).map(d=>d.ruleName))].join(', ');
  return compactRow.parse({eventId:item.eventId,timestamp:item.receivedAt??item.createdAt,title:`Camera ${item.channel??'?'} · ${status}`,subtitle:text(rules||'Rule evaluation',240),time,url,icon,tone,status});
}
