// Read-only Docker inspection. Writes a NEW protected local recovery directory;
// never starts/stops containers, writes Coolify or prints configuration values.
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
process.umask(0o077);
const parent = resolve(root, 'runtime/coolify');
mkdirSync(parent, { recursive: true, mode: 0o700 });
if (realpathSync(parent) !== parent) throw new Error('Recovery directory must not be a symlink');
const directory = resolve(parent, new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { mode: 0o700 });
const expectedDatabaseHost = process.env.DEPLOY_DATABASE_HOST;
if (!expectedDatabaseHost || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(expectedDatabaseHost)) throw new Error('Set DEPLOY_DATABASE_HOST to the expected database host before snapshotting');
const roles = { api: 'home-security-api', receiver: 'home-security-receiver', worker: 'home-security-notification-worker', gateway: 'home-security-live-dev-gateway-1' };
try {
  const manifest = {};
  for (const [role, legacy] of Object.entries(roles)) {
    const service = role === 'worker' ? 'notification-worker' : role;
    const ids = execFileSync('docker', ['ps', '-q',
      '--filter', 'label=com.docker.compose.project=home-security-coolify',
      '--filter', 'label=com.docker.compose.service=' + service],
    { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    // A stopped legacy container is a rollback artifact, not the active owner.
    let old = null;
    try { [old] = JSON.parse(execFileSync('docker', ['inspect', legacy],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })); } catch { /* Legacy role may no longer exist. */ }
    const candidates = ids.map(id => JSON.parse(execFileSync('docker', ['inspect', id],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }))[0]);
    if (old?.State.Running && !candidates.some(candidate => candidate.Id === old.Id)) candidates.push(old);
    if (candidates.length !== 1) throw new Error('Expected exactly one active role owner');
    const container = candidates[0];
    const name = container.Name.replace(/^\//, '');
    if (container.State.Status !== 'running' || !/^sha256:[a-f0-9]{64}$/.test(container.Image)) throw new Error('Role is unavailable');
    const values = container.Config.Env;
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || /[\r\n]/.test(value) || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)))
      throw new Error('Environment cannot be represented by a raw env_file');
    const env = Object.fromEntries(values.map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
    if (role !== 'gateway') {
      const database = new URL(env.DATABASE_URL);
      if (database.hostname !== expectedDatabaseHost || database.pathname !== '/security_events') throw new Error('Unexpected database target');
    } else if (!['SECURITY_GATEWAY_USER', 'SECURITY_GATEWAY_PASSWORD', 'NVR_C1_SUB_RTSP', 'NVR_C2_SUB_RTSP'].every(key => env[key])) {
      throw new Error('Gateway runtime credentials unavailable');
    }
    writeFileSync(resolve(directory, `${role}.env`), values.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    manifest[role] = { container: name, image: container.Image, command: container.Config.Cmd,
      restart: container.HostConfig.RestartPolicy.Name, envFile: resolve(directory, `${role}.env`) };
  }
  writeFileSync(resolve(directory, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(`Protected role environment/image snapshot created: ${directory}\nNo services changed.\n`);
} catch {
  process.stderr.write('Snapshot incomplete; do not use it. Existing services were not modified. Private details withheld.\n');
  process.exitCode = 1;
}
