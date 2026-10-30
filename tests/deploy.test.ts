import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { deploymentConfig, validationMessage } from '../scripts/deploy-tools.js';

const { safeLogs, validationSummary } = await import(new URL('../scripts/deploy-diagnostics.mjs', import.meta.url).href) as { validationSummary: (input: string) => string; safeLogs: (input: string) => { kind: string; value: string; time?: string }[] };

const privateValue = 'never-print-this-test-credential';
const image = `sha256:${'a'.repeat(64)}`;
const plan = {
  services: {
    api: { container_name: 'home-security-api', environment: { DATABASE_URL: `postgresql://test:${privateValue}@invalid/security_events` },
      networks: { coolify: null, 'infrastructure-net': null }, ports: [{ host_ip: '127.0.0.1', published: '3000', target: 3000 }] },
    migrate: { environment: { DATABASE_URL: `postgresql://test:${privateValue}@invalid/security_events` }, networks: { coolify: null } },
  }, networks: { coolify: { external: true }, 'infrastructure-net': { external: true } },
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(change: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'security-deploy-test-')); roots.push(root);
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'src'));
  cpSync(resolve('scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(resolve('prisma/migrations'), join(root, 'prisma/migrations'), { recursive: true });
  for (const file of ['config.ts']) cpSync(resolve('src', file), join(root, 'src', file));
  cpSync(resolve('src/notifications'), join(root, 'src/notifications'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'compose.local.yaml'), '# mock configuration');
  writeFileSync(join(root, '.env.local'), `PRIVATE_TEST=${privateValue}\n`, { mode: 0o600 });
  const state = { plan, pending: false, ...change };
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool=process.argv[2], args=process.argv.slice(3);
const root=process.env.MOCK_ROOT, state=JSON.parse(fs.readFileSync(root+'/state.json'));
fs.appendFileSync(root+'/calls.jsonl', JSON.stringify({tool,args,cwd:process.cwd(),umask:process.umask()})+'\\n');
const has=(v)=>args.includes(v), out=(v)=>process.stdout.write(v+'\\n');
const die=()=>{process.stderr.write('${privateValue}');process.exit(1)};
if(tool==='git'){out(has('rev-parse')?'${'b'.repeat(40)}':'');process.exit(0)}
if(tool==='npm'){if(state.validationFailure){out('> residential-security-backend@0.1.0 test');out('Tests 1 failed | 354 passed');process.stderr.write('AssertionError: ${privateValue}');process.exit(state.validationExit ?? 1)}out('${privateValue}');process.exit(0)}
if(tool==='curl'){if(state.probeFailure)die();out(JSON.stringify({status:args.some(v=>v.endsWith('/ready'))?'ready':'ok'}));process.exit(0)}
if(tool!=='docker')die();
if(args[0]==='info'){if(state.daemonFailure)die();process.exit(0)}
if(args[0]==='network'){if(state.missingNetwork===args[2])die();process.exit(0)}
if(args[0]==='exec'){
 const sql=fs.readFileSync(0,'utf8');fs.writeFileSync(root+'/guard-query.sql',sql);
 if(state.databaseUnavailable)die();
 if(state.databaseSlow){setTimeout(()=>process.exit(0),10000);return;}
 const crypto=require('node:crypto');
 let rows=fs.readdirSync(root+'/prisma/migrations',{withFileTypes:true}).filter(v=>v.isDirectory()).map(v=>({migration_name:v.name,checksum:crypto.createHash('sha256').update(fs.readFileSync(root+'/prisma/migrations/'+v.name+'/migration.sql')).digest('hex'),finished_at:'successful',rolled_back_at:null}));
 if(state.pending)rows.pop();
 if(state.historyFailure)rows[0].checksum='modified';
 if(state.historyFailed)rows[0].finished_at=null;
 if(state.historyUnknown)rows.push({...rows[0],migration_name:'unknown'});
 out(state.badHistory?'not-json':JSON.stringify(rows));process.exit(0);
}
if(args[0]==='inspect'){
 const f=args[2];
 if(f.includes('"networks":')){
  if(state.databaseMissing)die();
  out(JSON.stringify({name:'/security-db',networks:{coolify:{Aliases:[state.wrongDatabase?'wrong-host':'invalid']}}}));process.exit(0);
 }

 if(state.absent)die();
 if(f==='{{.Image}}')out('${image}');
 else if(f.includes('.State.Status'))out(state.starting?'running starting':state.unhealthy?'exited unhealthy':'running healthy');
 else out(state.badAttachment?'coolify':'coolify\\ninfrastructure-net');
 process.exit(0);
}
if(args[0]==='container'){process.exit(0)}
if(args[0]==='image'){if(state.tagFailure)die();process.exit(0)}
if(args[0]==='logs'){
 out(JSON.stringify({time:'2026-10-11T20:00:00.000Z',errorCode:'UNIVIEW_STORAGE_UNAVAILABLE',password:'${privateValue}'}));
 out(JSON.stringify({msg:'arbitrary ${privateValue}',payload:'${privateValue}'}));process.exit(0);
}
if(args[0]!=='compose')die();
if(has('version'))process.exit(0);
if(has('config')){out(JSON.stringify(state.plan));process.exit(0)}
if(has('build')){if(state.buildFailure)die();out('${privateValue}');process.exit(0)}
if(has('exec')){process.exit(0)}
if(has('stop'))process.exit(0);
if(has('up')){if(state.upFailure)die();state.absent=false;fs.writeFileSync(root+'/state.json',JSON.stringify(state));process.exit(0)}
die();
`;
  writeFileSync(join(root, 'mock.cjs'), mock);
  for (const tool of ['docker', 'npm', 'git', 'curl']) writeFileSync(join(root, 'bin', tool), `#!/bin/bash\nexec "${process.execPath}" "$MOCK_ROOT/mock.cjs" ${tool} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, MOCK_ROOT: root, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TMPDIR: root, DEPLOY_HEALTH_TIMEOUT_SECONDS: '1', DEPLOY_POSTGRES_CONTAINER: 'security-db' };
  function run(mode = '--quick') {
    const result = spawnSync('/bin/bash', [join(root, 'scripts/deploy.sh'), ...(mode ? [mode] : [])], { env, cwd: tmpdir(), encoding: 'utf8', timeout: 20000 });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain(privateValue);
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(`PRIVATE_TEST=${privateValue}\n`);
    return result;
  }
  function calls() { return existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { tool: string; args: string[]; cwd: string; umask: number }) : []; }
  return { root, env, run, calls };
}

