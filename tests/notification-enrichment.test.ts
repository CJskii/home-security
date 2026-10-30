import { expect,it } from 'vitest';
import { createNotificationPipeline } from '../src/notifications/pipeline.js';
import { enrichmentPayload } from '../src/notifications/enrichment.js';
import { ledgerFixture,installation } from './helpers/notification-ledger.js';
const accepted={outcome:'accepted',code:'acknowledged',status:200,mayHaveReached:true,durationMs:10,receipt:'accepted'} as const;
async function fixture(){
 const f=ledgerFixture(),source=f.event(1);Object.assign(source.processing,{status:'ANALYSING'});
 const options={installation,deliveryEnabled:true,activatedAt:new Date('2026-10-21T12:00:00Z'),updatesEnabled:true,updatesFrom:new Date('2026-10-21T12:00:00Z'),destinationId:'a'.repeat(64),dashboardOrigin:'https://dashboard.example'};
 const pipe=createNotificationPipeline(f.prisma,options,f.now);await pipe.reconcile();await pipe.evaluateNext();const initial=await pipe.claim();expect(initial?.payload.ai.status).toBe('pending');await pipe.finish(initial!,accepted);
 const complete=(description='A person appears to be walking.',revision=1)=>{f.advance(10000);const analysis={eventId:source.id,revision,completedAt:f.now(),objectAnalyses:[{objectId:source.objects[0]!.id,verification:'supported',observedType:'person',actions:['walking'],shortDescription:description}]};Object.assign(source,{analysis});source.processing.status='COMPLETE';f.tables.eventAnalysis!.splice(0,f.tables.eventAnalysis!.length,analysis);return analysis;};
 return {...f,source,pipe,initial:initial!,options,complete};
}
it('sends initial without AI, creates one independently leased same-identity update, and never reserves or advances cooldown twice',async()=>{
 const f=await fixture(),before=structuredClone(f.tables.notificationCooldown);f.complete();await Promise.all([f.pipe.enrich!(),f.pipe.enrich!()]);expect(f.tables.notificationIntent).toHaveLength(2);
 const update=await f.pipe.claim();expect(update?.mode).toBe('UPDATE');expect(update?.id).not.toBe(f.initial.id);expect(update?.payload.notificationId).toBe(f.initial.payload.notificationId);expect(update?.payload.action).toBe('update');expect(update?.payload.eventId).toBe(f.source.id);expect(update?.payload.objects).toEqual(f.initial.payload.objects);expect(update?.payload.ai.summary).toContain('walking');
 expect(await f.pipe.authorize(update!)).toBe(true);await f.pipe.finish(update!,accepted);await f.pipe.finish(update!,accepted);expect(f.tables.notificationCooldown).toEqual(before);
 const restart=createNotificationPipeline(f.prisma,f.options,f.now);await restart.enrich!();expect(await restart.claim()).toBeNull();expect(f.tables.notificationIntent).toHaveLength(2);expect(f.tables.notificationAttempt).toHaveLength(2);
});
it('does not update generic, skipped, failed, unrelated, uncertain or stale accepted results',async()=>{
 for(const mode of ['generic','skipped','failed','unrelated','uncertain','stale','preexisting','global_off','disarmed'] as const){const f=await fixture(),analysis=f.complete(mode==='generic'?'A person is visible.':undefined);
 if(mode==='skipped'||mode==='failed')f.source.processing.status=mode.toUpperCase();if(mode==='unrelated')analysis.objectAnalyses[0]!.objectId='00000000-0000-4000-8000-000000000099';if(mode==='uncertain')analysis.objectAnalyses[0]!.verification='uncertain';if(mode==='stale')f.advance(120001);if(mode==='preexisting')analysis.completedAt=new Date('2026-10-21T12:00:09Z');
 if(mode==='global_off')(f.configuration.configuration as {deliveryEnabled:boolean}).deliveryEnabled=false;if(mode==='disarmed')f.options.updatesEnabled=false;
 await f.pipe.enrich!();const update=await f.pipe.claim();expect(update,mode).toBeNull();}
});
it('requires an accepted initial parent and refuses newer or out-of-order revisions after a payload was frozen',async()=>{
 const f=await fixture();f.complete();f.tables.notificationIntent![0]!.state='UNCERTAIN';await f.pipe.enrich!();expect(f.tables.notificationIntent).toHaveLength(1);f.tables.notificationIntent![0]!.state='DELIVERED';await f.pipe.enrich!();f.complete('A person is standing.',2);expect(await f.pipe.claim()).toBeNull();expect(f.tables.notificationIntent![1]!.state).toBe('CANCELLED');await f.pipe.enrich!();expect(f.tables.notificationIntent).toHaveLength(2);
});
it('holds uncertain update delivery after restart while preserving successful initial and cooldown',async()=>{
 const f=await fixture(),before=structuredClone(f.tables.notificationCooldown);f.complete();await f.pipe.enrich!();const update=await f.pipe.claim();f.advance(31000);await f.pipe.recover();expect(await f.pipe.claim()).toBeNull();expect(f.tables.notificationIntent![1]!.state).toBe('UNCERTAIN');expect(f.tables.notificationIntent![0]!.state).toBe('DELIVERED');expect(f.tables.notificationCooldown).toEqual(before);expect(update?.mode).toBe('UPDATE');
});
it('filters multiple subjects by exact qualifying UUID and source category, not an event-wide AI description',async()=>{
 const f=await fixture(),analysis=f.complete();analysis.objectAnalyses.unshift({...analysis.objectAnalyses[0]!,objectId:'other',shortDescription:'A person is running.'});const payload=enrichmentPayload(f.initial.payload,analysis,f.now(),f.now());expect(payload).toBeNull();f.advance(1);const acceptedPayload=enrichmentPayload(f.initial.payload,analysis,new Date(f.now().getTime()-10001),f.now());expect(acceptedPayload?.ai.summary).toBe('A person appears to be walking.');expect(acceptedPayload?.enrichment?.objectIds).toEqual([f.source.objects[0]!.id]);
});

it('requires useful accepted detail in the description, including vehicle colour when no useful action exists',async()=>{
 const f=await fixture(),analysis=f.complete('A person can be seen.');analysis.objectAnalyses[0]!.actions=['unknown'];expect(enrichmentPayload(f.initial.payload,analysis,new Date(0),f.now())).toBeNull();
 const initial={...f.initial.payload,objects:f.initial.payload.objects.map(o=>({...o,category:'MOTOR_VEHICLE' as const}))};
 const vehicle={...analysis,subjects:[{objectId:initial.objects[0]!.id,vehicle:{color:'white',vehicleType:'car'},person:null}],objectAnalyses:[{...analysis.objectAnalyses[0]!,observedType:'motor_vehicle',actions:['visible'],shortDescription:'A white car is visible.'}]};
 expect(enrichmentPayload(initial,vehicle,new Date(0),f.now())?.ai.summary).toBe('A white car is visible.');
 expect(enrichmentPayload(initial,{...vehicle,subjects:[]},new Date(0),f.now())).toBeNull();
});
