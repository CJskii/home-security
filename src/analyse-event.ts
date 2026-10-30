import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {loadConfig} from './config.js';
import {createDatabase} from './database.js';
import {createNvrApi} from './events/nvr-service.js';
import {inspectFrame,type MemoryFrame} from './uniview/ingest.js';
import {createVisionClient} from './ai/client.js';
import {analyseEvidence,createEventAnalyser} from './ai/analysis.js';
const usage='node --env-file=.env.local dist/analyse-event.js --event <UUID> --installation <UUID> [--persist]';
export function parseAnalysisArguments(args:string[]) {
  const flags:Record<string,string|boolean>={};
  for(let i=0;i<args.length;i++){
    const key=args[i];if(key==='--persist' && flags.persist===undefined)flags.persist=true;
    else if((key==='--event'||key==='--installation') && flags[key.slice(2)]===undefined)flags[key.slice(2)]=args[++i]??'';
    else throw new Error('Invalid selected analysis arguments');
  }
  return z.object({event:z.uuid(),installation:z.uuid(),persist:z.boolean().default(false)}).strict().parse(flags);
}
export async function runAnalysisCommand(args:string[],env:NodeJS.ProcessEnv) {
  const selected=parseAnalysisArguments(args),config=loadConfig(env);
  if(config.UNIVIEW_INSTALLATION_ID!==selected.installation || !config.AI_BASE_URL || !config.AI_MODEL)throw new Error('Selected analysis configuration mismatch');
  const database=createDatabase(config),nvr=createNvrApi(config,database),frames:MemoryFrame[]=[];
  const signal=AbortSignal.timeout(config.AI_TIMEOUT_MS+60000);
  try {
    const event=await database.events!.get(selected.event),source=await database.analysis!.source(selected.event);
    if(!event || !source || event.sourceInstallationId!==selected.installation || !nvr)throw new Error('Selected event unavailable');
    const snapshots=z.array(z.object({id:z.uuid(),imageType:z.string(),imageOrdinal:z.number().int(),sourceImageIndex:z.number().int().nullable(),
      origin:z.literal('NVR_PUSH'),capturedAt:z.date().nullable(),acquiredAt:z.date().nullable()}).passthrough()).max(65).parse(event.snapshots);
    // Use exact object-associated references, with the same inference bounds.
    const targets=source.facts.targets;
    if(!Array.isArray(targets)||!targets.length||targets.length>4||source.facts.targetsTruncated===true)throw new Error('Selected object evidence unavailable');
    const hashes=new Set(targets.flatMap(t=>[t.fullFrameSha256,t.cropSha256]));
    const chosen=snapshots.filter(s=>hashes.has(s.sha256));
    if(chosen.length>6)throw new Error('Selected image limit exceeded');
    for(const s of chosen){const bytes=await nvr.image(selected.event,s.id,signal);frames.push(inspectFrame(bytes,{imageOrdinal:s.imageOrdinal,sourceImageIndex:s.sourceImageIndex,imageType:s.imageType,
      declaredWidth:null,declaredHeight:null,capturedAt:s.capturedAt,origin:'NVR_PUSH',sha256:null,bytes:null,width:null,height:null,status:'FAILED',requestedAt:null,acquiredAt:s.acquiredAt,failureCode:null},config));}
    const client=createVisionClient(config.AI_BASE_URL,config.AI_MODEL,config.AI_BEARER_TOKEN);
    if(selected.persist){const outcome=await createEventAnalyser(config,database.analysis!,client).analyse(selected.event,frames,signal,{reprocess:true});
      await database.evidence!.finish(selected.event,outcome.status,outcome.reason,new Date());return {eventId:selected.event,persist:true,...outcome};}
    const {result}=await analyseEvidence(config,client,frames,source.facts,signal);
    return {eventId:selected.event,persist:false,status:'COMPLETE',objects:result.objects.map(o=>({objectId:o.objectId,verification:o.verification,actions:o.actions}))};
  }finally{frames.length=0;await nvr?.close();await database.disconnect();}
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 if(process.argv.length===3 && process.argv[2]==='--help')process.stdout.write(usage+'\nDefault: evaluation only. No notifications or media files. --persist reprocesses this event only.\n');
 else void runAnalysisCommand(process.argv.slice(2),process.env).then(report=>{process.stdout.write(JSON.stringify(report)+'\n');if(report.status!=='COMPLETE')process.exitCode=2;}).catch(()=>{process.stderr.write('Selected analysis failed; details withheld.\n');process.exitCode=1;});
}
