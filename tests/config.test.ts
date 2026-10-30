import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
const base = { DATABASE_URL: 'postgresql://test:secret@invalid/security' };
it('capture is opt-in and removed enabled workflows fail closed without revealing values', () => {
  expect(loadConfig(base).UNIVIEW_ENABLED).toBe(false);
  for (const key of ['CORRELATION_ENABLED', 'VISUAL_COMPARISON_ENABLED', 'EVIDENCE_SCORING_ENABLED']) expect(() => loadConfig({ ...base, [key]: 'true' })).toThrow(key);
  expect(() => loadConfig({ DATABASE_URL: 'private-secret' })).toThrow('DATABASE_URL');
});
it('receiver requires a stable identity and bounded shutdown', () => {
  expect(() => loadConfig({ ...base, UNIVIEW_ENABLED: 'true' })).toThrow('UNIVIEW_INSTALLATION_ID');
  expect(() => loadConfig({ ...base, UNIVIEW_ENABLED: 'true', UNIVIEW_INSTALLATION_ID: '17b01e57-cc3d-4db5-9bdd-f7d89e8149bb', UNIVIEW_NVR_IP: '10.0.0.1' })).toThrow('SHUTDOWN_TIMEOUT_MS');
  expect(() => loadConfig({ ...base, UNIVIEW_CAMERA_MAP: '{"01":"bad"}' })).toThrow('UNIVIEW_CAMERA_MAP');
});
it('metrics token is required and cannot share event authentication', () => {
  expect(() => loadConfig({ ...base, METRICS_ENABLED: 'true' })).toThrow('METRICS_TOKEN');
  expect(() => loadConfig({ ...base, EVENTS_TOKEN: 'a'.repeat(32), METRICS_TOKEN: 'a'.repeat(32) })).toThrow('EVENTS_TOKEN');
});

it('keeps zone enforcement explicitly off by default and requires an AI receiver when arming it',()=>{
 expect(loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security'}).AI_ZONE_SELECTION_ENABLED).toBe(false);
 expect(()=>loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',AI_ZONE_SELECTION_ENABLED:'true'})).toThrow();
 expect(()=>loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',AI_ZONE_SELECTION_ENABLED:'yes'})).toThrow();
});

it('keeps webhook configuration opt-in, validates exact operator pins and masks invalid settings',()=>{
 const empty=loadConfig(base);expect(empty.NOTIFICATION_CREDENTIAL_KEY).toBeUndefined();expect(empty.NOTIFICATION_APPROVED_DESTINATIONS).toBe('[]');
 const pin={url:'http://192.168.50.20:8123/api/webhook/home-security',address:'192.168.50.20',allowLanHttp:true};
 expect(loadConfig({...base,NOTIFICATION_APPROVED_DESTINATIONS:JSON.stringify([pin]),NOTIFICATION_CREDENTIAL_KEY:'b'.repeat(64)}).NOTIFICATION_CREDENTIAL_KEY).toBe('b'.repeat(64));
 for(const value of['not JSON',JSON.stringify([{...pin,address:'169.254.169.254'}]),JSON.stringify([{...pin,allowLanHttp:false}])]){
  expect(()=>loadConfig({...base,NOTIFICATION_APPROVED_DESTINATIONS:value})).toThrow('NOTIFICATION_APPROVED_DESTINATIONS');
 }
 const savedKey='a'.repeat(64);
 expect(()=>loadConfig({...base,DASHBOARD_SESSION_KEY:savedKey,NOTIFICATION_CREDENTIAL_KEY:savedKey})).toThrow('NOTIFICATION_CREDENTIAL_KEY');
 try{loadConfig({...base,NOTIFICATION_CREDENTIAL_KEY:'private-invalid-key'});throw Error('Expected rejection');}catch(error){expect(String(error)).not.toContain('private-invalid-key');}
});
