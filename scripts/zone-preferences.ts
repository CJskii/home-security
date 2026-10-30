// Operator-only import. Default is a read-only review; never an application startup task.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { protectedEnvironment } from '../src/dashboard/development-config.js';
import { zonePreferenceInput } from '../src/uniview/zone-preferences.js';
import { zonesSchema } from '../web/src/lib/contracts.js';

export const preferenceManifestSchema = z.object({
  installationId: z.uuid(),
  zones: z.array(zonePreferenceInput.extend({
    cameraId: z.string().min(1).max(128), channel: z.number().int().min(1).max(2), slot: z.number().int().min(0).max(3),
    zoneId: z.uuid(), enabled: z.boolean(),
  }).strict()).min(1).max(8),
}).strict().refine(m => new Set(m.zones.map(z => `${z.channel}:${z.slot}`)).size === m.zones.length && new Set(m.zones.map(z=>z.zoneId)).size === m.zones.length);
export function verifyPreferenceManifest(value: unknown, responses: Map<string, unknown>) {
  const manifest = preferenceManifestSchema.parse(value);
  for (const row of manifest.zones) {
    const response = zonesSchema.extend({ cameraId: z.string(), channel: z.number() }).parse(responses.get(row.cameraId));
    const zone = response.zones.find(z => z.id === row.zoneId && z.slot === row.slot);
    if (response.cameraId !== row.cameraId || response.channel !== row.channel || !zone?.current ||
      zone.current.geometryFingerprint !== row.expectedGeometryFingerprint ||
      (zone.current.enabled && zone.current.ruleEnabled === true) !== row.enabled || !row.enabled && row.interested)
      throw new Error('Mapping changed; review current polygons before import');
    if (zone.preference && (zone.preference.displayName !== row.displayName || zone.preference.interested !== row.interested))
      throw new Error('Existing local preferences differ; review edits before import');
  }
  return manifest;
}
async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  if (![1,2].includes(args.length) || args.filter(x=>x==='--apply').length>1) throw new Error('Expected private-manifest path and optional --apply');
  const path = args.find(x => x !== '--apply'); if (!path) throw new Error('Private manifest required');
  const stat = statSync(path); if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Manifest must be private (mode 600)');
  const manifest = preferenceManifestSchema.parse(JSON.parse(readFileSync(path,'utf8'))), env = protectedEnvironment('.env.local');
  if (manifest.installationId !== env.UNIVIEW_INSTALLATION_ID || !env.EVENTS_TOKEN) throw new Error('Installation/authentication mismatch');
  const headers = {authorization:`Bearer ${env.EVENTS_TOKEN}`}, responses = new Map<string, unknown>();
  for (const camera of new Set(manifest.zones.map(z=>z.cameraId))) {
    const response = await fetch(`http://127.0.0.1:3000/api/cameras/${encodeURIComponent(camera)}/zones`,{headers,redirect:'error',signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error('Zone API unavailable'); responses.set(camera,await response.json());
  }
  verifyPreferenceManifest(manifest,responses); // Review every mapping before the first write.
  if (apply) for (const row of manifest.zones) {
    if (!zonesSchema.parse(responses.get(row.cameraId)).preferencesAvailable) throw new Error('Zone preferences require the upgraded API and migration');
  }
  if (apply) for (const row of manifest.zones) {
    const response = await fetch(`http://127.0.0.1:3000/api/cameras/${encodeURIComponent(row.cameraId)}/zones/${row.zoneId}/preferences`,{
      method:'PATCH',headers:{...headers,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(7000),
      body:JSON.stringify({displayName:row.displayName,interested:row.interested,expectedGeometryFingerprint:row.expectedGeometryFingerprint}),
    });
    await response.body?.cancel(); if (!response.ok) throw new Error('Import stopped; inspect preferences before retrying');
  }
  // Names, identifiers and source geometry intentionally stay out of logs.
  console.log(`${apply?'Applied':'Read-only review passed for'} ${manifest.zones.length} local zone preferences${apply?'':'; no writes performed'}.`);
}
if (resolve(process.argv[1]??'') === fileURLToPath(import.meta.url)) void main().catch(()=>{
  process.stderr.write('Zone preference import stopped. Check the private manifest, current mapping, credentials and API/migration availability. Values withheld.\n');process.exitCode=1;
});