describe('local deployment orchestration using only mocked external commands', () => {
  it('checks configuration read-only from any working directory', () => {
    const f = fixture(); expect(f.run('--check').status).toBe(0);
    expect(f.calls().every((call) => !call.args.some((arg) => ['run', 'build', 'stop', 'up', 'exec'].includes(arg)))).toBe(true);
    expect(existsSync(join(f.root, 'runtime'))).toBe(false);
  });
  it('accepts the actual Compose null network representation in both read-only modes', () => {
    const f = fixture();
    expect(f.run('--check').status).toBe(0); expect(f.run('--status').status).toBe(0);
    expect(f.calls().some((call) => call.args.some((arg) => ['run', 'build', 'stop', 'up', 'exec'].includes(arg)))).toBe(false);
  });
  it('reports a missing network attachment once with a component and remedy, without private values', () => {
    const configured = structuredClone(plan);
    delete (configured.services.api.networks as Record<string, unknown>)['infrastructure-net'];
    const f = fixture({ plan: configured }); const response = f.run('--check');
    expect(response.status).not.toBe(0);
    expect(response.stderr).toContain('COMPOSE_NETWORKS'); expect(response.stderr).toContain('compose.local.yaml');
    expect(response.stderr.match(/Deployment failed at step:/g)).toHaveLength(1);
    expect(f.calls().some((call) => call.args.includes('run') || call.args.includes('build'))).toBe(false);
  });
  it('status works without TypeScript dependencies, compiled output, Compose configuration or environment files', () => {
    const f = fixture(); rmSync(join(f.root, 'node_modules')); rmSync(join(f.root, '.env.local')); rmSync(join(f.root, 'compose.local.yaml'));
    const response = spawnSync('/bin/bash', [join(f.root, 'scripts/deploy.sh'), '--status'], { env: f.env, encoding: 'utf8', timeout: 10000 });
    expect(response.status).toBe(0); expect(response.stdout).toContain(image); expect(response.stdout).toContain('error: UNIVIEW_STORAGE_UNAVAILABLE');
    expect(f.calls().some((call) => call.args[0] === 'compose')).toBe(false);
  });
  it('status retains container and HTTP diagnostics when host Node is unavailable', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'bin/node'), '#!/bin/bash\nexit 127\n', { mode: 0o700 });
    const response = f.run('--status');
    expect(response.status).toBe(0); expect(response.stdout).toContain(image); expect(response.stdout).toContain('HTTP success');
    expect(response.stdout).toContain('Log summary unavailable');
  });
  it('configuration preflight identifies missing tsx/Zod and gives a safe remedy', () => {
    const f = fixture(); rmSync(join(f.root, 'node_modules'));
    const response = f.run('--check'); expect(response.status).not.toBe(0);
    expect(response.stderr).toContain('TypeScript dependencies'); expect(response.stderr).toContain('npm ci');
    expect(response.stderr.match(/Deployment failed at step:/g)).toHaveLength(1);
  });
  it('Node version mismatch has its own remedy and cannot block status', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'bin/node'), `#!/bin/bash\nif [[ "$1" == -p ]]; then echo 20; else exec "${process.execPath}" "$@"; fi\n`, { mode: 0o700 });
    const response = f.run('--check'); expect(response.status).not.toBe(0); expect(response.stderr).toContain('nvm use 24');
    expect(f.run('--status').status).toBe(0);
  });
  it('field-specific configuration errors never include rejected private values', () => {
    const configured = structuredClone(plan); configured.services.api.environment.DATABASE_URL = privateValue;
    const f = fixture({ plan: configured }); const response = f.run('--check');
    expect(response.status).not.toBe(0); expect(response.stderr).toContain('APPLICATION_CONFIG'); expect(response.stderr).toContain('DATABASE_URL');
    expect(response.stderr.match(/Deployment failed at step:/g)).toHaveLength(1);
  });
  it('full mode validates, builds only API, checks history and recreates only API', () => {
    const f = fixture(); expect(f.run('').status).toBe(0);
    const calls = f.calls();
    expect(calls.find((call) => call.tool === 'npm')?.args).toEqual(['run', 'check']);
    expect(calls.find((call) => call.args.includes('build'))?.args.slice(-2)).toEqual(['build', 'api']);
    const audit = calls.findIndex((call) => call.args[0] === 'exec');
    const up = calls.findIndex((call) => call.args.includes('up'));
    expect(audit).toBeGreaterThan(-1); expect(up).toBeGreaterThan(audit);
    expect(calls[up]?.args.slice(-5)).toEqual(['-d', '--no-deps', '--force-recreate', '--no-build', 'api']);
    expect(calls.some((call) => call.tool === 'docker' && (call.args.includes('run') || call.args.includes('stop') || call.args.includes('status')))).toBe(false);
    expect(readFileSync(join(f.root, 'runtime/deploy/previous-image.txt'), 'utf8')).toContain(image);
    expect(readFileSync(join(f.root, 'guard-query.sql'), 'utf8')).toContain('BEGIN READ ONLY;');
    expect(calls.some((call) => call.args.some((arg) => ['down', 'prune', 'reset', '-v'].includes(arg)))).toBe(false);
  });
  it('stops before image builds when full validation fails', () => {
    const f = fixture({ validationFailure: true, validationExit: 17 }); const result = f.run('');
    expect(result.status).toBe(17); expect(result.stderr).toContain('test assertion failure');
    expect(result.stderr).toContain('npm stage: test; failed tests: 1');
    expect(result.stderr.match(/Deployment failed at step:/g)).toHaveLength(1);
    const npm = f.calls().find((call) => call.tool === 'npm');
    expect(npm?.cwd).toBe(f.root); expect(npm?.umask).toBe(0o077);
    expect(npm?.args).toEqual(['run', 'check']);
    expect(f.calls().some((call) => call.args.includes('build') || call.args.includes('stop'))).toBe(false);
  });
  it('quick mode skips npm checks and avoids stopping/migrating with current schema', () => {
    const f = fixture({ pending: false }); expect(f.run().status).toBe(0);
    expect(f.calls().some((call) => call.tool === 'npm' || call.args.includes('stop') || (call.args.includes('run') && call.args.at(-1) === 'migrate'))).toBe(false);
    expect(f.calls().some((call) => call.args.includes('up'))).toBe(true);
  });
  it('quick skips even failing validation while retaining every deployment verification', () => {
    const configured = structuredClone(plan);
    Object.assign(configured.services.api.environment, { METRICS_ENABLED: 'true', METRICS_TOKEN: 'm'.repeat(32) });
    const f = fixture({ plan: configured, validationFailure: true });
    expect(f.run('--quick').status).toBe(0);
    const calls = f.calls();
    expect(calls.some((call) => call.tool === 'npm')).toBe(false);
    expect(calls.find((call) => call.args.includes('build'))?.args.slice(-2)).toEqual(['build', 'api']);
    expect(calls.some((call) => call.args.includes('run') || call.args.includes('stop') || call.tool === 'docker' && call.args.includes('status'))).toBe(false);
    expect(calls.filter((call) => call.args[0] === 'exec')).toHaveLength(1);
    expect(calls.find((call) => call.args.includes('up'))?.args.slice(-5)).toEqual(['-d', '--no-deps', '--force-recreate', '--no-build', 'api']);
    expect(calls.filter((call) => call.tool === 'curl')).toHaveLength(2);
    expect(calls.some((call) => call.args.some((arg) => arg.includes('.State.Status')))).toBe(true);
    expect(calls.some((call) => call.args.some((arg) => arg.includes('.NetworkSettings.Networks')))).toBe(true);
    expect(calls.some((call) => call.args.includes('exec'))).toBe(true);
  });
  it('retains each previous-image record without overwriting old release tags', () => {
    const f = fixture({ pending: false }); expect(f.run().status).toBe(0); expect(f.run().status).toBe(0);
    const tags = f.calls().filter((call) => call.args[0] === 'image').map((call) => call.args.at(-1));
    expect(new Set(tags).size).toBe(2);
  });
  it('supports a missing prior API without inventing a previous image', () => {
    const f = fixture({ absent: true });
    expect(f.run().status).toBe(0);
    expect(f.calls().some((call) => call.args[0] === 'image')).toBe(false);
  });
  it('status exposes only allowlisted diagnostics, never raw logs or configuration', () => {
    const f = fixture(); const result = f.run('--status'); expect(result.status).toBe(0);
    expect(result.stdout).toContain(image); expect(result.stdout).toContain('error: UNIVIEW_STORAGE_UNAVAILABLE');
    expect(f.calls().some((call) => call.args.some((arg) => ['run', 'build', 'stop', 'up', 'exec'].includes(arg)))).toBe(false);
  });
  it.each([
    [{ daemonFailure: true }, 'preflight'], [{ missingNetwork: 'infrastructure-net' }, 'preflight'],
    [{ buildFailure: true }, 'image build'], [{ tagFailure: true }, 'previous image preservation'],
    [{ historyFailure: true }, 'database compatibility guard'], [{ databaseUnavailable: true }, 'database compatibility guard'], [{ upFailure: true }, 'API recreation'],
    [{ unhealthy: true }, 'Docker health'], [{ starting: true }, 'Docker health'], [{ probeFailure: true }, 'Docker health'], [{ badAttachment: true }, 'network verification'],
  ])('fails safely at the identified step for %j', (change, step) => {
    const f = fixture(change); const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain(step);
    expect(f.calls().some((call) => call.args.includes('down') || call.args.includes('reset'))).toBe(false);
  });
  it.each([
    [{ pending: true }, 'pending migrations'], [{ historyFailure: true }, 'checksum mismatch'],
    [{ historyFailed: true }, 'unresolved failed migration'], [{ historyUnknown: true }, 'unknown migration'],
    [{ databaseMissing: true }, 'existing PostgreSQL container unavailable'],
    [{ databaseUnavailable: true }, 'read-only SQL unavailable'], [{ wrongDatabase: true }, 'does not match'],
    [{ badHistory: true }, 'could not be read or validated'],
  ])('blocks incompatible or unavailable history without recreating API: %j', (change, message) => {
    const f = fixture(change); const response = f.run();
    expect(response.status).not.toBe(0); expect(response.stderr).toContain(message);
    expect(response.stderr).toContain('./scripts/check-db-compatibility.sh');
    expect(response.stderr.match(/Deployment failed at step:/g)).toHaveLength(1);
    expect(f.calls().some((call) => call.args.includes('stop') || call.args.includes('up') || call.args.includes('run'))).toBe(false);
  });
  it('bounds an actual stalled SQL subprocess and leaves API untouched', () => {
    const f = fixture({ databaseSlow: true }); const response = f.run();
    expect(response.status).not.toBe(0); expect(response.stderr).toContain('timed out (5 seconds)');
    expect(f.calls().some((call) => call.args.includes('up') || call.args.includes('stop') || call.args.includes('run'))).toBe(false);
  }, 10000);
  it('standalone manual guard is read-only and works without an API container', () => {
    const f = fixture({ absent: true });
    const response = spawnSync('/bin/bash', [join(f.root, 'scripts/check-db-compatibility.sh')], { env: f.env, encoding: 'utf8', timeout: 10000 });
    expect(response.status).toBe(0); expect(response.stdout).toContain('compatible');
    expect(response.stdout + response.stderr).not.toContain(privateValue);
    expect(f.calls().some((call) => call.args.some((arg) => ['build', 'run', 'stop', 'up'].includes(arg)))).toBe(false);
    expect(existsSync(join(f.root, 'runtime'))).toBe(false);
  });
  it('makes status degradation nonzero without mutating services', () => {
    const f = fixture({ probeFailure: true }); expect(f.run('--status').status).not.toBe(0);
    expect(f.calls().some((call) => call.args.includes('stop') || call.args.includes('up'))).toBe(false);
  });
  it('rejects unprotected files even with inherited umask 077, missing files and invalid modes', () => {
    const f = fixture(); rmSync(join(f.root, '.env.local'));
    const r = spawnSync('/bin/bash', [join(f.root, 'scripts/deploy.sh'), '--check'], { env: f.env, encoding: 'utf8' });
    expect(r.status).not.toBe(0); expect(f.calls().every((call) => call.tool === 'docker' && call.args[0] === 'info')).toBe(true);
    const callerMask = process.umask(0o077);
    try {
      writeFileSync(join(f.root, '.env.local'), 'safe', { mode: 0o644 });
      // Creation mode is masked by deploy.sh's umask. Explicit chmod makes
      // this negative fixture independent of inherited permissions.
      chmodSync(join(f.root, '.env.local'), 0o644);
    } finally { process.umask(callerMask); }
    const permissions = spawnSync('/bin/bash', [join(f.root, 'scripts/deploy.sh'), '--check'], { env: f.env, encoding: 'utf8' });
    expect(permissions.status).not.toBe(0); expect(permissions.stderr).toContain('chmod 600');
    writeFileSync(join(f.root, '.env.local'), `PRIVATE_TEST=${privateValue}\n`, { mode: 0o600 });
    chmodSync(join(f.root, '.env.local'), 0o600);
    expect(f.run('--invalid').status).toBe(2);
  });
  it('rejects a concurrent deployment while the repository flock is held', async () => {
    const f = fixture(); mkdirSync(join(f.root, 'runtime/deploy'), { recursive: true });
    const lock = spawn('/bin/bash', ['-c', 'exec 9>"$1"; flock -x 9; echo locked; read -r line', 'lock-holder', join(f.root, 'runtime/deploy/deploy.lock')]);
    try {
      await new Promise<void>((resolve, reject) => { lock.stdout.once('data', () => resolve()); lock.once('error', reject); });
      const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Another deployment'); expect(f.calls().every((call) => call.tool === 'docker' && call.args[0] === 'info')).toBe(true);
    } finally { lock.stdin.end(); }
  });
});

