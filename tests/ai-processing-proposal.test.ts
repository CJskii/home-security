import {afterEach,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {processingProposalInput,previewEligibility,createProcessingProposalStore} from '../src/ai/processing-proposal.js';
import type {ObjectLocation} from '../src/uniview/object-location.js';
import type {PrismaClient} from '../src/generated/prisma/client.js';
const id='10000000-0000-4000-8000-000000000000',other='20000000-0000-4000-8000-000000000000',installation='30000000-0000-4000-8000-000000000000';
const proposal={enabled:true,uncertain:'analyse' as const,unmatched:'analyse' as const,zones:[{zoneId:id,enabled:true},{zoneId:other,enabled:false}]};
const location=(status:ObjectLocation['status'],zoneId=other):ObjectLocation=>({status,reason:'test',algorithm:'anchor_consensus_v1',temporalBasis:'observed_configuration_bracket',evaluatedVersionIds:[],matches:status==='MATCHED'?[{zoneId,versionId:id,slot:0,name:'test',interested:false}]:[]});
const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',UNIVIEW_INSTALLATION_ID:installation,EVENTS_TOKEN:'e'.repeat(32),DASHBOARD_ORIGIN:'http://127.0.0.1:5173',DASHBOARD_PASSWORD:'p'.repeat(32),DASHBOARD_SESSION_KEY:'a'.repeat(64),LOG_LEVEL:'silent'});
const apps:ReturnType<typeof buildApp>[]=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(s=>s.app.close()));});
it('previews multi-object and overlapping-zone policy conservatively without touching ingestion',()=>{
 expect(previewEligibility(proposal,[location('MATCHED',id),location('UNKNOWN')])).toEqual({eligible:true,reason:'selected_zone'});
 expect(previewEligibility(proposal,[location('MATCHED')])).toEqual({eligible:false,reason:'zone_not_selected'});
 for(const list of[[],[location('UNKNOWN')],[location('AMBIGUOUS')],[location('MATCHED'),location('UNKNOWN')]])expect(previewEligibility(proposal,list).reason).toBe('uncertain_fallback');
 expect(previewEligibility(proposal,[location('UNMATCHED')]).reason).toBe('unmatched_fallback');
 expect(previewEligibility({...proposal,enabled:false},[location('MATCHED',id)]).reason).toBe('ai_disabled');
 expect(previewEligibility({...proposal,uncertain:'exclude'},[location('UNKNOWN')])).toEqual({eligible:false,reason:'zone_uncertain_not_selected'});
 expect(processingProposalInput.safeParse({...proposal,enforcementAvailable:true}).success).toBe(false);
 expect(processingProposalInput.safeParse({...proposal,zones:[proposal.zones[0],proposal.zones[0]]}).success).toBe(false);
});
it('authenticates reads and protects proposal saves with the existing session/origin boundary',async()=>{
 const read=vi.fn(async()=>({enforcementAvailable:false})),save=vi.fn(async()=>({enforcementAvailable:false}));
 const app=buildApp(config,{processingProposal:{read,save},checkReady:async()=>{},disconnect:async()=>{}});apps.push(app);
 expect((await app.app.inject('/api/ai/processing')).statusCode).toBe(401);expect(read).not.toHaveBeenCalled();
 expect((await app.app.inject({method:'PUT',url:'/api/ai/processing',payload:proposal})).statusCode).toBe(401);
 const login=await app.app.inject({method:'POST',url:'/api/session',headers:{origin:config.DASHBOARD_ORIGIN!},payload:{password:config.DASHBOARD_PASSWORD}}),cookie=login.headers['set-cookie'] as string;
 for(const headers of[{cookie},{cookie,origin:'https://bad.example'},{cookie,origin:config.DASHBOARD_ORIGIN!,'sec-fetch-site':'cross-site'}])expect([401,403]).toContain((await app.app.inject({method:'PUT',url:'/api/ai/processing',headers,payload:proposal})).statusCode);
 expect(save).not.toHaveBeenCalled();
 expect((await app.app.inject({method:'PUT',url:'/api/ai/processing',headers:{cookie,origin:config.DASHBOARD_ORIGIN!},payload:proposal})).json()).toMatchObject({enforcementAvailable:false,writable:true});expect(save).toHaveBeenCalledWith(installation,proposal);
 expect((await app.app.inject({url:'/api/ai/processing',headers:{cookie}})).statusCode).toBe(200);
 expect((await app.app.inject({method:'PUT',url:'/api/ai/processing',headers:{authorization:'Bearer '+config.EVENTS_TOKEN},payload:{...proposal,enforce:true}})).statusCode).toBe(400);
});
it('persists only staged settings, verifies the complete stable zone scope and avoids unchanged writes',async()=>{
 let saved:unknown=null;const upsert=vi.fn(async(args:{create:unknown})=>{saved={...args.create as object,updatedAt:new Date()};return saved;});
 const tx={univiewZone:{findMany:async()=>[{id,channel:1,slot:0,displayName:'A',preference:{interested:false}},{id:other,channel:1,slot:1,displayName:'B',preference:{interested:true}}]},aiProcessingProposal:{findUnique:async()=>saved,upsert}};
 const db={...tx,$transaction:async<T>(fn:(v:typeof tx)=>Promise<T>)=>fn(tx),eventAnalysis:{findFirst:async()=>null},evidenceProcessing:{groupBy:async()=>[]}};
 // Read shape includes presentation-only metadata; no sync/version writes exist.
 const store=createProcessingProposalStore(db as unknown as PrismaClient);
 const initial=await store.read(installation);expect(initial).toMatchObject({configuration:{unmatched:'exclude',uncertain:'analyse',zones:[{zoneId:id,enabled:true},{zoneId:other,enabled:false}]}});
 await store.save!(installation,proposal);expect(upsert).toHaveBeenCalledOnce();
 // Provide Prisma-like persisted timestamp for subsequent read/save.
 saved={sourceInstallationId:installation,configuration:proposal,updatedAt:new Date()};
 await store.save!(installation,proposal);expect(upsert).toHaveBeenCalledOnce();
 await expect(store.save!(installation,{...proposal,zones:[{zoneId:id,enabled:true}]})).rejects.toThrow('Zone catalog changed');
});
