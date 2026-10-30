import {z} from 'zod';
import {expect,it,vi} from 'vitest';
import {visualObjectSchema,visualResponseSchema,type VisualObject} from '../src/ai/visual-schema.js';
import {compactResponseSchema} from '../src/ai/compact-schema.js';
import {groundedResult,linkedTargets} from '../src/ai/grounding.js';
import {analysisPrompt,selectEvidence} from '../src/ai/evidence.js';
import {createAnalysisStore} from '../src/ai/store.js';
import {presentEvent} from '../src/events/presentation.js';
import type {PrismaClient} from '../src/generated/prisma/client.js';
const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb',event='27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const evidence=[{image:1,role:'scene',origin:'NVR_PUSH',sha256:'scene'},{image:2,role:'object_crop',origin:'NVR_PUSH',sha256:'crop'},{image:3,role:'object_crop',origin:'NVR_PUSH',sha256:'another'}];
const targets=linkedTargets({targets:[{objectId:id,category:'person',fullFrameSha256:'scene',cropSha256:'crop',rectangle:{xMin:1}}]},evidence);
const field=()=>({basis:'direct_visual' as const,confidence:80,evidenceImages:[2],uncertainty:null});
function person():VisualObject {return {objectId:id,observedType:'person',verification:'supported',actions:['standing'],evidenceImages:[1,2],
 person:{upperClothing:'jacket',lowerClothing:null,upperColor:'blue',lowerColor:null,outerwear:null,headwear:null,bags:[],accessories:[],carriedObjects:[]},vehicle:null,
 attributeEvidence:{observedType:field(),verification:field(),actions:field(),upperClothing:field(),upperColor:field()},
 shortDescription:'A person is standing in a blue jacket.',relationship:null,uncertainties:[]};}
