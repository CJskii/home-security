import { afterEach, expect, it } from 'vitest';
import { prepareLivePhoneFlow } from '../scripts/node-red-live-flow.js';
import * as fs from 'node:fs';import * as path from 'node:path';import * as crypto from 'node:crypto';import { tmpdir } from 'node:os';
import { samplePayload } from '../src/notifications/sample-payload.js';
const installation='10000000-0000-4000-8000-000000000001',id='10000000-0000-4000-8000-000000000002',secret='s'.repeat(32),dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function setup(){const dir=fs.mkdtempSync(path.join(tmpdir(),'home-security-live-'));dirs.push(dir);const input={id:'example_home_security_tab',label:'Isolated',disabled:false,env:[{name:'HOME_SECURITY_LEDGER_DIR',type:'str',value:path.join(dir,'journal')},{name:'HOME_SECURITY_SIGNING_SECRET',type:'cred',value:''}],configs:[],nodes:[{id:'ingress',type:'function',name:'Verify HMAC',func:''},{id:'first',type:'function',name:'Durable Primary phone',func:''},{id:'finish',type:'function',name:'Durable completion',func:'const failed=Boolean(msg.error);return msg;'},{id:'route',type:'function',name:'Presence route',func:'try{const h=msg.homeSecurity;return h;}catch{return null;}'},{id:'phone',type:'api-call-service',service:'mobile_app_previous_phone',server:'unchanged-server',queue:'none'},{id:'phone2',type:'api-call-service',service:'mobile_app_secondary_phone'},{id:'response',type:'http response'}]};const flow=prepareLivePhoneFlow(input,'http://192.168.50.10:3000');const env={...Object.fromEntries(flow.env.map(e=>[e.name,e.value])),HOME_SECURITY_SIGNING_SECRET:secret,HOME_SECURITY_INSTALLATION_ID:installation,HOME_SECURITY_TEST_PHONE_ENABLED:'true',HOME_SECURITY_LIVE_ROUTING_ENABLED:'true',HOME_SECURITY_LIVE_FROM:new Date(Date.now()-1000).toISOString()};const run=(name:string,msg:unknown)=>new Function('msg','env','fs','path','crypto',flow.nodes.find(n=>n.id===name)!.func as string)(msg,{get:(key:string)=>env[key as keyof typeof env]},fs,path,crypto);return{input,flow,env,run};}
it('sends LIVE to Primary phone only regardless of presence; a restart/retry returns stored receipt without another action',()=>{const f=setup(),body={...samplePayload(id,installation,new Date(),'https://dashboard.example'),type:'security.event',action:'create',test:false,eventId:id,idempotencyKey:`notification:v1:${installation}:${id}`},raw=Buffer.from(JSON.stringify(body)),stamp=String(Math.floor(Date.now()/1000)),headers={'content-type':'application/json','idempotency-key':body.idempotencyKey,'x-home-security-timestamp':stamp,'x-home-security-signature':'sha256='+crypto.createHmac('sha256',secret).update(stamp+'.'+body.idempotencyKey+'.').update(raw).digest('hex')};const request=()=>({payload:raw,req:{headers},presencePrimary:'home',presenceSecondary:'home'});const result=f.run('ingress',request());expect(result[0]).toBeTruthy();expect(result[1]).toBeNull();let calls=0;calls++;const completed=f.run('first',result[0]);expect(completed[0]).toBeNull();expect(JSON.parse(completed[1].payload).outcome).toBe('accepted');const retry=f.run('ingress',request());expect(retry[0]).toBeNull();expect(retry[1]).toBeNull();expect(JSON.parse(retry[2].payload).notificationId).toBe(id);expect(calls).toBe(1);expect(f.flow.nodes.find(n=>n.id==='phone2')!.d).toBe(true);});
it('does not mutate input or enable LIVE during preparation and preserves the known working HA server/queue',()=>{const f=setup();expect(f.input.env).toHaveLength(2);expect(f.flow.env.find(e=>e.name==='HOME_SECURITY_LIVE_ROUTING_ENABLED')!.value).toBe('false');expect(f.flow.nodes.find(n=>n.id==='phone')).toMatchObject({server:'unchanged-server',queue:'none'});});
it('holds incomplete action outcomes across retries and keeps TEST functional independently of LIVE',()=>{const f=setup();f.env.HOME_SECURITY_LIVE_ROUTING_ENABLED='false';const body=samplePayload(id,installation,new Date(),'https://dashboard.example'),raw=Buffer.from(JSON.stringify(body)),stamp=String(Math.floor(Date.now()/1000)),headers={'content-type':'application/json','x-home-security-test':'true','idempotency-key':body.idempotencyKey,'x-home-security-timestamp':stamp,'x-home-security-signature':'sha256='+crypto.createHmac('sha256',secret).update(stamp+'.'+body.idempotencyKey+'.').update(raw).digest('hex')};const request=()=>({payload:raw,req:{headers}});expect(f.run('ingress',request())[0]).toBeTruthy();const retry=f.run('ingress',request());expect(retry[0]).toBeNull();expect(retry[2].statusCode).toBe(500);});