describe('deployment diagnostic boundaries', () => {
  it('rejects public bindings and invalid application configuration', () => {
    expect(deploymentConfig(plan)).toEqual({ service: 'api' });
    const objects = structuredClone(plan) as unknown as { services: Record<string, { networks: Record<string, unknown> }> };
    objects.services.api!.networks = { coolify: {}, 'infrastructure-net': {} };
    objects.services.migrate!.networks = { coolify: {} };
    expect(deploymentConfig(objects)).toEqual({ service: 'api' });
    expect(validationMessage(new Error(privateValue))).not.toContain(privateValue);
    const publicPlan = structuredClone(plan); publicPlan.services.api.ports[0]!.host_ip = '0.0.0.0';
    expect(() => deploymentConfig(publicPlan)).toThrow();
    const invalid = structuredClone(plan); invalid.services.api.environment.DATABASE_URL = 'invalid';
    expect(() => deploymentConfig(invalid)).toThrow();
  });
  it.each([
    ['> typecheck\nerror TS2322: ' + privateValue, 'TypeScript compilation failure'],
    ['> test\nError [ERR_MODULE_NOT_FOUND]: ' + privateValue, 'missing dependency or executable'],
    ['> test\nEPERM: ' + privateValue, 'permission denied'],
    ['> build\nheap out of memory ' + privateValue, 'memory exhaustion'],
    ['> lint\n' + privateValue, 'lint failure'],
    ['> prisma:validate\n' + privateValue, 'Prisma validation/generation failure'],
    [privateValue, 'command failure'],
  ])('classifies validation failures without rendering arbitrary output', (input, category) => {
    const message = validationSummary(input);
    expect(message).toContain(category); expect(message).not.toContain(privateValue);
    expect(message).toContain('(umask 077; npm run check)');
  });
  it('suppresses unknown fields/messages, malformed logs and personal data', () => {
    expect(safeLogs(`invalid\n${JSON.stringify({ msg: privateValue, password: privateValue })}\n${JSON.stringify({ msg: 'AI analysis completed', outcome: 'succeeded', description: privateValue })}`)).toEqual([]);
    expect(safeLogs(JSON.stringify({ errorCode: privateValue }))).toEqual([]);
  });
});


