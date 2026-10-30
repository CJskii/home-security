import type { WebhookPayload } from './delivery-contract.js';
export const ENRICHMENT_WINDOW_MS=120000;
interface AcceptedObject {objectId:string;verification:string;shortDescription:string;actions:unknown;observedType:string}
interface Analysis {revision:number;completedAt:Date;objectAnalyses:AcceptedObject[];subjects?:unknown}
// Only persisted, accepted exact-object descriptions. Never free-form model output,
// event-wide summaries for unrelated subjects or synthetic attribute reconstruction.
export function enrichmentPayload(initial:WebhookPayload,analysis:Analysis,createdAt:Date,now:Date):WebhookPayload|null{
    if(initial.type!=='security.event'||!initial.eventId||analysis.revision<=0||analysis.completedAt<=createdAt||analysis.completedAt>now||now.getTime()-Date.parse(initial.timestamps.receivedAt)>ENRICHMENT_WINDOW_MS)return null;
    const descriptions=analysis.objectAnalyses.filter(o=>initial.objects.some(s=>s.id===o.objectId&&(s.category==='PERSON'?o.observedType==='person':s.category==='MOTOR_VEHICLE'?o.observedType==='motor_vehicle':o.observedType==='non_motor_vehicle'))&&o.verification==='supported').flatMap(o=>{
        const text=o.shortDescription.trim(),lower=text.toLowerCase();
        const actionEvidence=Array.isArray(o.actions)&&o.actions.some(a=>typeof a==='string'&&!['visible','unknown','other'].includes(a)&&lower.includes(a.slice(0,4)));
        const subject=Array.isArray(analysis.subjects)?analysis.subjects.find(s=>s&&typeof s==='object'&&s.objectId===o.objectId) as Record<string,unknown>|undefined:undefined;
        const traits=[subject?.person,subject?.vehicle].flatMap(v=>v&&typeof v==='object'?Object.values(v):[]).flat();
        const attributeEvidence=traits.some(v=>typeof v==='string'&&!['unknown','none','other'].includes(v)&&lower.includes(v.toLowerCase().replaceAll('_',' ')));
        const relationshipEvidence=Boolean(subject?.relationship&&typeof subject.relationship==='object'&&'kind' in subject.relationship&&typeof subject.relationship.kind==='string'&&lower.includes(subject.relationship.kind));
        if(!actionEvidence&&!attributeEvidence&&!relationshipEvidence)return [];

        const generic=/^(?:a |an |the )?(?:person|vehicle|motor vehicle|non.motor vehicle|car|object)(?: (?:appears|seems) to be| is)? (?:visible|present|detected)(?: in (?:the )?(?:scene|image|zone))?[.!]?$/i;
        if(text.length<8||text.length>256||generic.test(text)||text===initial.notification?.message||[...text].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return [];
        return [{id:o.objectId,text}];
    }).slice(0,2);
    if(!descriptions.length)return null;
    const summary=[...new Set(descriptions.map(o=>o.text))].join(' ').slice(0,512);
    return {...initial,action:'update',idempotencyKey:initial.idempotencyKey.replace('notification:v1:','notification-update:v1:'),enrichment:{revision:analysis.revision,completedAt:analysis.completedAt.toISOString(),objectIds:descriptions.map(o=>o.id)},ai:{status:'completed',revision:analysis.revision,summary}};
}

// Explicit TEST only: preview existing accepted sample text without fabricating a
// live event, changing source timestamps, or allowing historical LIVE enrichment.
export function testEnrichmentPayload(initial:WebhookPayload,analysis:Analysis,now:Date):WebhookPayload|null{
    if(initial.type!=='security.test'||!initial.sampleEventId)return null;
    const live={...initial,type:'security.event' as const,eventId:initial.sampleEventId,timestamps:{...initial.timestamps,receivedAt:now.toISOString()}};
    const candidate=enrichmentPayload(live,analysis,new Date(0),now);
    return candidate?{...initial,action:'update',idempotencyKey:initial.idempotencyKey.replace('notification-test:v1:','notification-test-update:v1:'),enrichment:candidate.enrichment,ai:candidate.ai}:null;
}
