import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {expect,it} from 'vitest';
import {compactResponseSchema,decodeCompactResponse} from '../src/ai/compact-schema.js';
import {groundedResult,linkedTargets} from '../src/ai/grounding.js';
import {analysisPrompt} from '../src/ai/evidence.js';
import {presentEvent} from '../src/events/presentation.js';
const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const evidence=[{image:1,role:'scene',origin:'NVR_PUSH',sha256:'scene'},{image:2,role:'object_crop',origin:'NVR_PUSH',sha256:'crop'},{image:3,role:'object_crop',origin:'NVR_PUSH',sha256:'another'}];
const targets=linkedTargets({targets:[{objectId:id,category:'person',fullFrameSha256:'scene',cropSha256:'crop'}]},evidence);
const object=()=>({objectId:id,observedType:'person',verification:'supported',actions:['standing'],evidenceImages:[2],shortDescription:'A person is standing in a blue jacket.',person:{upperClothing:{value:'jacket',confidence:80},upperColor:{value:'blue',confidence:75}},confidence:{observedType:90,verification:85,actions:80}});
it('compact values/default refs expand without inventing scores for unassessed fields',()=>{
 const raw={objects:[{...object(),uncertainties:{lowerClothing:'Occluded'}}]},expanded=decodeCompactResponse(raw,[id],2);
 expect(expanded.objects[0]).toMatchObject({person:{lowerClothing:null,carriedObjects:[]},vehicle:null,attributeEvidence:{upperColor:{confidence:75,evidenceImages:[2]},lowerClothing:{confidence:null,uncertainty:'Occluded',basis:'unknown'}}});
 const r=groundedResult(expanded,evidence,targets);expect(r.shortDescription).toBe(raw.objects[0]!.shortDescription);expect(r.subjects[0]).toMatchObject({person:{upperColor:'blue'}});
});
it('per-field uncertainty stays independent; shared images and explicit overrides retain ownership',()=>{
 const raw={objects:[{...object(),relationship:{value:{kind:'beside',object:'vehicle'},confidence:80},confidence:object().confidence,fieldImages:{relationship:[1]},shortDescription:'A person is standing beside a vehicle.',uncertainties:{upperColor:'Lighting uncertain'}}]};
 const r=groundedResult(decodeCompactResponse(raw,[id],3),evidence,targets);expect(r.objects[0]!.evidenceImages).toEqual([2,1]);expect(r.subjects[0]).toMatchObject({attributeEvidence:{upperColor:{uncertainty:'Lighting uncertain'},relationship:{evidenceImages:[1]}}});
 raw.objects[0]!.fieldImages.relationship=[3];expect(()=>groundedResult(decodeCompactResponse(raw,[id],3),evidence,targets)).toThrow();
});
it('strict explicit maps, confidence ranges, category branches and IDs are validated',()=>{
 const schema=compactResponseSchema([id],2,true),raw={objects:[object()]};expect(schema.safeParse(raw).success).toBe(true);
 for(const o of [{...object(),vehicle:{}},{...object(),person:{upperColor:{value:'blue',confidence:101}}},{...object(),person:{upperColor:{value:'blue',confidence:0.5}}},{...object(),fieldImages:{upperColor:[3]}},{...object(),confidence:{...object().confidence,typo:80}},{...object(),detailedDescription:'obsolete'}])expect(schema.safeParse({objects:[o]}).success).toBe(false);
 const json=JSON.stringify(z.toJSONSchema(schema));expect(json).not.toMatch(/propertyNames|detailedDescription|continuity|movementDirection/);expect(json).toContain('oneOf');
});
it('nullable make/model can be omitted, with field-specific uncertainty preserved',()=>{
 const o={...object(),observedType:'motor_vehicle',person:undefined,vehicle:{vehicleType:{value:'car',confidence:80},color:{value:'black',confidence:80}},confidence:{observedType:90,verification:90,actions:80},actions:['visible'],shortDescription:'A black car is visible.',uncertainties:{model:'No visible model marking'}};
 const r=groundedResult(decodeCompactResponse(JSON.parse(JSON.stringify({objects:[o]})),[id],2),evidence,[{...targets[0]!,category:'motor_vehicle'}]);expect(r.subjects[0]).toMatchObject({vehicle:{make:null,model:null},attributeEvidence:{model:{confidence:null,uncertainty:'No visible model marking'}}});
});
it('prompt omits hashes and clocks from inference but preserves matching target image IDs',()=>{
 const text=analysisPrompt(evidence,{targets},1);expect(text).not.toContain('"sha256"');expect(text).toContain(id);expect(text).toContain('SAME capture moment');expect(text).toContain('fieldImages');
});
it('forward migration removes only five obsolete AI columns and preserves source data/history',()=>{
 const sql=readFileSync(new URL('../prisma/migrations/20261015010000_short_visual_analysis/migration.sql',import.meta.url),'utf8');
 expect(sql.match(/DROP COLUMN/g)).toHaveLength(5);expect(sql).toContain('ObjectAnalysis_continuity');expect(sql).not.toMatch(/CASCADE|DROP TABLE|DELETE FROM|TRUNCATE|UPDATE /i);
 const prisma=readFileSync(new URL('../prisma/schema.prisma',import.meta.url),'utf8');expect(prisma).not.toMatch(/detailedDescription|movementDirection|continuity/);
 const r=presentEvent({id,objects:[{id,category:'PERSON'}],analysis:{shortDescription:'Historical short',detailedDescription:'Old text',movementDirection:'left',objectAnalyses:[{objectId:id,shortDescription:'Old short',detailedDescription:'Old long',continuity:'uncertain',movementDirection:'left'}]}});
 expect(JSON.stringify(r)).not.toMatch(/detailedDescription|movementDirection|continuity/);
});

