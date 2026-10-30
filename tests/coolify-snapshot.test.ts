import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(managed: boolean, duplicates = false, legacyActive = !managed, missing = false) {
  const root = mkdtempSync(join(tmpdir(), 'hs-snapshot-'));
  try {
    mkdirSync(join(root, 'deploy/coolify'), { recursive: true });
    const script = join(root, 'deploy/coolify/snapshot-environment.mjs');
    copyFileSync('deploy/coolify/snapshot-environment.mjs', script);
    const items: Record<string, unknown> = {};
    const services = ['api', 'receiver', 'notification-worker', 'gateway'];
    for (const service of services) {
      const legacy = service === 'gateway' ? 'home-security-live-dev-gateway-1' : 'home-security-' + service;
      const container = (id: string, running: boolean) => ({ Id: id, Name: '/' + id, Image: 'sha256:' + 'a'.repeat(64),
        State: { Running: running, Status: running ? 'running' : 'exited' },
        Config: { Env: service === 'gateway' ? ['SECURITY_GATEWAY_USER=fixture', 'SECURITY_GATEWAY_PASSWORD=fixture', 'NVR_C1_SUB_RTSP=rtsp://fixture.invalid/one', 'NVR_C2_SUB_RTSP=rtsp://fixture.invalid/two'] : ['DATABASE_URL=postgresql://fixture:fixture@security-db:5432/security_events'], Cmd: ['node', 'fixture.js'] },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } } });
      items[legacy] = container(legacy, legacyActive);
      if (managed && !(missing && service === 'receiver')) items['managed-' + service] = container('managed-' + service, true);
      if (duplicates && service === 'receiver') items['extra-' + service] = container('extra-' + service, true);
    }
    const fixture = join(root, 'fixture.json');
    writeFileSync(fixture, JSON.stringify(items));
    writeFileSync(join(root, 'docker'), `#!/usr/bin/env node
import process from 'node:process';import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(process.env.FIXTURE));const args=process.argv.slice(2);
if(args[0]==='inspect'){if(!data[args[1]])process.exit(1);console.log(JSON.stringify([data[args[1]]]));}
else if(args[0]==='ps'){const role=args.find(x=>x.startsWith('label=com.docker.compose.service=')).split('=').at(-1);console.log(Object.keys(data).filter(k=>(k==='managed-'+role||k==='extra-'+role)&&data[k].State.Running).join('\\n'));}
else process.exit(1);
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
      ...process.env, DEPLOY_DATABASE_HOST: 'security-db', PATH: root + ':' + process.env.PATH, FIXTURE: fixture } });
    const parent = join(root, 'runtime/coolify');
    const release = join(parent, readdirSync(parent)[0]!, 'release.json');
    let manifest: Record<string, { container: string }> | null = null;
    try { manifest = JSON.parse(readFileSync(release, 'utf8')); } catch { /* Failed snapshots must not publish a manifest. */ }
    return { status: result.status, manifest, stderr: result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
describe('read-only Coolify role snapshot ownership', () => {
  it('snapshots active legacy roles before migration', () => {
    const r = run(false); expect(r.status).toBe(0); expect(r.manifest?.api?.container).toBe('home-security-api');
  });
  it('selects managed roles and ignores stopped rollback containers', () => {
    const r = run(true); expect(r.status).toBe(0); expect(r.manifest?.worker?.container).toBe('managed-notification-worker'); expect(r.manifest?.gateway?.container).toBe('managed-gateway');
  });
  it('rejects duplicate managed owners', () => {
    const r = run(true, true); expect(r.status).toBe(1); expect(r.manifest).toBeNull();
  });
  it('rejects concurrent legacy and managed owners without exposing credentials', () => {
    const r = run(true, false, true); expect(r.status).toBe(1); expect(r.manifest).toBeNull(); expect(r.stderr).not.toContain('postgresql://');
  });
  it('rejects a missing role instead of selecting its stopped rollback container', () => {
    const r = run(true, false, false, true); expect(r.status).toBe(1); expect(r.manifest).toBeNull();
  });
});