const run=(o=person())=>groundedResult({objects:[o]},evidence,targets);
it('strict wire schema has a single description and attributes but no temporal fields; confidence is bounded',()=>{
 expect(visualObjectSchema.parse(person())).toEqual(person());
 for(const v of [{...person(),continuity:'supported'},{...person(),movementDirection:'left'},{...person(),actions:['parking']},{...person(),detailedDescription:'Legacy detail'}])expect(visualObjectSchema.safeParse(v).success).toBe(false);
 for(const confidence of [-1,101,0.5]){const p=person();p.attributeEvidence.upperColor!.confidence=confidence;expect(visualObjectSchema.safeParse(p).success).toBe(false);}
 expect(visualResponseSchema.safeParse({objects:[{...person(),identity:'someone'}]}).success).toBe(false);
});
it('retains one generated description and independent attributes despite unrelated uncertainty',()=>{
 const p=person();p.uncertainties=['Lower clothing is unclear.'];const r=run(p);
 expect(r.shortDescription).toBe(p.shortDescription);expect(r).not.toHaveProperty('detailedDescription');expect(r.objects[0]).not.toHaveProperty('continuity');expect(r.objects[0]!.actions).toEqual(['standing']);expect(r.subjects[0]).toMatchObject({objectId:id,person:{upperColor:'blue'}});
});
it('null is unassessed; rejected attributes cannot survive in descriptions, supported actions remain',()=>{
 const p=person();p.attributeEvidence.upperColor={basis:'unknown',confidence:null,evidenceImages:[],uncertainty:'Monochrome image.'};
 const r=run(p);expect(r.subjects[0]).toMatchObject({person:{upperColor:null},attributeEvidence:{upperColor:{confidence:null}}});expect(r.shortDescription).toBe('A person is standing in a jacket.');expect(r.shortDescription).not.toContain('blue');expect(r.objects[0]!.actions).toEqual(['standing']);
});
it('rejects invalid/foreign evidence, duplicate or missing canonical IDs and category mismatch',()=>{
 for(const mutate of [(p:VisualObject)=>{p.objectId=event;},(p:VisualObject)=>{p.evidenceImages=[3];},(p:VisualObject)=>{p.attributeEvidence.upperColor!.evidenceImages=[3];},(p:VisualObject)=>{p.person=null;}]){const p=person();mutate(p);expect(()=>run(p)).toThrow();}
 expect(()=>groundedResult({objects:[person(),person()]},evidence,targets)).toThrow();expect(()=>groundedResult({objects:[]},evidence,targets)).toThrow();
});
it('supports nullable vehicle make/model independently, normalizes vocabulary, removes incompatible actions',()=>{
 const p=person();p.observedType='motor_vehicle';p.person=null;p.vehicle={vehicleType:'car',make:'Nissan',model:null,color:'gray'};p.actions=['visible'];p.attributeEvidence={observedType:field(),verification:field(),actions:field(),vehicleType:field(),make:field(),color:field()};p.shortDescription='A grey Nissan car is visible.';
 const t=[{...targets[0]!,category:'motor_vehicle'}],r=groundedResult({objects:[p]},evidence,t);expect(r.subjects[0]).toMatchObject({vehicle:{make:'Nissan',model:null,color:'grey'}});expect(r).not.toHaveProperty('detailedDescription');expect(r.objects[0]).not.toHaveProperty('continuity');
 p.actions=['standing'];expect(groundedResult({objects:[p]},evidence,t).objects[0]!.actions).toEqual(['unknown']);
});
it('filters temporal prose, unstructured invented appearance and unqualified walking without killing valid posture',()=>{
 for(const text of ['A person is entering the garden.','A person is wearing a red coat.','A person is walking.']){const p=person();p.shortDescription=text;p.actions=['walking'];const r=run(p);expect(r.shortDescription).toBe('A person appears to be walking in a blue jacket.');expect(r.objects[0]).not.toHaveProperty('movementDirection');}
 const p=person();p.actions=['walking'];p.shortDescription='A person appears to be walking in a blue jacket.';expect(run(p).shortDescription).toBe(p.shortDescription);
});
it('missing direct action evidence affects actions only, not clothing; other requires an explanation',()=>{
 const p=person();delete p.attributeEvidence.actions;const r=run(p);expect(r.objects[0]!.actions).toEqual(['unknown']);expect(r.subjects[0]).toMatchObject({person:{upperClothing:'jacket'}});
 const q=person();q.actions=['other'];expect(()=>run(q)).toThrow();
});
it('new data persists atomically in existing JSON/objects and is joined in API; historical subjects stay readable',async()=>{
 const r=run();const tx={evidenceProcessing:{updateMany:vi.fn(async()=>({count:1}))},eventAnalysis:{upsert:vi.fn(async()=>({}))},objectAnalysis:{deleteMany:vi.fn(async()=>({})),createMany:vi.fn(async()=>({}))}};
 await createAnalysisStore({$transaction:async(f:(t:typeof tx)=>Promise<unknown>)=>f(tx)} as unknown as PrismaClient).save({eventId:event,model:'vision',inputFingerprint:'a'.repeat(64),promptVersion:4,schemaVersion:3,result:r,evidence,completedAt:new Date()});
 expect(tx.eventAnalysis.upsert).toHaveBeenCalledWith(expect.objectContaining({create:expect.objectContaining({subjects:r.subjects}),update:expect.objectContaining({subjects:r.subjects,revision:{increment:1}})}));expect(tx.objectAnalysis.createMany).toHaveBeenCalledWith({data:[expect.objectContaining({objectId:id,shortDescription:r.shortDescription})]});
 const api=presentEvent({id:event,objects:[{id,category:'PERSON'}],analysis:{...r,objectAnalyses:r.objects}});expect(api.objects[0]!.analysis).toMatchObject({person:{upperClothing:'jacket'},attributeEvidence:{upperClothing:{confidence:80}}});
 const old=presentEvent({id:event,objects:[{id,category:'PERSON'}],analysis:{schemaVersion:2,subjects:[{type:'person',count:1}],objectAnalyses:r.objects}});expect((old.analysis as Record<string,unknown>)?.subjects).toEqual([{type:'person',count:1}]);expect(old.objects[0]!.analysis).not.toHaveProperty('person');
});
it('prompt labels original full/crop as the same moment and omits temporal response properties',()=>{
 expect(analysisPrompt([],{},1)).toContain('SAME capture moment');expect(selectEvidence([]).sceneCount).toBe(0);
});

