import {z} from 'zod';
import {ATTRIBUTE_KEYS, personVisualSchema, vehicleVisualSchema, relationshipSchema, visualActionSchema, visualText, type ValidationDiagnostic} from './visual-schema.js';
// Compact wire only. Scored values are inseparable; defaults share image refs.
// Persistence/API retain the existing expanded field evidence representation.
const score=z.number().int().min(0).max(100).nullable();
const assessed=<T extends z.ZodType>(value:T)=>z.object({value,confidence:score}).strict();
const p=personVisualSchema.shape,v=vehicleVisualSchema.shape;
const person=z.object({upperClothing:assessed(p.upperClothing).optional(),lowerClothing:assessed(p.lowerClothing).optional(),
  upperColor:assessed(p.upperColor).optional(),lowerColor:assessed(p.lowerColor).optional(),outerwear:assessed(p.outerwear).optional(),
  headwear:assessed(p.headwear).optional(),bags:assessed(p.bags).optional(),accessories:assessed(p.accessories).optional(),carriedObjects:assessed(p.carriedObjects).optional()}).strict();
const vehicle=z.object({vehicleType:assessed(v.vehicleType).optional(),color:assessed(v.color).optional(),make:assessed(v.make).optional(),model:assessed(v.model).optional()}).strict();
function maps(imageCount:number) {
  const refs=z.array(z.number().int().min(1).max(imageCount)).min(1).max(imageCount),uncertainty=visualText(160);
  const uncertainties=z.object(Object.fromEntries([...ATTRIBUTE_KEYS,'object' as const].map(k=>[k,uncertainty.optional()])) as {[K in typeof ATTRIBUTE_KEYS[number]|'object']:z.ZodOptional<typeof uncertainty>}).strict();
  const fieldImages=z.object(Object.fromEntries(ATTRIBUTE_KEYS.map(k=>[k,refs.optional()])) as {[K in typeof ATTRIBUTE_KEYS[number]]:z.ZodOptional<typeof refs>}).strict();
  return {uncertainties,fieldImages};
}
export function compactResponseSchema(ids?:string[], imageCount=6, wire=false) {
  if(imageCount<1 || imageCount>6)throw new Error('Invalid evidence count');
  const checked=ids?z.array(z.uuid()).min(1).max(4).parse(ids):undefined,m=maps(imageCount);
  const front={objectId:checked?z.enum(checked as [string,...string[]]):z.uuid(),verification:z.enum(['supported','uncertain','contradicted']),
    evidenceImages:z.array(z.number().int().min(1).max(imageCount)).min(1).max(imageCount)};
  const tail={actions:z.array(visualActionSchema).min(1).max(4),relationship:assessed(relationshipSchema).nullable().optional(),
    confidence:z.object({observedType:score,verification:score,actions:score}).strict(),uncertainties:m.uncertainties.optional(),fieldImages:m.fieldImages.optional(),
    shortDescription:wire?visualText(240):z.unknown().transform(value=>typeof value==='string' && value.length<=2048?value:'')};
  const object=z.discriminatedUnion('observedType',[
    z.object({...front,observedType:z.literal('person'),person,...tail}).strict(),
    z.object({...front,observedType:z.enum(['motor_vehicle','non_motor_vehicle']),vehicle,...tail}).strict(),
    z.object({...front,observedType:z.enum(['animal','unknown']),...tail}).strict(),
  ]);
  const objects=z.array(object);
  return z.object({objects:checked?objects.length(checked.length):objects.max(4)}).strict();
}
export function decodeCompactResponse(raw:unknown,ids?:string[],imageCount=6) {
  const parsed=compactResponseSchema(ids,imageCount).parse(raw);
  return {objects:parsed.objects.map(o=>{
    const person=o.observedType==='person'?{upperClothing:null,lowerClothing:null,upperColor:null,lowerColor:null,outerwear:null,headwear:null,bags:[],accessories:[],carriedObjects:[]} as Record<string,unknown>:null;
    const vehicle=['motor_vehicle','non_motor_vehicle'].includes(o.observedType)?{vehicleType:null,color:null,make:null,model:null} as Record<string,unknown>:null;
    const supplied:Record<string,{value:unknown;confidence:number|null}|undefined>='person' in o?o.person:'vehicle' in o?o.vehicle:{};
    const diagnostics:ValidationDiagnostic[]=Object.keys(person??vehicle??{}).flatMap<ValidationDiagnostic>(field=>{
      const value=supplied[field];
      return !value ? [{field:field as ValidationDiagnostic['field'],code:'model_omitted' as const}]
        : value.value===null || Array.isArray(value.value) && !value.value.length ? [{field:field as ValidationDiagnostic['field'],code:'model_unknown' as const}] : [];
    });
    if(!o.relationship)diagnostics.push({field:'relationship',code:o.relationship===undefined?'model_omitted':'model_unknown'});
    const confidence:Record<string,number|null>={...o.confidence},attributes=person??vehicle;
    if(attributes)for(const [key,fact] of Object.entries('person' in o?o.person:'vehicle' in o?o.vehicle:{})){
      if(fact){attributes[key]=fact.value;confidence[key]=fact.confidence;}
    }
    if(o.relationship)confidence.relationship=o.relationship.confidence;
    const keys=new Set([...Object.keys(confidence),...Object.keys(o.uncertainties??{}),...Object.keys(o.fieldImages??{})]);keys.delete('object');
    const allImages=[...new Set([...o.evidenceImages,...Object.values(o.fieldImages??{}).flatMap(refs=>refs??[])])];
    const attributeEvidence=Object.fromEntries([...keys].map(key=>{
      const k=key as typeof ATTRIBUTE_KEYS[number],value=confidence[k]??null;
      // Scoring declares a model visual assessment under this prompt contract,
      // not independent application verification of visual truth.
      return [key,{basis:value===null?'unknown':'direct_visual',confidence:value,
        evidenceImages:o.fieldImages?.[k]??(value===null?[]:o.evidenceImages),uncertainty:o.uncertainties?.[k]??null}];
    }));
    return {objectId:o.objectId,observedType:o.observedType,verification:o.verification,actions:o.actions,evidenceImages:allImages,
      shortDescription:o.shortDescription,person,vehicle,relationship:o.relationship?.value??null,attributeEvidence,diagnostics,uncertainties:o.uncertainties?.object?[o.uncertainties.object]:[]};
  })};
}
