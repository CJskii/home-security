import { z } from 'zod';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const flowSchema=z.object({id:z.literal(process.env.NODE_RED_HOME_SECURITY_FLOW_ID ?? 'example_home_security_tab'),label:z.string(),disabled:z.boolean(),env:z.array(z.object({name:z.string(),type:z.string(),value:z.string()})),nodes:z.array(z.record(z.string(),z.unknown())),configs:z.array(z.unknown()).optional()}).passthrough();
// Verified against the S24 Ultra mobile_app registration on 23 October 2026.
// HA action names follow registration device_name, not the persistent notify entity ID.
export const PRIMARY_PHONE_SERVICE=process.env.NODE_RED_PRIMARY_PHONE_SERVICE ?? 'mobile_app_primary_phone';
const phoneServices=[PRIMARY_PHONE_SERVICE,process.env.NODE_RED_PREVIOUS_PHONE_SERVICE ?? 'mobile_app_previous_phone'];
// Scoped retirement only: preserve MQTT observation, feeds, wires, credentials and
// every unrelated node. A disabled sink also fences alternate/in-flight routing.
export function prepareFrigateNotificationRetirement(input:unknown){
 const flow=z.object({id:z.literal('frigate_v2_stage5'),nodes:z.array(z.record(z.string(),z.unknown()))}).passthrough().parse(input);
 const gates=flow.nodes.filter(n=>n.id==='fv5_delivery_gate'),phones=flow.nodes.filter(n=>n.id==='fv5_mobile_notify');
 if(gates.length!==1||phones.length!==1)throw Error('Expected exactly one reviewed Frigate gate and phone sink');
 const gate=gates[0]!,phone=phones[0]!;
 if(gate.type!=='function'||typeof gate.func!=='string'||!gate.func.includes('if (!ENABLE_LIVE_NOTIFICATIONS)')||!gate.func.includes('return [null, msg];')||!gate.func.includes('return [msg, null];')||JSON.stringify(gate.wires)!==JSON.stringify([['fv5_mobile_notify'],['fv5_live_held_debug']]))throw Error('Frigate gate differs from reviewed path');
 const declarations=gate.func.match(/const ENABLE_LIVE_NOTIFICATIONS = (true|false);/g);
 if(declarations?.length!==1||phone.type!=='api-call-service'||phone.domain!=='notify'||!phoneServices.includes(String(phone.service)))throw Error('Frigate notification target or gate differs');
 gate.func=gate.func.replace('const ENABLE_LIVE_NOTIFICATIONS = true;','const ENABLE_LIVE_NOTIFICATIONS = false;');
 gate.name='LIVE NOTIFICATIONS · DISABLED · Home Security owns alerts';
 phone.d=true;
 phone.name='RETIRED · Primary phone alerts replaced by Home Security';
 return flow;
}
// Repair just the registered phone Action. Never regenerate Functions, gates,
// shared server credentials, wires or notification formatting on a live flow.
export function preparePhoneServiceRepair(input:unknown){
 const flow=flowSchema.parse(input),phones=flow.nodes.filter(n=>n.type==='api-call-service'&&phoneServices.includes(String(n.service)));
 if(phones.length!==1)throw Error('Expected exactly one Primary phone Action');
 Object.assign(phones[0]!,{action:'notify.'+PRIMARY_PHONE_SERVICE,domain:'notify',service:PRIMARY_PHONE_SERVICE});
 return flow;
}
// Exact formatting-only repair of the embedded toolkit. Never reset routing gates,
// regenerate surrounding Function logic or touch phone Actions/credentials.
export function prepareNotificationWordingRepair(input:unknown){
 const flow=flowSchema.parse(input);
 const old="body.action==='update'?body.ai.summary+'\\n'+zones:`${categories} detected in your ${where.toLowerCase()}${zones==='Zone not established'?'':` (${zones})`}`";
 const revised="body.action==='update'?body.ai.summary:`${categories} detected in your ${where.toLowerCase()}`";
 const compile=(expression:string)=>ts.transpileModule('const value = '+expression+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.trim().replace(/^const value = /,'').replace(/;$/,'');
 const pairs=[[old,revised],[compile(old),compile(revised)]] as const;
 let count=0;
 for(const node of flow.nodes){
  if(node.type!=='function'||typeof node.func!=='string')continue;
  const pair=pairs.find(([before])=>(node.func as string).includes(before));
  if(pair){if(node.func.split(pair[0]).length!==2)throw Error('Unexpected formatter multiplicity');node.func=node.func.replace(pair[0],pair[1]);count++;}
  else if(pairs.some(([,after])=>(node.func as string).includes(after)))count++;
 }
 if(count<1)throw Error('Reviewed notification formatter not found');
 return flow;
}
// Prepare only the presentation function for review; no Admin API or gate changes.
export function prepareNotificationPresentationRepair(input:unknown){
 const flow=flowSchema.parse(input);
 const compiled=ts.transpileModule(readFileSync(new URL('../src/notifications/node-red-receiver.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const start='    function notification(body, isTest) {',end='    function folder() {';
 const a=compiled.indexOf(start),b=compiled.indexOf(end,a);if(a<0||b<0)throw Error('Presentation boundaries missing');
 const presentation=compiled.slice(a,b);let count=0;
 for(const node of flow.nodes){
  if(node.type!=='function'||typeof node.func!=='string')continue;
  const x=node.func.indexOf(start),y=node.func.indexOf(end,x);
  if(x<0)continue;if(y<0||node.func.indexOf(start,x+start.length)>=0)throw Error('Unexpected presentation boundaries');
  node.func=node.func.slice(0,x)+presentation+node.func.slice(y);count++;
 }
 if(!count)throw Error('No embedded notification presentation');return flow;
}
// Pure preparation: no Admin API call, credentials or deployment. Preserve every
// existing own-tab node ID/server reference. Caller checks revision and other tabs.
export function prepareLivePhoneFlow(input:unknown,mediaOrigin:string){
 const flow=flowSchema.parse(input),factory=ts.transpileModule(readFileSync(new URL('../src/notifications/node-red-receiver.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export /gm,'').replace(/\/\/# sourceMappingURL=.*$/gm,'');
 const functions=flow.nodes.filter(n=>n.type==='function'),find=(text:string)=>{const n=functions.find(n=>typeof n.name==='string'&&n.name.includes(text));if(!n)throw Error('Expected reviewed node missing');return n;};
 const ingress=find('Verify HMAC'),first=find(process.env.NODE_RED_PRIMARY_ACK_NODE_NAME || 'Durable Primary phone'),finish=find('Durable completion'),route=find('Presence route');
 const phones=flow.nodes.filter(n=>n.type==='api-call-service'),phone=phones.find(n=>phoneServices.includes(String(n.service))),secondary=phones.find(n=>n.service===(process.env.NODE_RED_SECONDARY_PHONE_SERVICE ?? 'mobile_app_secondary_phone'));if(!phone||!secondary)throw Error('Verified phone nodes missing');
 const response=flow.nodes.find(n=>n.type==='http response');if(!response)throw Error('Response missing');
 const common=`${factory}\nconst kit=createReceiverToolkit(fs,path,crypto,env.get('HOME_SECURITY_LEDGER_DIR'),env.get('HOME_SECURITY_MEDIA_ORIGIN'),10000);\nfunction respond(status,payload){msg.statusCode=status;msg.headers={'content-type':'application/json','cache-control':'no-store'};msg.payload=JSON.stringify(payload);return msg;}\nfunction claim(){const h=msg.homeSecurity,c=kit.claim(h.body,h.hash);if(c.outcome==='claimed'){h.token=c.entry.token;return null;}if(c.outcome==='dismissed')return respond(410,kit.rejected(h.body.notificationId));if(c.outcome==='accepted')return respond(200,kit.accepted(h.body.notificationId));if(c.outcome==='conflict')return respond(409,kit.rejected(h.body.notificationId));return respond(500,{error:'notification_outcome_unknown'});}\nfunction unavailable(){return respond(500,{error:'receiver_storage_or_outcome_unknown'});}\n`;
 ingress.func=common+`try{const h=kit.validate(msg.payload,msg.req.headers,env.get('HOME_SECURITY_SIGNING_SECRET'),env.get('HOME_SECURITY_INSTALLATION_ID'));msg.homeSecurity=h;if(h.body.action==='update'&&!h.isTest&&(String(env.get('HOME_SECURITY_AI_UPDATES_ENABLED'))!=='true'||!Number.isFinite(Date.parse(String(env.get('HOME_SECURITY_AI_UPDATES_FROM'))))||Date.parse(h.body.timestamps.receivedAt)<Date.parse(String(env.get('HOME_SECURITY_AI_UPDATES_FROM')))))return[null,null,respond(403,kit.rejected(h.body.notificationId))];msg.notification=kit.notification(h.body,h.isTest);if(String(env.get(h.isTest?'HOME_SECURITY_TEST_PHONE_ENABLED':'HOME_SECURITY_LIVE_ROUTING_ENABLED'))!=='true')return[null,null,respond(403,kit.rejected(h.body.notificationId))];if(!h.isTest){const cutoff=Date.parse(String(env.get('HOME_SECURITY_LIVE_FROM')));if(!Number.isFinite(cutoff)||Date.parse(h.body.timestamps.receivedAt)<cutoff||Date.parse(h.body.timestamps.receivedAt)>Date.now()+60000)return[null,null,respond(403,kit.rejected(h.body.notificationId))];}if(!h.isTest&&String(env.get('HOME_SECURITY_PRESENCE_ROUTING_ENABLED'))==='true')return[null,msg,null];const stop=claim();return stop?[null,null,stop]:[msg,null,null];}catch(e){const auth=e.code==='authentication_rejected',input=['json_required','invalid_json','invalid_notification_identity','invalid_source_metadata','invalid_objects','unsupported_test_or_event_identity','raw_body_required_or_too_large'].includes(e.code);return[null,null,respond(auth?401:input?400:500,{error:auth?'authentication_rejected':input?'invalid_request':'receiver_storage_or_outcome_unknown'})];}`;
 first.func=common+`try{const h=msg.homeSecurity;if(h.isTest||String(env.get('HOME_SECURITY_SECONDARY_ENABLED'))!=='true'){kit.finish(h.body.idempotencyKey,h.token,'ACCEPTED');return[null,respond(200,kit.accepted(h.body.notificationId))];}kit.finish(h.body.idempotencyKey,h.token,'FIRST_PHONE_ACK');return[msg,null];}catch{return[null,unavailable()];}`;
 for(const n of [route,finish]){const old=n.func;if(typeof old!=='string')throw Error('Function missing');const marker=n===route?'try{const h=msg.homeSecurity;':'const failed=Boolean(msg.error);';const index=old.lastIndexOf(marker);if(index<0)throw Error('Reviewed Function marker missing');n.func=common+old.slice(index);}
 // Keep the known working HA Action and queue-none configuration unchanged.
 Object.assign(phone,{name:'TEST / LIVE · Primary phone only · presence bypassed',action:'notify.'+PRIMARY_PHONE_SERVICE,domain:'notify',service:PRIMARY_PHONE_SERVICE});secondary.d=true;
 function env(name:string,value:string,type='bool'){const old=flow.env.find(e=>e.name===name);if(old){old.value=value;old.type=type;}else flow.env.push({name,type,value});}
 env('HOME_SECURITY_MEDIA_ORIGIN',new URL(mediaOrigin).origin,'str');env('HOME_SECURITY_LIVE_FROM','','str');env('HOME_SECURITY_PRESENCE_ROUTING_ENABLED','false');env('HOME_SECURITY_SECONDARY_ENABLED','false');env('HOME_SECURITY_LIVE_ROUTING_ENABLED','false');
 flow.label='Home Security · Primary phone delivery';return flow;
}

// Own-tab-only dismissal listener. Existing HA server/configuration is reused and
// never modified; the listener performs no notify/light/outbound action.
export function prepareNotificationDismissal(flow:ReturnType<typeof prepareLivePhoneFlow>){
 const phone=flow.nodes.find(n=>n.type==='api-call-service'&&phoneServices.includes(String(n.service)));
 if(!phone||typeof phone.server!=='string')throw Error('Existing HA connection missing');
 const ingress=flow.nodes.find(n=>n.type==='function'&&typeof n.name==='string'&&n.name.includes('Verify HMAC'))!;
 const factory=String(ingress.func).split('\nfunction respond(')[0]!;
 const listenerId='08de41c3aa1e21c1',functionId='08de41c3aa1e21c2';
 if(flow.nodes.some(n=>[listenerId,functionId].includes(String(n.id))))return flow;
 flow.nodes.push({id:listenerId,type:'server-events',z:flow.id,name:'Own notification dismissed · stop AI update',server:phone.server,version:3,exposeAsEntityConfig:'',eventType:'mobile_app_notification_cleared',eventData:'',waitForRunning:true,outputProperties:[{property:'payload',propertyType:'msg',value:'',valueType:'eventData'}],x:240,y:660,wires:[[functionId]]});
 flow.nodes.push({id:functionId,type:'function',z:flow.id,name:'Persist Home Security dismissal only',func:factory+"\ntry{const p=msg.payload??{},event=p.event??p,data=event.data??event;kit.dismiss(data.tag);return null;}catch{node.status({fill:'red',shape:'ring',text:'dismissal journal unavailable'});return null;}",outputs:0,noerr:0,initialize:'',finalize:'',libs:ingress.libs,x:610,y:660,wires:[]});
 return flow;
}
