import {z} from 'zod';
import {type AnalysisResult} from './schemas.js';
import {visualResponseSchema, structuredSubjectSchema, type VisualObject, type ValidationDiagnostic} from './visual-schema.js';
import {vocabulary, COLOURS, CLOTHING_TYPES, HEADWEAR, BAG_TYPES, ACCESSORIES, OBJECTS, VEHICLE_TYPES} from './observations.js';
import {VisionError} from './client.js';
import {failureDiagnostic, parseWithDiagnostics, type FailureDiagnostics} from './failure-diagnostics.js';
const reject = (diagnostics:FailureDiagnostics):never => {throw new VisionError('invalid_model_output',diagnostics);};
const targetSchema=z.object({objectId:z.uuid(),category:z.string(),fullFrameSha256:z.string().nullable(),cropSha256:z.string().nullable(),rectangle:z.unknown().optional()});
export function linkedTargets(facts:Record<string,unknown>,evidence:Record<string,unknown>[]) {
  const targets=parseWithDiagnostics(z.array(targetSchema).max(4),facts.targets??[],'source_targets',reject);
  return targets.map(t=>({...t,rectangleImage:evidence.find(e=>e.role==='scene' && e.sha256===t.fullFrameSha256)?.image??null,originalImages:evidence.filter(e=>e.origin==='NVR_PUSH' && [t.fullFrameSha256,t.cropSha256].includes(String(e.sha256))).map(e=>Number(e.image))}));
}
const temporalClaim = /\b(enter(?:s|ed|ing)?|exit(?:s|ed|ing)?|leav(?:e|es|ing)|left[- ]to[- ]right|right[- ]to[- ]left|towards?|away|approach\w*|depart\w*|arriv\w*|driv(?:e|es|ing)|drove|stopp?\w*|park\w*|continu(?:e|es|ed|ing)|previous(?:ly)?|subsequent\w*|later|earlier|destination|heading|moving|motion|motionless|unmoving|immobile|standstill|stationary|cross(?:es|ed|ing)|passing|travell?\w*)\b/i;
const personActions = new Set(['standing','sitting','crouching','bending','holding','carrying','walking','running']);
const actionWords:Record<string,RegExp> = {
  standing:/\b(stand|stands|standing)\b/i,sitting:/\b(sit|sits|sitting|seated)\b/i,
  crouching:/\bcrouch(?:es|ing)?\b/i,bending:/\bbend(?:s|ing)?\b/i,
  holding:/\bhold(?:s|ing)?\b/i,carrying:/\b(carry|carries|carrying)\b/i,
  walking:/\bwalk(?:s|ing)?\b/i,running:/\b(run|runs|running)\b/i,
};
const empty = (v: unknown) => v === null || Array.isArray(v) && v.length === 0;
function noun(o: VisualObject) { return o.observedType === 'person' ? 'A person' : o.observedType.includes('vehicle') ? 'A vehicle' : o.observedType === 'animal' ? 'An animal' : 'An object'; }
function fallback(o: VisualObject) {
  const vehicle=o.vehicle;
  const label=vehicle ? `A ${[vehicle.color,vehicle.vehicleType === 'suv' ? 'SUV' : vehicle.vehicleType ?? 'vehicle'].filter(Boolean).join(' ')}` : noun(o);
  const action=o.actions.find(a=>!['visible','unknown','other'].includes(a));
  const bag=(o.person?.carriedObjects??[]).some(v=>v.includes('bag') || v==='backpack');
  const state=action==='walking' || action==='running' ? `appears to be ${action}` : action==='carrying' || action==='holding' ? `is ${action} ${bag?'a bag':'an object'}` : action ? `is ${action}` : 'is visible';
  const garment=(value:string|null|undefined,colour:string|null|undefined)=>{
    if(!value || value==='other')return null;
    const text=[colour,value.replaceAll('_','-')].filter(Boolean).join(' ');
    return ['trousers','jeans','shorts','leggings','overalls'].includes(value) ? text : `${/^[aeiou]/i.test(text)?'an':'a'} ${text}`;
  };
  const person=o.person,clothes=person ? [garment(person.upperClothing??person.outerwear,person.upperColor),garment(person.lowerClothing,person.lowerColor)].filter(Boolean) : [];
  const clothing=clothes.length ? ` in ${clothes.join(' and ')}` : '';
  const relation=o.relationship ? ` ${o.relationship.kind} ${o.relationship.object==='other'?'another object':`a ${o.relationship.object}`}` : '';
  return `${label} ${state}${clothing}${relation}.`;
}
// This validates source ownership and bounded claims, not visual truth. Confidence
// is uncalibrated; no numeric threshold can turn an inference into a source fact.
export function groundedResult(raw: unknown, evidence: Record<string,unknown>[], targets: ReturnType<typeof linkedTargets>): Omit<AnalysisResult,'subjects'> & {subjects:z.infer<typeof structuredSubjectSchema>[]} {
  const {objects} = parseWithDiagnostics(visualResponseSchema,raw,'expanded_schema',reject), ids = new Set(objects.map(o=>o.objectId));
  if (ids.size !== objects.length || ids.size !== targets.length || targets.some(t=>!ids.has(t.objectId))) reject(failureDiagnostic('grounding','object_identity',['objects']));
  for (const o of objects) {
    const target = targets.find(t=>t.objectId === o.objectId)!;
    const diagnostics:ValidationDiagnostic[]=[...(o.diagnostics??[])];
    const diagnose=(field:ValidationDiagnostic['field'],code:ValidationDiagnostic['code'])=>{
      if(!diagnostics.some(d=>d.field===field && d.code===code))diagnostics.push({field,code});
    };
    const validRefs = (refs:number[]) => refs.length > 0 && new Set(refs).size === refs.length && refs.every(i => target.originalImages.includes(i));
    if (!validRefs(o.evidenceImages)) reject(failureDiagnostic('grounding','evidence_ownership',['objects',objects.indexOf(o),'evidenceImages']));
    if (o.observedType === 'person' ? !o.person || o.vehicle !== null : o.observedType.includes('vehicle') ? !o.vehicle || o.person !== null : o.person !== null || o.vehicle !== null) reject(failureDiagnostic('grounding','category_branch',['objects',objects.indexOf(o),'observedType']));
    for (const key of ['observedType','verification'] as const) o.attributeEvidence[key] ??= {basis:'unknown',confidence:null,evidenceImages:[],uncertainty:'Not assessed by the model.'};
    for (const [key,field] of Object.entries(o.attributeEvidence)) {
      if (!field) continue;
      if (field.evidenceImages.length && (!validRefs(field.evidenceImages) || field.evidenceImages.some(i=>!o.evidenceImages.includes(i)))) reject(failureDiagnostic('grounding','evidence_ownership',['objects',objects.indexOf(o),'attributeEvidence',key,'evidenceImages']));
      if (field.basis === 'unknown' && field.confidence !== null || field.confidence !== null && !field.evidenceImages.length) reject(failureDiagnostic('grounding','inconsistent_evidence',['objects',objects.indexOf(o),'attributeEvidence',key]));
      const allowed = ['observedType','verification','actions','relationship',...Object.keys(o.person ?? o.vehicle ?? {})];
      if (!allowed.includes(key)) reject(failureDiagnostic('grounding','unsupported_field',['objects',objects.indexOf(o),'attributeEvidence',key]));
    }
    if (o.observedType !== 'person' && o.actions.some(a=>personActions.has(a))) {
      diagnose('actions','type_incompatible_action');
      const allowed=[...new Set(o.actions.filter(a=>!personActions.has(a)))],report=o.attributeEvidence.actions;
      o.actions=allowed.length?allowed:['unknown'];
      if(report)o.attributeEvidence.actions={...report,...(!allowed.length?{basis:'unknown' as const,confidence:null,evidenceImages:[]}:{}),
        uncertainty:('Type-incompatible actions were removed. '+(report.uncertainty??'')).trim().slice(0,160)};
    }
    const supported = (key:string) => {const e=o.attributeEvidence[key as keyof typeof o.attributeEvidence]; return e?.basis === 'direct_visual' && e.confidence !== null && e.confidence > 0 && validRefs(e.evidenceImages);};
    const crop = o.evidenceImages.some(i=>evidence.some(e=>e.image === i && e.sha256 === target.cropSha256 && e.role === 'object_crop'));
    const anchored = crop || target.rectangleImage !== null && target.rectangle != null && o.evidenceImages.includes(Number(target.rectangleImage));
    if (!anchored || target.category === 'unknown' || o.observedType === 'unknown' || !supported('verification') || !supported('observedType')) o.verification = 'uncertain';
    else if (o.verification === 'supported' && o.observedType !== target.category || o.verification === 'contradicted' && o.observedType === target.category) reject(failureDiagnostic('grounding','source_verification',['objects',objects.indexOf(o),'verification']));
    const rejectedValues = new Set<string>();
    const withhold = (key:ValidationDiagnostic['field'], value:unknown, code:ValidationDiagnostic['code']) => {
      diagnose(key,code);
      for(const v of Array.isArray(value) ? value : [value]) if(typeof v === 'string' && !['unknown','none','other'].includes(v.toLowerCase())) rejectedValues.add(v.toLowerCase().replaceAll('_',' '));
      const previous=o.attributeEvidence[key as keyof typeof o.attributeEvidence];
      o.attributeEvidence[key as keyof typeof o.attributeEvidence] = {basis:'unknown',confidence:null,evidenceImages:[],uncertainty:previous?.uncertainty ?? 'Withheld: insufficient direct visual evidence or unsupported value.'};

    };
    const unsupportedReason=(key:string):ValidationDiagnostic['code']=>{
      const e=o.attributeEvidence[key as keyof typeof o.attributeEvidence];
      if(!anchored || !e)return 'missing_evidence';
      return e.confidence===null || e.confidence<=0 ? 'insufficient_confidence' : 'missing_evidence';
    };
    const attributes = o.person ?? o.vehicle;
    const vocab: Record<string, readonly string[]> = {upperClothing:CLOTHING_TYPES,lowerClothing:CLOTHING_TYPES,upperColor:COLOURS,lowerColor:COLOURS,outerwear:CLOTHING_TYPES,headwear:HEADWEAR,bags:BAG_TYPES,accessories:ACCESSORIES,carriedObjects:OBJECTS,vehicleType:VEHICLE_TYPES,color:COLOURS};
    if (attributes) for (const key of Object.keys(attributes) as (keyof NonNullable<VisualObject['attributeEvidence']>)[]) {
      const values=attributes as Record<string, string|string[]|null>, before=values[key]!;
      if (typeof before === 'string' && ['unknown','unclear','not_visible','none'].includes(before.toLowerCase())) values[key]=null;
      if (empty(values[key])) {
        const report=o.attributeEvidence[key as keyof typeof o.attributeEvidence];
        if(report)o.attributeEvidence[key as keyof typeof o.attributeEvidence]={...report,basis:'unknown',confidence:null,evidenceImages:[]};
        if(!diagnostics.some(d=>d.field===key))diagnose(key,report?'model_unknown':'model_omitted');
        continue;
      }
      if (!anchored || !supported(key)) { values[key] = Array.isArray(before) ? [] : null; withhold(key,before,unsupportedReason(key)); continue; }
      if (vocab[key]) {
        const normal = Array.isArray(before) ? [...new Set(before.map(v=>vocabulary(v,vocab[key]!)).filter((v):v is string=>v!==null))] : vocabulary(before,vocab[key]!);
        const rejected = Array.isArray(before) ? (normal as string[]).length !== before.length : normal === null;
        if (rejected) withhold(key,before,'unsupported_vocabulary');
        values[key] = rejected && Array.isArray(before) ? [] : normal;
      }
    }
    if (o.vehicle?.vehicleType && (o.observedType==='motor_vehicle' && o.vehicle.vehicleType==='bicycle' || o.observedType==='non_motor_vehicle' && !['bicycle','other'].includes(o.vehicle.vehicleType))) {
      withhold('vehicleType',o.vehicle.vehicleType,'source_category_mismatch');o.vehicle.vehicleType=null;
    }
    if (!anchored || !supported('actions')) {withhold('actions',o.actions,unsupportedReason('actions'));o.actions=['unknown'];}
    if (o.actions.includes('other') && (!o.attributeEvidence.actions?.uncertainty || /^(none|unknown|uncertain)$/i.test(o.attributeEvidence.actions.uncertainty))) reject(failureDiagnostic('grounding','action_uncertainty',['objects',objects.indexOf(o),'actions']));
    o.actions=[...new Set(o.actions)];
    if (o.relationship && (!anchored || !supported('relationship'))) {withhold('relationship',o.relationship.object,unsupportedReason('relationship'));o.relationship=null;}
    if(!o.relationship && o.attributeEvidence.relationship)o.attributeEvidence.relationship={basis:'unknown',confidence:null,evidenceImages:[],uncertainty:o.attributeEvidence.relationship.uncertainty};
    const accepted = Object.values(attributes??{}).flatMap(v=>Array.isArray(v)?v:typeof v==='string'?[v]:[]).join(' ').toLowerCase().replaceAll('_',' ');
    const description=o.shortDescription.trim(), lower=description.toLowerCase().replaceAll('_',' ');
    const relationObject=o.relationship?.object;
    const allowedWords=accepted+' '+(relationObject??'');
    const unsupportedWord = [...COLOURS,...CLOTHING_TYPES,...HEADWEAR,...BAG_TYPES,...ACCESSORIES,...OBJECTS]
      .some(w=>w !== 'other' && new RegExp(`\\b${w.replaceAll('_','[ _-]')}\\b`,'i').test(description) && !allowedWords.includes(w.replaceAll('_',' ')));
    const invalidAction=Object.entries(actionWords).some(([action,words])=>words.test(description) && !o.actions.includes(action as typeof o.actions[number]));
    const firstNoun=lower.match(/\b(person|individual|figure|car|vehicle|van|suv|truck|lorry|bus|motorcycle|bicycle|animal|object)\b/)?.[1];
    const wrongSubject=o.observedType==='person' ? !['person','individual','figure'].includes(firstNoun??'') : o.observedType.includes('vehicle') ? !['car','vehicle','van','suv','truck','lorry','bus','motorcycle','bicycle'].includes(firstNoun??'') : !firstNoun;
    const relationMentions=[...description.matchAll(/\b(beside|near|next to)\s+(?:(?:a|an|the)\s+)?([a-z]+)/gi)];
    const relationshipWords:Record<string,string[]>={vehicle:['vehicle','car','van','suv','truck','lorry','bus','motorcycle'],bin:['bin'],bicycle:['bicycle'],bag:['bag'],other:['object','another']};
    const invalidRelation=/\b(beside|near|next to)\b/i.test(description) && (!o.relationship || relationMentions.length!==1)
      || relationMentions.some(m=>!o.relationship || (m[1]!.toLowerCase()==='near'?'near':'beside')!==o.relationship.kind || !relationshipWords[o.relationship.object]!.includes(m[2]!.toLowerCase()));
    const allowedProper=new Set(('a an the person individual figure vehicle car van suv truck lorry bus motorcycle bicycle animal object '+allowedWords+' '+o.actions.join(' ')+' '+(o.vehicle?.vehicleType??'')).match(/[a-z0-9]+/g));
    const inventedName=(description.match(/\b[A-Z][A-Za-z0-9-]+\b/g)??[]).some(w=>!allowedProper.has(w.toLowerCase()));
    const vehicleNouns:Record<string,string>={car:'car',van:'van',suv:'suv',truck:'truck',lorry:'truck',bus:'bus',motorcycle:'motorcycle',bicycle:'bicycle'};
    const vehicleTypeMismatch=!!o.vehicle && !!firstNoun && firstNoun!=='vehicle' && vehicleNouns[firstNoun]!==o.vehicle.vehicleType;
    // Unsupported capitalized makes/models remain blocked; accepting ordinary subject
    // nouns must not make an asserted make/model label a back door around that check.
    const identityMentions=[...description.matchAll(/\b(?:make|model|brand)\s+(?:is\s+)?([a-z0-9-]+)/gi)];
    const vehicleIdentityMismatch=!!o.vehicle && identityMentions.some(m=>![o.vehicle?.make,o.vehicle?.model].filter(Boolean).some(v=>v!.toLowerCase().split(/\s+/).includes(m[1]!.toLowerCase())));
    const rules:NonNullable<ValidationDiagnostic['rules']>=[];
    const check=(failed:boolean,rule:NonNullable<ValidationDiagnostic['rules']>[number])=>{if(failed)rules.push(rule);};
    check(!anchored,'missing_evidence');
    check(!description || description.length>240 || description.split(/\s+/).length>32
      || [...description].some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127) || /data:image|\/9j\//i.test(description)
      || (description.match(/[.!?](?:\s|$)/g)??[]).length>1,'invalid_format');
    check(wrongSubject,'subject_mismatch');
    check(unsupportedWord || [...rejectedValues].some(v=>lower.includes(v)),'attribute_mismatch');
    check(invalidAction,'action_mismatch');
    check(!!invalidRelation,'relationship_mismatch');
    check(inventedName,'unsupported_name');
    check(temporalClaim.test(description),'temporal_claim');
    check(/\b(image|frame|crop|cropped|snapshot|scene|deliver\w*|trespass\w*|steal\w*|owner|resident|visitor|no movement|not moving|at rest)\b/i.test(description),'unsupported_context');
    check((actionWords.walking!.test(description) || actionWords.running!.test(description)) && !/\bappears?\b|\bposture\b/i.test(description),'unqualified_action');
    check(vehicleTypeMismatch,'vehicle_type_mismatch');
    check(vehicleIdentityMismatch,'vehicle_identity_mismatch');
    check(/\b(open\w*|clos(?:e|es|ed|ing)|touch\w*|lean\w*|reach\w*|push\w*|pull\w*|load\w*|unload\w*|interact\w*|unlock\w*)\b/i.test(description),'unsupported_interaction');
    if(rules.length){
      o.shortDescription=anchored?fallback(o):'The detected object is unclear.';
      diagnostics.push({field:'shortDescription',code:'description_rule_failure',rules});
      // Historical clients still receive the existing summary; precise reasons are
      // separate from genuine model uncertainty and contain no rejected text/value.
      o.uncertainties=[...new Set([...o.uncertainties.slice(0,3),'Generated description withheld: unsupported wording or attribute evidence.'])];
    } else o.shortDescription=description;
    o.diagnostics=diagnostics.slice(0,24);

  }
  const subjects=objects.map(o=>({objectId:o.objectId,type:o.observedType==='person'?'person' as const:o.observedType.includes('vehicle')?'vehicle' as const:o.observedType==='animal'?'animal' as const:'unknown' as const,
    count:o.verification === 'supported' ? 1 : null,person:o.person,vehicle:o.vehicle,relationship:o.relationship,attributeEvidence:o.attributeEvidence,diagnostics:o.diagnostics}));
  const objectResults=objects.map(({person,vehicle,relationship,attributeEvidence,diagnostics,...o})=>{void person;void vehicle;void relationship;void attributeEvidence;void diagnostics;return {...o};});
  return {objects:objectResults,subjects,activityLabel:objects.length === 1 && objects[0]!.actions.includes('standing') ? 'standing' : objects.some(o=>o.actions.includes('carrying'))?'carrying_object':'unknown',
    shortDescription:objects.map(o=>o.shortDescription).join(' ').slice(0,512),
    uncertainties:[...new Set(objects.flatMap(o=>o.uncertainties))].slice(0,8)};
}
