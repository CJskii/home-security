import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

// Preparation for the existing pinned receiver-overlay workflow. Do not import a
// newer checkout's prompt, grammar or validator policy into the frozen receiver.
export function instrumentFrozenGrounding(source:string) {
  const reasons=[
    ['object_identity',"['objects']"],
    ['evidence_ownership',"['objects',objects.indexOf(o),'evidenceImages']"],
    ['category_branch',"['objects',objects.indexOf(o),'observedType']"],
    ['evidence_ownership',"['objects',objects.indexOf(o),'attributeEvidence',key,'evidenceImages']"],
    ['inconsistent_evidence',"['objects',objects.indexOf(o),'attributeEvidence',key]"],
    ['unsupported_field',"['objects',objects.indexOf(o),'attributeEvidence',key]"],
    ['source_verification',"['objects',objects.indexOf(o),'verification']"],
    ['action_uncertainty',"['objects',objects.indexOf(o),'actions']"],
  ];
  const needle="throw new VisionError('invalid_model_output');";
  assert.equal(source.split(needle).length-1,reasons.length,'Frozen validator differs; stop rather than guessing');
  assert.equal(source.split('visualResponseSchema.parse(raw)').length,2);
  assert.equal(source.split('z.array(targetSchema).max(4).parse(facts.targets ?? [])').length,2);
  let result=source;
  for(const[code,path]of reasons)result=result.replace(needle,`throw new VisionError('invalid_model_output',failureDiagnostic('grounding','${code}',${path}));`);
  result=result.replace('visualResponseSchema.parse(raw)',"parseWithDiagnostics(visualResponseSchema,raw,'expanded_schema',reject)")
    .replace('z.array(targetSchema).max(4).parse(facts.targets ?? [])',"parseWithDiagnostics(z.array(targetSchema).max(4),facts.targets ?? [],'source_targets',reject)");
  return "import {failureDiagnostic,parseWithDiagnostics} from './failure-diagnostics.js';\nconst reject=d=>{throw new VisionError('invalid_model_output',d);};\n"+result.replace(/\/\/# sourceMappingURL=.*$/m,'');
}
export function instrumentFrozenReceiver(source:string) {
  const needle="{ aiStatus: outcome.status, reason: outcome.reason }";
  assert.equal(source.split(needle).length,2,'Frozen receiver logger differs');
  return source.replace(needle,"{ aiStatus: outcome.status, reason: outcome.reason, ...(outcome.validationFailure ? {validationFailure:outcome.validationFailure} : {}), ...(outcome.capacity ? {capacity:outcome.capacity} : {}) }").replace(/\/\/# sourceMappingURL=.*$/m,'');
}
export function prepareOverlay(baseline:string,compiled:string,output:string) {
  for(const module of ['ai/client','ai/analysis','ai/failure-diagnostics','uniview/evidence']){
    mkdirSync(dirname(resolve(output,module)),{recursive:true,mode:0o700});
    copyFileSync(resolve(compiled,module+'.js'),resolve(output,module+'.js'));
    copyFileSync(resolve(compiled,module+'.js.map'),resolve(output,module+'.js.map'));
  }
  writeFileSync(resolve(output,'ai/grounding.js'),instrumentFrozenGrounding(readFileSync(resolve(baseline,'ai/grounding.js'),'utf8')));
  writeFileSync(resolve(output,'uniview/app.js'),instrumentFrozenReceiver(readFileSync(resolve(baseline,'uniview/app.js'),'utf8')));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,5,'Expected baseline dist, compiled dist, output directory');
  prepareOverlay(process.argv[2]!,process.argv[3]!,process.argv[4]!);
  console.log('Prepared six-module diagnostic overlay; frozen prompt/grammar/policy retained.');
}
