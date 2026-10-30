import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createVisionClient } from '../src/ai/client.js';
import { normalisePerson } from '../src/ai/observations.js';
import { richPersonSchema } from '../src/ai/observations.js';
function compact(o:Record<string,unknown>){const {attributeEvidence,uncertainties,person,vehicle,relationship,...rest}=o;void uncertainties;
 const e=attributeEvidence as Record<string,{confidence:number|null}>;
 const attrs=(value:unknown)=>Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k,{value:v,confidence:e[k]?.confidence??null}]));
 return {...rest,...(person?{person:attrs(person)}:{}),...(vehicle?{vehicle:attrs(vehicle)}:{}),...(relationship?{relationship:{value:relationship,confidence:e.relationship?.confidence??null}}:{}),confidence:{observedType:e.observedType?.confidence??null,verification:e.verification?.confidence??null,actions:e.actions?.confidence??null}};}

const image=()=>sharp({create:{width:64,height:32,channels:3,background:'#777'}}).jpeg().toBuffer();
it('retained transport verifies vision and sends bounded structured multi-image requests', async () => {
  const output = { objects: [], shortDescription: 'A person stands.', detailedDescription: 'One visible person stands.', activityLabel: 'standing',
    subjects: [{ type: 'person', count: 1 }], movementDirection: null, uncertainties: [] };
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ capabilities: ['vision', 'completion'] }))
    .mockResolvedValueOnce(Response.json({ model: 'local-vision', done: true, message: { content: JSON.stringify({objects:output.objects}) } }));
  const client = createVisionClient('http://invalid', 'local-vision', undefined, request);
  const result = await client.analyse([await image(), await image()], 'visible facts only', new AbortController().signal);
  expect(result.objects).toEqual([]);
  expect(String(request.mock.calls[0]![0])).toContain('/api/show');
  const body = JSON.parse(String(request.mock.calls[1]![1]!.body)); expect(body.messages[0].images).toHaveLength(2); expect(body.format.type).toBe('object');
  expect(body.options.num_ctx).toBe(16384); expect(body.keep_alive).toBe(0);
  request.mockResolvedValueOnce(Response.json({ private: 'raw-model-output' }));
  await expect(client.analyse([await image()], 'prompt', new AbortController().signal)).rejects.toThrow('invalid_model_output');
});
it('text-only backend is rejected before sending any images or prompt', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ capabilities: ['completion'] }));
  await expect(createVisionClient('http://invalid', 'text-model', undefined, request).analyse([Buffer.from('private-image')], 'private-prompt', new AbortController().signal)).rejects.toThrow('model_not_vision');
  expect(request).toHaveBeenCalledTimes(1); expect(String(request.mock.calls[0]![1]!.body)).not.toMatch(/private-image|private-prompt/);
});
it('preserved observation normalisation withholds monochrome garment colours', () => {
  const person = richPersonSchema.parse({ upperClothing: 'shirt', lowerClothing: null, clothingColors: ['red'], carriedObjects: [], supplementary: {},
    upperColor: 'red', lowerColor: null, outerwear: null, headwear: null, bags: [], accessories: [], visibleActions: [], facingDirection: 'unknown',
    attribution: 'reliable', visibility: 'clear', limitations: [], attributeEvidence: { upperColor: { basis: 'direct_visual', confidence: 'high', uncertainty: null } },
  });
  expect(normalisePerson(person, 'monochrome', 'adequate')).toMatchObject({ upperColor: null, clothingColors: [] });
});
it('constrains object UUIDs and evidence indices in the actual model response schema',async()=>{
 const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb',object={objectId:id,observedType:'person',verification:'supported',actions:['visible'],evidenceImages:[1],person:{upperClothing:null,lowerClothing:null,upperColor:null,lowerColor:null,outerwear:null,headwear:null,bags:[],accessories:[],carriedObjects:[]},vehicle:null,attributeEvidence:{},shortDescription:'A person is visible.',relationship:null,uncertainties:[]};
 const assessment=object;
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({capabilities:['vision']})).mockResolvedValueOnce(Response.json({model:'vision',done:true,message:{content:JSON.stringify({objects:[compact(assessment)]})}}));
 const client=createVisionClient('http://invalid','vision',undefined,request);expect((await client.analyse([await image()],'objects only',new AbortController().signal,[id])).objects[0]!.objectId).toBe(id);
 const body=JSON.parse(String(request.mock.calls[1]![1]!.body));expect(body.format.properties.objects.items.oneOf[0].properties.objectId.enum).toEqual([id]);expect(body.format.properties.objects.items.oneOf[0].properties.evidenceImages.items.maximum).toBe(1);
 request.mockResolvedValueOnce(Response.json({model:'vision',done:true,message:{content:JSON.stringify({objects:[{...compact(assessment),objectId:'27b01e57-cc3d-4db5-9bdd-f7d89e8149bb'}]})}}));
 await expect(client.analyse([await image()],'objects only',new AbortController().signal,[id])).rejects.toThrow('invalid_model_output');
});
it('recovers malformed short text while retaining strict structured data and exact IDs',async()=>{
 const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
 const object={objectId:id,observedType:'person',verification:'uncertain',actions:['visible'],evidenceImages:[1],person:{upperClothing:null,lowerClothing:null,upperColor:null,lowerColor:null,outerwear:null,headwear:null,bags:[],accessories:[],carriedObjects:[]},vehicle:null,relationship:null,attributeEvidence:{},shortDescription:null,uncertainties:[]};
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({capabilities:['vision']})).mockResolvedValueOnce(Response.json({model:'vision',done:true,message:{content:JSON.stringify({objects:[compact(object)]})}}));
 const result=await createVisionClient('http://invalid','vision',undefined,request).analyse([await image()],'one short sentence',new AbortController().signal,[id]);
 expect(result.objects[0]).toMatchObject({objectId:id,shortDescription:'',actions:['visible']});
 const body=JSON.parse(String(request.mock.calls[1]![1]!.body));expect(JSON.stringify(body.format)).not.toMatch(/detailedDescription|continuity|movementDirection|propertyNames/);
});