describe('read-only migration history review (no database connections)', () => {
  async function reviewer() {
    return (await import(new URL('../scripts/database-compatibility.mjs', import.meta.url).href)).reviewHistory as
      (files: Map<string, string>, rows: { migration_name: string; checksum: string; finished_at: string | null; rolled_back_at: string | null }[]) => string;
  }
  const files = new Map([['001', 'first'], ['002', 'second']]);
  const first = { migration_name: '001', checksum: 'first', finished_at: 'completed', rolled_back_at: null };
  it('recognises current or pending checked-in history', async () => {
    const review = await reviewer(); expect(review(files, [first])).toBe('pending');
    expect(review(files, [first, { ...first, migration_name: '002', checksum: 'second' }])).toBe('current');
  });
  it.each([
    [], [{ ...first, finished_at: null }], [{ ...first, checksum: 'modified' }],
    [{ ...first, migration_name: 'unknown' }], [{ ...first, migration_name: '002', checksum: 'second' }],
  ].map((rows) => ({ rows })))('rejects empty, failed, modified, divergent or gapped history: %j', async ({ rows }) => {
    const review = await reviewer(); expect(() => review(files, rows)).toThrow();
  });
  it('accepts four successful applied migrations and the movement migration pending', async () => {
    const names = ['20261011000000_init', '20261011010000_m21_ingestion', '20261011020000_detection_identity', '20261011030000_structured_ai', '20261011040000_ai_movement'];
    const actual = new Map(names.map((name) => [name, `checksum-${name}`]));
    const rows = names.slice(0, 4).map((migration_name) => ({ migration_name, checksum: actual.get(migration_name)!, finished_at: 'successful', rolled_back_at: null }));
    expect((await reviewer())(actual, rows)).toBe('pending');
  });
  it('allows an explicitly rolled-back attempt followed by successful matching migration', async () => {
    const review = await reviewer();
    expect(review(files, [{ ...first, finished_at: null, rolled_back_at: 'rolled_back' }, first])).toBe('pending');
  });
});