it('fails closed for LIVE without an explicit start cutoff or for a historical event before it',()=>{const f=setup();const body={...samplePayload(id,installation,new Date(Date.now()-3600000),'https://dashboard.example'),type:'security.event',action:'create',test:false,eventId:id,idempotencyKey:`notification:v1:${installation}:${id}`},raw=Buffer.from(JSON.stringify(body)),stamp=String(Math.floor(Date.now()/1000)),headers={'content-type':'application/json','idempotency-key':body.idempotencyKey,'x-home-security-timestamp':stamp,'x-home-security-signature':'sha256='+crypto.createHmac('sha256',secret).update(stamp+'.'+body.idempotencyKey+'.').update(raw).digest('hex')};const result=f.run('ingress',{payload:raw,req:{headers}});expect(result[0]).toBeNull();expect(result[2].statusCode).toBe(403);expect(fs.existsSync(path.join(dirs.at(-1)!,'journal'))).toBe(false);});

it('repairs only the phone service, preserving functions, server/queue, env, wires and unrelated nodes',async()=>{
 const {preparePhoneServiceRepair,PRIMARY_PHONE_SERVICE}=await import('../scripts/node-red-live-flow.js');const f=setup();const before=structuredClone(f.flow);const phone=before.nodes.find(n=>n.id==='phone')!;Object.assign(phone,{action:'notify.mobile_app_previous_phone',domain:'notify',service:'mobile_app_previous_phone',wires:[['first']]});const fixed=preparePhoneServiceRepair(before);
 expect(fixed.nodes.find(n=>n.id==='phone')).toEqual({...phone,action:'notify.'+PRIMARY_PHONE_SERVICE,service:PRIMARY_PHONE_SERVICE});
 expect(fixed.nodes.filter(n=>n.id!=='phone')).toEqual(before.nodes.filter(n=>n.id!=='phone'));expect(fixed.env).toEqual(before.env);expect(phone.service).toBe('mobile_app_previous_phone');expect(preparePhoneServiceRepair(fixed)).toEqual(fixed);
 expect(()=>preparePhoneServiceRepair({...before,nodes:[...before.nodes,{...phone,id:'duplicate'}]})).toThrow('exactly one');
});
it('future flow preparation uses the registered S24 service after duplicate server removal restores the named registration',()=>{
 const f=setup();expect(f.flow.nodes.find(n=>n.id==='phone')).toMatchObject({action:'notify.mobile_app_primary_phone',service:'mobile_app_primary_phone',domain:'notify',server:'unchanged-server',queue:'none'});
});

it('changes only the reviewed redundant wording and preserves all other flow configuration',async()=>{
 const {prepareNotificationWordingRepair}=await import('../scripts/node-red-live-flow.js');
 const old="body.action==='update'?body.ai.summary+'\\n'+zones:`${categories} detected in your ${where.toLowerCase()}${zones==='Zone not established'?'':` (${zones})`}`";
 const f=setup(),before=structuredClone(f.flow);before.nodes.find(n=>n.id==='ingress')!.func='prefix '+old+' suffix';
 const result=prepareNotificationWordingRepair(before);
 expect(result.nodes.find(n=>n.id==='ingress')!.func).toBe("prefix body.action==='update'?body.ai.summary:`${categories} detected in your ${where.toLowerCase()}` suffix");
 expect(result.env).toEqual(before.env);expect(result.nodes.filter(n=>n.id!=='ingress')).toEqual(before.nodes.filter(n=>n.id!=='ingress'));
 expect(before.nodes.find(n=>n.id==='ingress')!.func).toContain(old);
 expect(prepareNotificationWordingRepair(result)).toEqual(result);
 expect(()=>prepareNotificationWordingRepair({...before,nodes:[]})).toThrow('formatter not found');
});

it('prepares only presentation functions without resetting live gates or phone routing',async()=>{
 const {prepareNotificationPresentationRepair}=await import('../scripts/node-red-live-flow.js');const f=setup(),before=structuredClone(f.flow);
 const node=before.nodes.find(n=>n.id==='ingress')!;node.func=String(node.func).replace('🚨 ${where}','🚨 OLD ${where}');
 const updated=prepareNotificationPresentationRepair(before);expect(updated.nodes.find(n=>n.id==='ingress')!.func).not.toContain('🚨 OLD');
 expect(updated.env).toEqual(before.env);expect(updated.nodes.filter(n=>n.type!=='function')).toEqual(before.nodes.filter(n=>n.type!=='function'));
 for(const next of updated.nodes.filter(n=>n.type==='function')){const old=String(before.nodes.find(n=>n.id===next.id)!.func),value=String(next.func);const strip=(s:string)=>s.replace(/ {4}function notification\(body, isTest\) \{[\s\S]*?(?= {4}function folder\(\) \{)/,'');expect(strip(value)).toBe(strip(old));}
 expect(prepareNotificationPresentationRepair(updated)).toEqual(updated);
});

it('repairs an Admin API flow with omitted optional configs without adding or changing configuration nodes',async()=>{
 const {preparePhoneServiceRepair}=await import('../scripts/node-red-live-flow.js');const f=setup(),{configs,...withoutConfigs}=f.flow;void configs;
 const repaired=preparePhoneServiceRepair(withoutConfigs);expect(repaired).not.toHaveProperty('configs');expect(repaired.env).toEqual(withoutConfigs.env);
});