it('collects only validated numeric Ollama telemetry, converting nanoseconds to milliseconds',async()=>{
 const raw={model:'vision',done:true,message:{content:'{"objects":[]}'},prompt_eval_count:2010,eval_count:180,prompt_eval_duration:4500000000,eval_duration:3400000000,total_duration:9000000000,private:'not telemetry'};
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({capabilities:['vision']})).mockResolvedValue(Response.json(raw));
 const client=createVisionClient('http://invalid','vision',undefined,request),report=vi.fn();
 await client.analyse([await image()],'private prompt',new AbortController().signal,undefined,report);
 expect(report).toHaveBeenCalledWith({promptTokens:2010,generatedTokens:180,inputProcessingMs:4500,generationMs:3400,totalInferenceMs:9000});
 request.mockResolvedValueOnce(Response.json({...raw,prompt_eval_count:-1}));
 await client.analyse([await image()],'private prompt',new AbortController().signal,undefined,report);
 expect(report.mock.lastCall![0]).toEqual({promptTokens:null,generatedTokens:null,inputProcessingMs:null,generationMs:null,totalInferenceMs:null});
 request.mockResolvedValueOnce(Response.json({...raw,message:{content:'invalid JSON'}}));
 await expect(client.analyse([await image()],'private prompt',new AbortController().signal,undefined,report)).rejects.toThrow('invalid_model_output');
 expect(report).toHaveBeenCalledTimes(3);
 expect(JSON.stringify(report.mock.calls)).not.toMatch(/private|message|content/);
 request.mockResolvedValueOnce(Response.json(raw));
 await client.analyse([await image()],'private prompt',new AbortController().signal,undefined,()=>{throw new Error('metrics unavailable');});
});
it('resizes a 4K scene in RAM but submits the matching native crop byte-for-byte, even above scene bounds',async()=>{
 const scene=await sharp({create:{width:3840,height:2160,channels:3,background:'#777'}}).jpeg().toBuffer();
 const crop=await sharp({create:{width:400,height:1200,channels:3,background:'#555'}}).jpeg().toBuffer();
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({capabilities:['vision']})).mockResolvedValueOnce(Response.json({model:'vision',done:true,message:{content:'{"objects":[]}'}}));
 await createVisionClient('http://invalid','vision',undefined,request).analyse([scene,crop],'same moment',new AbortController().signal,undefined,undefined,[2]);
 const body=JSON.parse(String(request.mock.calls[1]![1]!.body));
 expect(body.messages[0].images).toHaveLength(2);
 expect(await sharp(Buffer.from(body.messages[0].images[0],'base64')).metadata()).toMatchObject({width:1024,height:576,format:'jpeg'});
 expect(Buffer.from(body.messages[0].images[1],'base64')).toEqual(crop);
 expect(JSON.stringify(body.options)).not.toMatch(/image.*tokens/);
});