it('type-incompatible actions are removed without losing supported vehicle attributes',()=>{
 const raw={objects:[{objectId:id,observedType:'motor_vehicle',verification:'uncertain',evidenceImages:[1,2],vehicle:{vehicleType:{value:'suv',confidence:85},color:{value:'black',confidence:90}},actions:['visible','standing','standing'],confidence:{observedType:85,verification:90,actions:85},shortDescription:'A black SUV is visible.'}]};
 const r=groundedResult(decodeCompactResponse(raw,[id],2),evidence,[{...targets[0]!,category:'motor_vehicle'}]);expect(r.objects[0]!.actions).toEqual(['visible']);expect(r.shortDescription).toBe('A black SUV is visible.');expect(r.subjects[0]).toMatchObject({vehicle:{vehicleType:'suv',color:'black'},attributeEvidence:{actions:{uncertainty:expect.stringContaining('incompatible')}}});
});

it('authenticated event presentation exposes numeric telemetry while historical evidence without it remains readable',()=>{
 const inferenceTelemetry={provider:'ollama',durationUnit:'milliseconds',processingStartedAt:'2026-10-15T00:00:00.000Z',requests:[{requestAttempt:1,promptTokens:2000,generatedTokens:100,inputProcessingMs:4000,generationMs:3000,totalInferenceMs:8000}]};
 const row={id,objects:[],analysis:{promptVersion:4,schemaVersion:3,evidence:[{image:1,role:'scene',inferenceTelemetry}]}};
 expect(presentEvent(row).analysis).toMatchObject({evidence:[{inferenceTelemetry}]});
 expect(presentEvent({...row,analysis:{promptVersion:3,schemaVersion:2,evidence:[{image:1,role:'scene'}]}}).analysis).toMatchObject({promptVersion:3,schemaVersion:2,evidence:[{image:1,role:'scene'}]});
});

it('distinguishes omitted, explicitly unknown and rejected values in bounded existing subject JSON',()=>{
 const o=object();const raw={objects:[{...o,person:{...o.person,lowerClothing:{value:null,confidence:null},headwear:{value:'crown',confidence:80},carriedObjects:{value:['phone'],confidence:null}},uncertainties:{lowerClothing:'Occluded'}}]};
 const r=groundedResult(decodeCompactResponse(raw,[id],2),evidence,targets),s=r.subjects[0]!;
 expect(s.diagnostics).toEqual(expect.arrayContaining([{field:'relationship',code:'model_omitted'},{field:'lowerColor',code:'model_omitted'},{field:'lowerClothing',code:'model_unknown'},{field:'headwear',code:'unsupported_vocabulary'},{field:'carriedObjects',code:'insufficient_confidence'}]));
 expect(s.attributeEvidence.lowerClothing?.uncertainty).toBe('Occluded');
 expect(s.diagnostics!.length).toBeLessThanOrEqual(24);
 expect(r.objects[0]).not.toHaveProperty('diagnostics');
 const api=presentEvent({id,objects:[{id,category:'PERSON'}],analysis:{...r,objectAnalyses:r.objects}});
 expect(api.objects[0]?.analysis).toMatchObject({diagnostics:s.diagnostics,person:s.person});
 expect(JSON.stringify(z.toJSONSchema(compactResponseSchema([id],2,true)))).not.toContain('diagnostics');
});
