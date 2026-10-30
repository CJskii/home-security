import{expect,it,vi}from'vitest';
import sharp from'sharp';
import{readFileSync}from'node:fs';
import{prepareImages}from'../src/ai/prepare.js';
import{createAnalysisStore}from'../src/ai/store.js';
import{type AnalysisResult}from'../src/ai/schemas.js';
import{presentEvent}from'../src/events/presentation.js';
import{historySchema}from'../src/events/queries.js';
import{historyFilters}from'../src/events/store.js';
import{parseAnalysisArguments}from'../src/analyse-event.js';
import type{PrismaClient}from'../src/generated/prisma/client.js';
const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb',other='27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const evidence=[{image:1,role:'scene',origin:'NVR_PUSH',sha256:'scene'},{image:2,role:'object_crop',origin:'NVR_PUSH',sha256:'crop'},{image:3,role:'scene',origin:'NVR_LIVE',sha256:'later'}];
const output=():AnalysisResult=>({activityLabel:'leaving',shortDescription:'A person walks away.',subjects:[{type:'person',count:1}],uncertainties:[],objects:[{objectId:id,observedType:'person',verification:'supported',actions:['walking','carrying'],evidenceImages:[1,2,3],shortDescription:'A person walks away carrying an object.',uncertainties:[]}]});
it('RAM image preparation preserves aspect ratio and originals and respects abort/decoder limits',async()=>{
 const original=await sharp({create:{width:1920,height:1080,channels:3,background:'#888'}}).jpeg().toBuffer(),copy=Buffer.from(original);
 const prepared=await prepareImages([original],new AbortController().signal);expect(await sharp(prepared[0]).metadata()).toMatchObject({width:1024,height:576});expect(original).toEqual(copy);
 await expect(prepareImages([original],AbortSignal.abort())).rejects.toThrow();await expect(prepareImages([Buffer.from('invalid')],new AbortController().signal)).rejects.toThrow();
});
it('atomic replacement retains canonical ownership, current result revision and per-object rows',async()=>{
 const tx={evidenceProcessing:{updateMany:vi.fn(async()=>({count:1}))},eventAnalysis:{upsert:vi.fn(async()=>({}))},objectAnalysis:{deleteMany:vi.fn(async()=>({})),createMany:vi.fn(async()=>({}))}};
 const prisma={$transaction:vi.fn(async(work:(t:typeof tx)=>Promise<unknown>)=>work(tx))} as unknown as PrismaClient;
 const store=createAnalysisStore(prisma);expect(await store.save({eventId:other,model:'vision',inputFingerprint:'a'.repeat(64),promptVersion:2,schemaVersion:2,result:output(),evidence,completedAt:new Date()})).toBe(true);
 expect(tx.eventAnalysis.upsert).toHaveBeenCalledWith(expect.objectContaining({where:{eventId:other},update:expect.objectContaining({revision:{increment:1}})}));
 expect(tx.objectAnalysis.createMany).toHaveBeenCalledWith(expect.objectContaining({data:[expect.objectContaining({eventId:other,objectId:id})]}));
 tx.evidenceProcessing.updateMany.mockResolvedValueOnce({count:0});tx.eventAnalysis.upsert.mockClear();expect(await store.save({eventId:other,model:'vision',inputFingerprint:'a'.repeat(64),promptVersion:2,schemaVersion:2,result:output(),evidence,completedAt:new Date()})).toBe(false);expect(tx.eventAnalysis.upsert).not.toHaveBeenCalled();
});
it('query/detail expose fallible object results and SQL-filter the same object without NVR calls',()=>{
 const result=presentEvent({id:other,objects:[{id,category:'PERSON'}],analysis:{evidence:[{...evidence[0],URL:'rtsp://private',Data:'private-media'}],objectAnalyses:[{...output().objects[0],eventId:other}]}});
 expect(JSON.stringify(result.analysis)).not.toContain('private');expect(result.analysis?.evidence[0]).toMatchObject({image:1,role:'scene',sha256:'scene'});
 expect(result.objects[0]).toMatchObject({category:'person',analysis:{verification:'supported',authority:'ai_interpretation'}});
 const sql=historyFilters(historySchema.parse({category:'person',verification:'uncertain',action:'walking'}));expect(sql.map(q=>q.sql).join(' ')).toContain('"ObjectAnalysis"');expect(sql.flatMap(q=>q.values)).toContain('["walking"]');
});
it('migration fences object ownership and only adds metadata; selected reprocessing is explicitly scoped',()=>{
 const sql=readFileSync(new URL('../prisma/migrations/20261015000000_object_action_analysis/migration.sql',import.meta.url),'utf8');
 expect(sql).toContain('FOREIGN KEY ("eventId","objectId")');expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|BYTEA/i);
 expect(parseAnalysisArguments(['--event',id,'--installation',other])).toEqual({event:id,installation:other,persist:false});expect(()=>parseAnalysisArguments(['--all'])).toThrow();
});
it('source lookup uses linked notification-local objects even when no Alarm was received',async()=>{
 const findUnique=vi.fn(async()=>({firstReceivedAt:new Date(),alarmSeen:false,alarmType:'EnterArea',notifications:[{kind:'STRUCTURE',metadata:{},reportedAt:new Date(),personCount:1,vehicleCount:null}],snapshots:[],objects:[{id,category:'PERSON',coordinateStatus:'MISSING',fullFrameSnapshot:{sha256:'scene'},cropSnapshot:{sha256:'crop'}}]}));
 const source=await createAnalysisStore({securityEvent:{findUnique}} as unknown as PrismaClient).source(other);
 expect(source).toMatchObject({confirmed:true,facts:{targets:[{objectId:id,category:'person',fullFrameSha256:'scene',cropSha256:'crop',rectangle:null}]}});
});
