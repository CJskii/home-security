import { expect, it } from 'vitest';
import { analysisPrompt } from '../src/ai/evidence.js';
import { decodeCompactResponse } from '../src/ai/compact-schema.js';
import { groundedResult, linkedTargets } from '../src/ai/grounding.js';

const objectId = '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const foreignId = '27b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
const evidence = [{ image: 1, role: 'scene', origin: 'NVR_PUSH', sha256: 'scene' },
  { image: 2, role: 'object_crop', origin: 'NVR_PUSH', sha256: 'crop' }];
// Sanitized shapes of the three rejected candidate responses. No production IDs/media.
const cases = [
  { observedType: 'motor_vehicle', vehicle: { vehicleType: { value: 'car', confidence: 90 } } },
  { observedType: 'person', person: { upperClothing: { value: 'jacket', confidence: 80 }, carriedObjects: { value: ['phone'], confidence: 70 } } },
  { observedType: 'person', person: { upperColor: { value: 'blue', confidence: 80 }, accessories: { value: ['slippers'], confidence: 80 } } },
];
function fixture(shape: typeof cases[number], verification: 'supported' | 'uncertain' | 'contradicted') {
  const targets = linkedTargets({ targets: [{ objectId, category: shape.observedType, fullFrameSha256: 'scene', cropSha256: 'crop' }] }, evidence);
  const raw = decodeCompactResponse({ objects: [{ ...shape, objectId, verification, evidenceImages: [1, 2], actions: ['visible'],
    confidence: { observedType: 90, verification: 80, actions: 90 }, shortDescription: shape.observedType === 'person' ? 'A person is visible.' : 'A vehicle is visible.' }] }, [objectId], 2);
  return { raw, targets };
}
it('preserves and rejects all three same-class contradictions, without repairing model output', () => {
  for (const shape of cases) {
    const { raw, targets } = fixture(shape, 'contradicted');
    expect(raw.objects[0]!.verification).toBe('contradicted');
    expect(() => groundedResult(raw, evidence, targets)).toThrow();
  }
});
it('allows independently supported or uncertain broad classes without requiring fine attributes', () => {
  for (const shape of cases) for (const verification of ['supported', 'uncertain'] as const) {
    const { raw, targets } = fixture(shape, verification);
    expect(groundedResult(raw, evidence, targets).objects[0]).toMatchObject({ objectId, verification });
  }
});
it('still allows genuine different-class contradiction and rejects unsupported agreement, foreign UUIDs and unanchored evidence', () => {
  const { raw, targets } = fixture(cases[0]!, 'contradicted');
  expect(groundedResult(raw, evidence, [{ ...targets[0]!, category: 'person' }]).objects[0]).toMatchObject({ observedType: 'motor_vehicle', verification: 'contradicted' });
  const supported = fixture(cases[0]!, 'supported');
  expect(() => groundedResult(supported.raw, evidence, [{ ...targets[0]!, category: 'person' }])).toThrow();
  const foreign = fixture(cases[0]!, 'supported'); foreign.raw.objects[0]!.objectId = foreignId;
  expect(() => groundedResult(foreign.raw, evidence, targets)).toThrow();
  const missing = fixture(cases[0]!, 'supported');
  expect(groundedResult(missing.raw, evidence, [{ ...targets[0]!, cropSha256: null, rectangleImage: null, rectangle: null }]).objects[0]!.verification).toBe('uncertain');
});
it('defines verification against broad source category separately from uncertain attributes', () => {
  const prompt = analysisPrompt(evidence, { targets: [] }, 1);
  expect(prompt).toContain('verification assesses ONLY');
  expect(prompt).toContain('Never use contradicted when observedType equals category');
  expect(prompt).toContain('Do not force agreement');
});
