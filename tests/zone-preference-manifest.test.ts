import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { preferenceManifestSchema, verifyPreferenceManifest } from '../scripts/zone-preferences.js';
const id='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb',fingerprint='a'.repeat(64);
const entry={cameraId:'camera_1',channel:1,slot:0,zoneId:id,enabled:true,displayName:'Local entrance',interested:true,expectedGeometryFingerprint:fingerprint};
const manifest={installationId:id,zones:[entry]};
function response(patch:Record<string,unknown>={}) {return new Map<string,unknown>([['camera_1',{cameraId:'camera_1',channel:1,zones:[{id,slot:0,name:'Source area',current:{enabled:true,ruleEnabled:true,geometryFingerprint:fingerprint,polygon:[],observedAt:new Date().toISOString()},...patch}]}]]);}
it('reviews exact slot, camera, enabled state and geometry before allowing any import',()=>{
 expect(verifyPreferenceManifest(manifest,response())).toEqual(manifest);
 for(const patch of [{slot:1},{id:'27b01e57-cc3d-4db5-9bdd-f7d89e8149bb'},{current:null},{current:{enabled:false,ruleEnabled:true,geometryFingerprint:fingerprint,polygon:[],observedAt:new Date().toISOString()}},{preference:{displayName:'A later user edit',interested:false,updatedAt:new Date().toISOString()}}])expect(()=>verifyPreferenceManifest(manifest,response(patch))).toThrow();
 expect(()=>verifyPreferenceManifest({...manifest,zones:[{...entry,expectedGeometryFingerprint:'b'.repeat(64)}]},response())).toThrow();
 expect(()=>preferenceManifestSchema.parse({...manifest,zones:[entry,entry]})).toThrow();
});
it('creates only a separate stable-zone preference table and leaves historical/source/AI tables unchanged',()=>{
 const sql=readFileSync(new URL('../prisma/migrations/20261020180000_zone_preferences/migration.sql',import.meta.url),'utf8');
 expect(sql).toContain('CREATE TABLE "ZonePreference"');expect(sql).toContain('REFERENCES "UniviewZone"("id") ON DELETE RESTRICT');expect(sql).toContain("current_database() <> 'security_events'");expect(sql).not.toMatch(/ALTER TABLE|INSERT INTO|UPDATE "|DELETE FROM|DROP |TRUNCATE/i);
});
