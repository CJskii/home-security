import type { NotificationConfiguration, NotificationRule, NotificationWindow } from './contracts.js';
export const NOTIFICATION_ALGORITHM='source_zone_rules_v1';
export interface NotificationObject {
  id:string;category:string;status:'MATCHED'|'UNMATCHED'|'AMBIGUOUS'|'UNKNOWN';
  zoneIds:string[];reliableZoneIds?:string[];versionIds:string[];basis:'stored_membership'|'stored_geometry_projection'|'latest_confirmed_geometry_assumed_unchanged';reason:string;
}
export interface NotificationEvent {id:string;channel:number;receivedAt:string;objects:NotificationObject[];truncated?:boolean}
export interface NotificationDecision {
  eventId:string;ruleId:string;receivedAt:string;
  outcome:'would_notify'|'cooldown'|'unmatched'|'uncertain'|'rule_disabled';reason:string;
  objectIds:string[];zoneVersionIds:string[];idempotencyKey:string;cooldownUntil:string|null;
}
export function matchNotificationRule(rule:NotificationRule,event:NotificationEvent) {
  if(!rule.enabled)return {kind:'rule_disabled' as const,reason:'rule_disabled',objects:[]};
  if(!rule.channels.includes(event.channel))return {kind:'unmatched' as const,reason:'camera_not_selected',objects:[]};
  if(!event.objects.length)return {kind:'uncertain' as const,reason:'missing_source_objects',objects:[]};
  const objects=event.objects.filter(o=>rule.categories.includes(o.category as NotificationRule['categories'][number]));
  const certain=objects.filter(o=>(o.reliableZoneIds??(o.status==='MATCHED'?o.zoneIds:[])).some(z=>rule.zoneIds.includes(z)));
  if(certain.length)return {kind:'match' as const,reason:'source_category_and_zone',objects:certain};
  const ambiguous=objects.filter(o=>o.status==='AMBIGUOUS'),unknown=objects.filter(o=>o.status==='UNKNOWN');
  if(rule.ambiguous==='include'&&ambiguous.length)return {kind:'match' as const,reason:'ambiguous_included',objects:ambiguous};
  if(rule.unknown==='include'&&unknown.length)return {kind:'match' as const,reason:'unknown_included',objects:unknown};
  if(ambiguous.length||unknown.length||event.truncated)return {kind:'uncertain' as const,reason:event.truncated?'object_limit':ambiguous.length?'ambiguous_excluded':'unknown_excluded',objects:[...ambiguous,...unknown]};
  return {kind:'unmatched' as const,reason:objects.length?'zone_not_selected':'category_not_selected',objects:[]};
}
// No AI fields, NVR calls, writes or publishing dependencies. Each canonical UUID
// is processed once; source reports and overlapping matches never multiply sends.
export function evaluateNotifications(installation:string,configuration:NotificationConfiguration,events:NotificationEvent[],window:NotificationWindow) {
  const results:NotificationDecision[]=[],last=new Map<string,number>(),seen=new Set<string>();
  const ordered=[...events].sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.id.localeCompare(b.id));
  for(const event of ordered){if(seen.has(event.id))continue;seen.add(event.id);const at=Date.parse(event.receivedAt);if(at>=Date.parse(window.to)||at<Date.parse(window.from))continue;
    for(const rule of configuration.rules){const key=cooldownScopeKey(rule,event.channel),m=matchNotificationRule(rule,event),until=last.has(key)?last.get(key)!+rule.cooldownSeconds*1000:null;
      const outcome=m.kind==='match'?(until!==null&&at<until?'cooldown':'would_notify'):m.kind;
      if(outcome==='would_notify')last.set(key,at);
      if(at<Date.parse(window.from))continue;
      results.push({eventId:event.id,ruleId:rule.id,receivedAt:event.receivedAt,outcome,reason:outcome==='cooldown'?'rule_cooldown':m.reason,
        objectIds:[...new Set(m.objects.map(o=>o.id))],zoneVersionIds:[...new Set(m.objects.flatMap(o=>o.versionIds))],
        idempotencyKey:`notification:v1:${installation}:${event.id}`,cooldownUntil:outcome==='cooldown'?new Date(until!).toISOString():null});
    }
  }
  return {algorithm:NOTIFICATION_ALGORITHM,deliveryAvailable:false as const,deliveryEnabled:configuration.deliveryEnabled,window,
    eventCount:ordered.filter((e,i)=>ordered.findIndex(o=>o.id===e.id)===i&&Date.parse(e.receivedAt)>=Date.parse(window.from)&&Date.parse(e.receivedAt)<Date.parse(window.to)).length,decisions:results};
}

export function cooldownScopeKey(rule:Pick<NotificationRule,'id'|'cooldownScope'>,channel:number){return `${rule.id}:${rule.cooldownScope==='rule_camera'?channel:0}`;}
