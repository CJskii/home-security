import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { parse } from 'dotenv';
import { URL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';

const root = fileURLToPath(new URL('../', import.meta.url));
const settingsFile = new URL('../../.env.dashboard.local', import.meta.url);
if ((statSync(settingsFile).mode & 0o077) !== 0) throw new Error('Development environment requires mode 600');
const lanIp = parse(readFileSync(settingsFile)).DEV_LAN_IP;
if (!lanIp || !isIPv4(lanIp)) throw new Error('Set DEV_LAN_IP in .env.dashboard.local');
const directory = join(root, '.cache', 'lan-tls');
const key = join(directory, 'key.pem');
const certificate = join(directory, 'cert.pem');
if (process.argv.slice(2).some((argument) => argument !== '--prepare-only')) {
  throw new Error('Usage: node scripts/dev-lan.mjs [--prepare-only]');
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const valid = existsSync(key) && existsSync(certificate) && spawnSync('openssl', [
  'x509', '-checkend', '86400', '-noout', '-in', certificate,
], { stdio: 'ignore' }).status === 0 && spawnSync('openssl', ['x509', '-checkip', lanIp, '-noout', '-in', certificate], { stdio: 'ignore' }).status === 0;
if (!valid) {
  const previousMask = process.umask(0o077);
  try {
    const result = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '30',
      '-keyout', key, '-out', certificate, '-subj', '/CN=Home Security LAN Development',
      '-addext', `subjectAltName=IP:${lanIp}`,
    ], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Could not create the development certificate. Install OpenSSL and retry.');
  } finally {
    process.umask(previousMask);
  }
}
chmodSync(key, 0o600);
chmodSync(certificate, 0o600);
log(`Dashboard LAN development: https://${lanIp}:5173`);
log('Uses a local self-signed certificate. Confirm its certificate warning on your PC.');
if (!process.argv.includes('--prepare-only')) {
  const child = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DASHBOARD_DEV_LAN: 'true', DEV_LAN_IP: lanIp },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
}