it('wire grammar uses explicit field names and category branches, never propertyNames-only evidence',()=>{
 const json=z.toJSONSchema(compactResponseSchema([id],2,true)),serialized=JSON.stringify(json);
 expect(serialized).not.toContain('propertyNames');expect(serialized).toContain('upperClothing');expect(json.properties).toBeDefined();expect(serialized).toContain('oneOf');
 const p={objectId:id,observedType:'person',verification:'supported',actions:['visible'],evidenceImages:[2],shortDescription:'A person is visible.',person:{},confidence:{observedType:80,verification:80,actions:80}};expect(compactResponseSchema([id],2,true).safeParse({objects:[p]}).success).toBe(true);
 expect(compactResponseSchema([id],2,true).safeParse({objects:[{...p,vehicle:{vehicleType:null,color:null,make:null,model:null}}]}).success).toBe(false);
});
it('mixed objects keep independent attributes and reject borrowing another crop',()=>{
 const p=person(),v:VisualObject={...person(),objectId:event,observedType:'motor_vehicle',person:null,vehicle:{vehicleType:'van',color:'white',make:null,model:null},actions:['visible'],evidenceImages:[1,3],attributeEvidence:{observedType:{...field(),evidenceImages:[3]},verification:{...field(),evidenceImages:[3]},actions:{...field(),evidenceImages:[3]},vehicleType:{...field(),evidenceImages:[3]},color:{...field(),evidenceImages:[3]}},shortDescription:'A white van is visible.'};
 const t=linkedTargets({targets:[...targets,{objectId:event,category:'motor_vehicle',fullFrameSha256:'scene',cropSha256:'another'}]},evidence);
 const r=groundedResult({objects:[p,v]},evidence,t);expect(r.subjects).toEqual([expect.objectContaining({objectId:id,person:{...p.person}}),expect.objectContaining({objectId:event,vehicle:{...v.vehicle}})]);
 p.evidenceImages=[1,3];expect(()=>groundedResult({objects:[p,v]},evidence,t)).toThrow();
});
it('unknown strings become null with unassessed confidence instead of a guessed vehicle make',()=>{
 const p:VisualObject={...person(),observedType:'motor_vehicle',person:null,vehicle:{vehicleType:null,color:null,make:'unknown',model:null},actions:['visible'],attributeEvidence:{observedType:field(),verification:field(),actions:field(),make:field()},shortDescription:'A vehicle is visible.'};
 const r=groundedResult({objects:[p]},evidence,[{...targets[0]!,category:'motor_vehicle'}]);expect(r.subjects[0]).toMatchObject({vehicle:{make:null},attributeEvidence:{make:{basis:'unknown',confidence:null}}});
});
it('invalid description is recovered without discarding valid fields; wire remains bounded',()=>{
 for(const shortDescription of ['',null,42,{},'A person is stationary.','A person is motionless.','A person is visible in a cropped image.','A person is standing. They are walking away.','x'.repeat(300)]){
  const r=groundedResult({objects:[{...person(),shortDescription}]},evidence,targets);
  expect(r.shortDescription).toBe('A person is standing in a blue jacket.');expect(r.subjects[0]).toMatchObject({person:{upperColor:'blue'},attributeEvidence:{upperColor:{confidence:80}}});
 }
 expect(compactResponseSchema([id],2,true).safeParse({objects:[{...person(),shortDescription:null}]}).success).toBe(false);
});
it('withholding an unmentioned attribute does not replace a valid action sentence',()=>{
 const p=person();p.attributeEvidence.upperColor={basis:'unknown',confidence:null,evidenceImages:[],uncertainty:'Colour uncertain.'};p.shortDescription='A person is standing.';
 const r=run(p);expect(r.shortDescription).toBe(p.shortDescription);expect(r.objects[0]!.uncertainties).toEqual([]);expect(r.subjects[0]).toMatchObject({person:{upperColor:null,upperClothing:'jacket'}});
});
it('supports one evidenced spatial relationship and serializes it in subjects/object API',()=>{
 const p=person();p.relationship={kind:'beside',object:'vehicle'};p.attributeEvidence.relationship=field();p.shortDescription='A person is standing beside a vehicle.';
 const r=run(p);expect(r.shortDescription).toBe(p.shortDescription);expect(r.subjects[0]).toMatchObject({relationship:p.relationship});
 const api=presentEvent({id:event,objects:[{id,category:'PERSON'}],analysis:{...r,objectAnalyses:r.objects}});expect(api.objects[0]!.analysis).toMatchObject({relationship:p.relationship});
 delete p.attributeEvidence.relationship;const rejected=run(p);expect(rejected.shortDescription).toBe('A person is standing in a blue jacket.');expect(rejected.subjects[0]).toMatchObject({relationship:null});
});
it('rejects relational prose without matching structured facts and stationary vehicle claims',()=>{
 const p=person();p.shortDescription='A person is standing near a bin.';expect(run(p).shortDescription).toBe('A person is standing in a blue jacket.');
 const v:VisualObject={...person(),observedType:'motor_vehicle',person:null,vehicle:{vehicleType:'car',color:'black',make:null,model:null},actions:['visible'],attributeEvidence:{observedType:field(),verification:field(),actions:field(),vehicleType:field(),color:field()},shortDescription:'A black car is stationary.'};
 expect(groundedResult({objects:[v]},evidence,[{...targets[0]!,category:'motor_vehicle'}]).shortDescription).toBe('A black car is visible.');
});
it('an older schema-3 subject without a relationship remains readable',()=>{
 const r=run(),subject={...r.subjects[0]};delete (subject as Record<string,unknown>).relationship;
 const api=presentEvent({id:event,objects:[{id,category:'PERSON'}],analysis:{schemaVersion:3,subjects:[subject],objectAnalyses:r.objects}});
 expect(api.objects[0]!.analysis).toMatchObject({person:{upperColor:'blue'},relationship:null});
});

