import {expect,it} from 'vitest';
import {instrumentFrozenGrounding,instrumentFrozenReceiver} from '../scripts/ai-reliability-overlay.js';
it('adds diagnostics without changing frozen validator conditions, thresholds or results',()=>{
 const original=`const a = visualResponseSchema.parse(raw); const b = z.array(targetSchema).max(4).parse(facts.targets ?? []);\n`+Array.from({length:8},(_,i)=>`if (condition${i}) throw new VisionError('invalid_model_output');`).join('\n');
 const patched=instrumentFrozenGrounding(original);
 expect(patched.match(/if \(condition\d\)/g)).toEqual(original.match(/if \(condition\d\)/g));
 expect(patched.match(/new VisionError\('invalid_model_output'/g)).toHaveLength(9);
 expect(patched).toContain("'source_verification'");expect(patched).toContain("'action_uncertainty'");
 expect(()=>instrumentFrozenGrounding(original.replace('condition0','condition0').replace("throw new VisionError('invalid_model_output');",'return null;'))).toThrow('Frozen validator differs');
});
it('changes only the frozen receiver outcome logger and fails closed for an unexpected baseline',()=>{
 const original="before(); log.info({ aiStatus: outcome.status, reason: outcome.reason }, 'AI enrichment finished'); after();";
 const patched=instrumentFrozenReceiver(original);expect(patched.startsWith('before();')).toBe(true);expect(patched.endsWith('after();')).toBe(true);expect(patched).toContain('outcome.validationFailure');
 expect(()=>instrumentFrozenReceiver('different baseline')).toThrow();
});