describe('database compatibility boundaries', () => {
  async function helper() {
    return await import(new URL('../scripts/database-compatibility.mjs', import.meta.url).href) as {
      compatibleHistory: (files: Map<string, string>, rows: unknown) => string;
      databaseTarget: (config: unknown, container: unknown) => void;
      historySql: string;
    };
  }
  it('requires every checked-in migration and validates bounded metadata', async () => {
    const { compatibleHistory, historySql } = await helper();
    const files = new Map([['001', 'first'], ['002', 'second']]);
    const first = { migration_name: '001', checksum: 'first', finished_at: 'successful', rolled_back_at: null };
    expect(() => compatibleHistory(files, [first])).toThrow('pending migrations');
    expect(compatibleHistory(files, [first, { ...first, migration_name: '002', checksum: 'second' }])).toBe('compatible');
    expect(() => compatibleHistory(files, [{}])).toThrow('invalid');
    expect(() => compatibleHistory(files, Array(1001).fill(first))).toThrow('oversized');
    expect(historySql).toContain('BEGIN READ ONLY'); expect(historySql).toContain('statement_timeout');
    expect(historySql).toContain('lock_timeout'); expect(historySql).toContain('LIMIT 1001');
    expect(historySql).not.toMatch(/ALTER|DROP|INSERT|UPDATE|DELETE/);
  });
  it('matches database URL to the selected existing container and public schema', async () => {
    const { databaseTarget } = await helper();
    const container = { name: '/existing', networks: { coolify: { Aliases: ['invalid'] } } };
    expect(() => databaseTarget(plan, container)).not.toThrow();
    expect(() => databaseTarget(plan, { ...container, networks: {} })).toThrow('does not match');
    expect(() => databaseTarget(plan, { ...container, networks: { coolify: { Aliases: ['other'] } } })).toThrow('does not match');
    const config = structuredClone(plan); config.services.api.environment.DATABASE_URL += '?schema=other';
    expect(() => databaseTarget(config, container)).toThrow('does not match');
  });
});