it('description verbs and relationship targets must agree with structured facts',()=>{
 const p=person();p.shortDescription='A person walks.';expect(run(p).shortDescription).toBe('A person is standing in a blue jacket.');
 p.relationship={kind:'near',object:'vehicle'};p.attributeEvidence.relationship=field();p.shortDescription='A person is standing near a bin.';
 expect(run(p).shortDescription).toBe('A person is standing in a blue jacket near a vehicle.');
});
it('a partially invalid list is withheld consistently with its field confidence',()=>{
 const p=person();p.person!.carriedObjects=['bag','unicorn'];p.attributeEvidence.carriedObjects=field();p.shortDescription='A person is standing.';
 const r=run(p);expect(r.shortDescription).toBe(p.shortDescription);expect(r.subjects[0]).toMatchObject({person:{carriedObjects:[]},attributeEvidence:{carriedObjects:{confidence:null,basis:'unknown'}}});
});

it('preserves capitalized ordinary subject nouns without allowing invented makes or names',()=>{
 for(const description of ['Person is standing in a blue jacket.','The person is standing in a blue jacket.','Individual is standing.']){
  const p=person();p.shortDescription=description;const r=run(p);expect(r.shortDescription).toBe(description);
  expect(r.subjects[0]?.diagnostics?.some(d=>d.code==='description_rule_failure')).toBe(false);
 }
 const p=person();p.shortDescription='A person named Morgan is standing.';
 expect(run(p).subjects[0]?.diagnostics).toContainEqual({field:'shortDescription',code:'description_rule_failure',rules:['unsupported_name']});
});
it('keeps direction, temporal, inconsistent attributes and invented interactions out of recovered prose',()=>{
 for(const [description,reason] of [
  ['A person walks towards the gate.','temporal_claim'],
  ['A person is arriving.','temporal_claim'],
  ['A person is standing in a red jacket.','attribute_mismatch'],
  ['A person opens a vehicle door.','unsupported_interaction'],
  ['A person is holding a bag.','attribute_mismatch'],
 ] as const){const p=person();p.shortDescription=description;const r=run(p);expect(r.shortDescription).toBe('A person is standing in a blue jacket.');expect(r.subjects[0]?.diagnostics).toContainEqual(expect.objectContaining({field:'shortDescription',rules:expect.arrayContaining([reason])}));}
});
it('vehicle prose cannot invent a subtype or unsupported make/model',()=>{
 const v:VisualObject={...person(),observedType:'motor_vehicle',person:null,vehicle:{vehicleType:'van',color:'white',make:null,model:null},actions:['visible'],attributeEvidence:{observedType:field(),verification:field(),actions:field(),vehicleType:field(),color:field()}};
 for(const description of ['A white Tesla van is visible.','A white van model fiesta is visible.','A white car is visible.']){
  v.shortDescription=description;const r=groundedResult({objects:[v]},evidence,[{...targets[0]!,category:'motor_vehicle'}]);expect(r.shortDescription).toBe('A white van is visible.');expect(r.subjects[0]?.vehicle).toEqual(v.vehicle);
 }
 v.shortDescription='Van is visible.';expect(groundedResult({objects:[v]},evidence,[{...targets[0]!,category:'motor_vehicle'}]).shortDescription).toBe(v.shortDescription);
});
it('audit-style person fallback uses accepted garments without recovering withheld colours or bags',()=>{
 const p=person();p.actions=['walking'];p.person={...p.person!,upperClothing:'jacket',lowerClothing:'trousers',upperColor:'magenta',lowerColor:'black',bags:['unicorn']};
 p.attributeEvidence.lowerClothing=field();p.attributeEvidence.lowerColor={...field(),confidence:0};p.attributeEvidence.bags=field();p.shortDescription='A person is walking in magenta clothing with a bag.';
 const r=run(p);expect(r.shortDescription).toBe('A person appears to be walking in a jacket and trousers.');
 expect(r.subjects[0]).toMatchObject({person:{upperClothing:'jacket',lowerClothing:'trousers',upperColor:null,lowerColor:null,bags:[]},diagnostics:expect.arrayContaining([{field:'upperColor',code:'unsupported_vocabulary'},{field:'lowerColor',code:'insufficient_confidence'},{field:'bags',code:'unsupported_vocabulary'}])});
 expect(JSON.stringify(r.subjects[0]?.diagnostics)).not.toMatch(/magenta|unicorn|black/);
});
it('records missing field evidence without lowering confidence requirements for supported attributes',()=>{
 const p=person();delete p.attributeEvidence.upperColor;p.person!.headwear='hat';p.attributeEvidence.headwear={...field(),confidence:55};
 const r=run(p);expect(r.subjects[0]).toMatchObject({person:{upperColor:null,upperClothing:'jacket',headwear:'hat'},attributeEvidence:{headwear:{confidence:55}},diagnostics:expect.arrayContaining([{field:'upperColor',code:'missing_evidence'}])});
});
