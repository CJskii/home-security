import {expect,it} from 'vitest';
import {prepareFrigateNotificationRetirement} from '../scripts/node-red-live-flow.js';
const gate=`const ENABLE_LIVE_NOTIFICATIONS = true;
if (!ENABLE_LIVE_NOTIFICATIONS) {
 node.status({fill:'yellow',shape:'ring',text:'LIVE OFF · preview only'});
 return [null, msg];
}
node.status({fill:'green',shape:'dot',text:'LIVE ON'});
return [msg, null];`;
const fixture=()=>({id:'frigate_v2_stage5',label:'Frigate Security V2 · Stage 5',disabled:false,env:[],configs:[],nodes:[
 {id:'fv5_mqtt',type:'mqtt in',topic:'frigate/events',wires:[['parser']],broker:'shared-broker'},
 {id:'parser',type:'function',func:'unchanged observer',wires:[['fv5_delivery_gate']]},
 {id:'fv5_delivery_gate',type:'function',name:'OFF until switchover',func:gate,wires:[['fv5_mobile_notify'],['fv5_live_held_debug']]},
 {id:'fv5_mobile_notify',type:'api-call-service',domain:'notify',service:'mobile_app_primary_phone',server:'shared-ha',wires:[[]]},
 {id:'fv5_live_held_debug',type:'debug',wires:[]},
 ]});
it('disables only the reviewed gate and phone sink, with no input mutation or credential/observer changes',()=>{
 const before=fixture(),copy=structuredClone(before),after=prepareFrigateNotificationRetirement(before);
 expect(before).toEqual(copy);expect(after.disabled).toBe(false);expect(after.env).toEqual(before.env);expect(after.configs).toEqual(before.configs);
 expect(after.nodes.filter(n=>!['fv5_delivery_gate','fv5_mobile_notify'].includes(String(n.id)))).toEqual(before.nodes.filter(n=>!['fv5_delivery_gate','fv5_mobile_notify'].includes(n.id)));
 const phone=after.nodes.find(n=>n.id==='fv5_mobile_notify')!;expect(phone).toMatchObject({d:true,server:'shared-ha',service:'mobile_app_primary_phone',wires:[[]]});expect(prepareFrigateNotificationRetirement(after)).toEqual(after);
});
it('routes preview messages only to the held output, including repeated events and both camera payloads',()=>{
 const after=prepareFrigateNotificationRetirement(fixture()),code=after.nodes.find(n=>n.id==='fv5_delivery_gate')!.func as string;
 for(const camera of ['camera_1','camera_2'])for(let n=0;n<3;n++){const msg={payload:{camera,event_id:'offline-fixture'}},statuses:unknown[]=[];const result=new Function('msg','node',code)(msg,{status:(s:unknown)=>statuses.push(s)}) as unknown[];expect(result).toEqual([null,msg]);expect(statuses).toEqual([{fill:'yellow',shape:'ring',text:'LIVE OFF · preview only'}]);}
});
it('refuses unexpected sinks, wiring, duplicate gates or a different tab',()=>{
 for(const mode of ['target','wires','duplicate','tab'] as const){const f=fixture();
  if(mode==='target')f.nodes.find(n=>n.id==='fv5_mobile_notify')!.service='other_phone';
  if(mode==='wires')f.nodes.find(n=>n.id==='fv5_delivery_gate')!.wires=[['other-node']];
  if(mode==='duplicate')f.nodes.push({...f.nodes.find(n=>n.id==='fv5_delivery_gate')!});
  if(mode==='tab')f.id='other';
  expect(()=>prepareFrigateNotificationRetirement(f)).toThrow();
 }
});
