// Entirely synthetic, temporary containers on an internal test-only network.
// Does not attach to Coolify/production networks or use production credentials.
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { setTimeout as pause } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const image = process.env.SMOKE_DASHBOARD_IMAGE ?? 'home-security-dashboard:coolify';
const proxyImage = 'traefik:v3.7'; // Existing host image; --pull=never below.
const prefix = `hs-offline-${process.pid}`;
const directory = mkdtempSync(join(tmpdir(), prefix));
const containers = [];
let network = false;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function run(name, args) {
  docker('run', '-d', '--pull=never', '--name', name, '--network', prefix,
    '--label', 'traefik.enable=false', ...args);
  containers.push(name);
}
try {
  docker('image', 'inspect', image);
  docker('image', 'inspect', proxyImage);
  docker('network', 'create', '--internal', prefix); network = true;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=security.test', '-addext', 'subjectAltName=DNS:security.test,IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  writeFileSync(join(directory, 'mock.mjs'), `
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
createServer((req,res)=>{
 if(req.url==='/health') return res.end('ok');
 if(req.url.startsWith('/api/live/authorize')) return res.writeHead(req.headers.cookie==='dashboard_session=fixture'?200:401).end();
 if(req.url==='/api/session'&&req.method==='POST') return res.writeHead(200,{'Set-Cookie':'dashboard_session=fixture; Path=/api; HttpOnly; Secure; SameSite=Strict'}).end('{}');
 if(req.headers.cookie!=='dashboard_session=fixture') return res.writeHead(401).end();
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({fixture:true,path:req.url}));
}).listen(3000,'0.0.0.0');
const gateway=createServer(); const ws=new WebSocketServer({server:gateway});
ws.on('connection',(socket,req)=>{
 if(req.headers.authorization!=='Basic '+Buffer.from('fixture:fixture').toString('base64')) return socket.close();
 socket.on('message',()=>{socket.send(JSON.stringify({type:'mse',value:'video/mp4; codecs="avc1.4D4029"'}));socket.send(Buffer.from([1,2,3]));});
});gateway.listen(1984,'0.0.0.0');
`);
  writeFileSync(join(directory, 'routes.yaml'), `
http:
  routers:
    dashboard:
      entryPoints: [websecure]
      rule: Host(\x60security.test\x60)
      service: dashboard
      tls: {}
  services:
    dashboard:
      loadBalancer:
        servers: [{url: "http://${prefix}-edge:8080"}]
tls:
  certificates:
    - certFile: /fixtures/cert.pem
      keyFile: /fixtures/key.pem
`);
  run(`${prefix}-mock`, ['-v', `${join(directory, 'mock.mjs')}:/app/mock.mjs:ro`, image, 'node', 'mock.mjs']);
  run(`${prefix}-edge`, ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '-e', 'DASHBOARD_ORIGIN=https://security.test', '-e', `DASHBOARD_API_ORIGIN=http://${prefix}-mock:3000`,
    '-e', 'LIVE_GATEWAY_ENABLED=true', '-e', `SECURITY_GATEWAY_ORIGIN=http://${prefix}-mock:1984`,
    '-e', 'SECURITY_GATEWAY_USER=fixture', '-e', 'SECURITY_GATEWAY_PASSWORD=fixture', image]);
  run(`${prefix}-proxy`, ['-v', `${directory}:/fixtures:ro`, proxyImage,
    '--entrypoints.websecure.address=:8443', '--providers.file.filename=/fixtures/routes.yaml', '--log.level=ERROR']);
  const inspect = JSON.parse(docker('inspect', `${prefix}-proxy`))[0];
  const hostname = inspect.NetworkSettings.Networks[prefix].IPAddress;
  const port = 8443;
  const ca = readFileSync(join(directory, 'cert.pem'));
  function get(path, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = request({ hostname, port, path, method, ca, servername: 'security.test',
        headers: { host: 'security.test', ...headers }, timeout: 3000 }, res => {
        let body = '';res.setEncoding('utf8');res.on('data', part => body += part);
        res.on('end', () => resolve({status:res.statusCode,headers:res.headers,body}));
      });
      req.on('error',reject);req.on('timeout',()=>req.destroy());req.end();
    });
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { ready = (await get('/health')).status === 200; } catch { /* Startup only. */ }
    if (ready) break; await pause(250);
  }
  assert(ready, 'Isolated proxy did not become ready');
  assert.equal((await get('/explore')).status, 200);
  assert.equal((await get('/api/events')).status, 401);
  const login = await get('/api/session', {origin:'https://security.test'}, 'POST');
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get('/api/events?limit=8', {cookie})).status, 200);
  assert.equal((await get('/api/live/authorize?src=camera_1_sub', {cookie})).status, 404);
  assert.equal((await get('/internal/refresh')).status, 404);
  for (const src of ['camera_1_sub','camera_2_sub']) {
    await new Promise((resolve, reject) => {
      const client = new WebSocket(`wss://${hostname}:${port}/api/live/ws?src=${src}`, {ca, servername:'security.test',origin:'https://security.test',headers:{host:'security.test',cookie}});
      const deadline = setTimeout(()=>{client.terminate();reject(new Error('Synthetic MSE timeout'));},5000);
      client.on('error',reject);
      client.on('open',()=>client.send(JSON.stringify({type:'mse',value:'avc1.4D4029'})));
      client.on('message',(data,binary)=>{if(binary){assert.equal(data.toString('hex'),'010203');clearTimeout(deadline);client.close();resolve();}});
    });
  }
  const edgeState = JSON.parse(docker('inspect', `${prefix}-edge`))[0];
  assert.equal(edgeState.Config.User, 'node');
  assert.equal(edgeState.HostConfig.ReadonlyRootfs, true);
  process.stdout.write('PASS: isolated TLS/Traefik, built SPA, cookie proxy, API authentication, denied controls, both restricted MSE streams, non-root/read-only container.\n');
} catch (error) {
  for (const name of containers) { try { process.stderr.write(`${name}: ${docker('logs', '--tail', '5', name)}\n`); } catch { /* Synthetic fixtures only. */ } }
  process.stderr.write(`Isolated smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse()) { try { docker('rm', '-f', name); } catch { /* Best effort only for owned fixtures. */ } }
  if (network) { try { docker('network', 'rm', prefix); } catch { /* No production network touched. */ } }
  rmSync(directory, { recursive: true, force: true });
}
