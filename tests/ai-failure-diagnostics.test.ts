import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import sharp from 'sharp';
import {failureDiagnostic, schemaFailure} from '../src/ai/failure-diagnostics.js';
import {createVisionClient,VisionError} from '../src/ai/client.js';
import {decodeCompactResponse} from '../src/ai/compact-schema.js';
import {groundedResult,linkedTargets} from '../src/ai/grounding.js';
const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const evidence=[{image:1,role:'scene',origin:'NVR_PUSH',sha256:'scene'},{image:2,role:'object_crop',origin:'NVR_PUSH',sha256:'crop'}];
const target=linkedTargets({targets:[{objectId:id,category:'non_motor_vehicle',fullFrameSha256:'scene',cropSha256:'crop',rectangle:{xMin:1000,yMin:2000,xMax:3000,yMax:6000}}]},evidence);
const object=()=>({objectId:id,observedType:'non_motor_vehicle',verification:'supported',vehicle:{vehicleType:{value:'bicycle',confidence:80}},actions:['visible'],evidenceImages:[1,2],confidence:{observedType:90,verification:85,actions:80},shortDescription:'A bicycle is visible.'});
it('bounds failure fields and never retains private values, issue messages or arbitrary keys',()=>{
 const privateValue='private-response-password-/9j/';
 const error=z.object({objects:z.array(z.object({confidence:z.number()}))}).safeParse({objects:Array.from({length:20},()=>({confidence:privateValue}))});
 if(error.success)throw Error('Expected rejection');
 const d=schemaFailure('compact_schema',error.error);expect(d.issues).toHaveLength(8);expect(d.truncated).toBe(true);expect(d.issues[0]).toEqual({field:'objects.[0].confidence',code:'invalid_type'});expect(JSON.stringify(d)).not.toContain(privateValue);
 const nested=z.record(z.string(),z.number()).safeParse({[privateValue]:'private'});if(nested.success)throw Error('Expected rejection');expect(schemaFailure('compact_schema',nested.error).issues[0]!.field).toBe('?');
 expect(failureDiagnostic('grounding','unsupported_field',['objects',0,privateValue]).issues[0]!.field).toBe('objects.[0].?');
});
it('accepts a correctly represented source non-motor vehicle without relaxing source verification',()=>{
 const r=groundedResult(decodeCompactResponse({objects:[object()]},[id],2),evidence,target);
 expect(r.objects[0]).toMatchObject({objectId:id,observedType:'non_motor_vehicle',verification:'supported'});expect(r.subjects[0]!.vehicle?.vehicleType).toBe('bicycle');
 for(const changed of [{verification:'contradicted'},{observedType:'motor_vehicle'}]){
  try{groundedResult(decodeCompactResponse({objects:[{...object(),...changed}]},[id],2),evidence,target);throw Error('Expected rejection');}
  catch(e){expect(e).toBeInstanceOf(VisionError);expect((e as VisionError).diagnostics).toMatchObject({stage:'grounding',issues:[{field:'objects.[0].verification',code:'source_verification'}]});}
 }
});
it('identifies exact-object, image ownership and unexplained action failures without retaining values',()=>{
 const expanded=()=>decodeCompactResponse({objects:[object()]},[id],2);
 const a=expanded();a.objects[0]!.objectId='27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
 expect(()=>groundedResult(a,evidence,target)).toThrowError(expect.objectContaining({diagnostics:expect.objectContaining({issues:[{field:'objects',code:'object_identity'}]})}));
 const b=expanded();b.objects[0]!.evidenceImages=[3];
 expect(()=>groundedResult(b,evidence,target)).toThrowError(expect.objectContaining({diagnostics:expect.objectContaining({issues:[{field:'objects.[0].evidenceImages',code:'evidence_ownership'}]})}));
 const c=expanded();c.objects[0]!.actions=['other'];
 expect(()=>groundedResult(c,evidence,target)).toThrowError(expect.objectContaining({diagnostics:expect.objectContaining({issues:[{field:'objects.[0].actions',code:'action_uncertainty'}]})}));
});
it('distinguishes envelope, JSON and compact field failures through the actual bounded transport',async()=>{
 const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#555'}}).jpeg().toBuffer();
 for(const [raw,stage,field] of [
  [{model:'private-wrong-model',done:true,message:{content:'private'}},'envelope','model'],
  [{model:'vision',done:true,message:{content:'private not JSON'}},'json','message.content'],
  [{model:'vision',done:true,message:{content:JSON.stringify({objects:[{...object(),confidence:{observedType:101,verification:85,actions:80}}]})}},'compact_schema','objects.[0].confidence.observedType'],
 ] as const){
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({capabilities:['vision']})).mockResolvedValueOnce(Response.json(raw));
  let error:unknown;try{await createVisionClient('http://invalid','vision',undefined,request).analyse([bytes,bytes],'private prompt',new AbortController().signal,[id]);}catch(e){error=e;}
  expect(error).toBeInstanceOf(VisionError);const diagnostic=(error as VisionError).diagnostics!;expect(diagnostic.stage).toBe(stage);expect(diagnostic.issues[0]!.field).toBe(field);expect(JSON.stringify(diagnostic)).not.toMatch(/private|prompt|content.*private/);
 }
});
