import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {NotificationSettings} from './notification-settings';
const id='10000000-0000-4000-8000-000000000001',zone='10000000-0000-4000-8000-000000000002',eventId='10000000-0000-4000-8000-000000000003',at='2026-10-20T12:00:00.000Z';
const rule={id,name:'Entrance people',enabled:true,channels:[1],zoneIds:[zone],categories:['PERSON'],cooldownSeconds:60,ambiguous:'exclude',unknown:'exclude'};
const pointer=Element.prototype.hasPointerCapture,scroll=Element.prototype.scrollIntoView;beforeEach(()=>{Element.prototype.hasPointerCapture=()=>false;Element.prototype.scrollIntoView=()=>{};});
let client:QueryClient;afterEach(()=>{cleanup();client?.clear();vi.unstubAllGlobals();if(pointer)Element.prototype.hasPointerCapture=pointer;else Reflect.deleteProperty(Element.prototype,'hasPointerCapture');if(scroll)Element.prototype.scrollIntoView=scroll;else Reflect.deleteProperty(Element.prototype,'scrollIntoView')});
function setup(available=true,writable=true){let revision=1,configuration={deliveryEnabled:false,rules:[structuredClone(rule)]};
 const snapshot=()=>({available,writable,archivable:writable,deliveryAvailable:false,revision,updatedAt:at,configuration,cameras:[{channel:1,name:'NVR camera'}],zones:[{id:zone,channel:1,slot:0,name:'Entrance'}],evaluations:[]});
 const request=vi.fn<typeof fetch>(async(input,init)=>{
  if(String(input)==='/api/notifications/delivery/settings')return Response.json({available:false,writable:false,revision:0,updatedAt:null,configured:null,secretConfigured:false,approved:[],globalDeliveryEnabled:false,producerEnabled:false,automaticDeliveryAvailable:false,tests:[]});
  if(String(input).startsWith('/api/notifications/history'))return Response.json({available:true,producerEnabled:false,deliveryEnabled:false,nextCursor:null,items:[]});
  if(init?.method==='PUT'){configuration=JSON.parse(String(init.body)).configuration;revision++;return Response.json(snapshot());}
  if(String(input)==='/api/notifications/preview')return Response.json({algorithm:'source_zone_rules_v1',deliveryAvailable:false,deliveryEnabled:false,revision,fingerprint:'a'.repeat(64),eventCount:4,cooldownScope:'preview_window_only',window:{from:at,to:'2026-10-20T13:00:00.000Z'},configuration,objects:[],decisions:['would_notify','cooldown','uncertain','unmatched'].map((outcome,i)=>({eventId:eventId.slice(0,-1)+String(i+3),ruleId:id,receivedAt:at,outcome,reason:['source_category_and_zone','rule_cooldown','unknown_excluded','zone_not_selected'][i],objectIds:[],zoneVersionIds:[],idempotencyKey:'notification:v1:event'+i,cooldownUntil:outcome==='cooldown'?at:null}))});
  if(String(input)==='/api/notifications/evaluations')return Response.json({id,fingerprint:'a'.repeat(64),configurationRevision:revision,createdAt:at,deliveryAvailable:false});
  return Response.json(snapshot());
 });vi.stubGlobal('fetch',request);client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});render(<QueryClientProvider client={client}><NotificationSettings/></QueryClientProvider>);return {request};
}
it('edits independent NVR rules with Save/Cancel and delivery still explicitly unavailable',async()=>{
 const f=setup();const global=await screen.findByRole('checkbox',{name:/Global delivery preference/});expect((global as HTMLInputElement).checked).toBe(false);expect(screen.getByText(/Automatic delivery requires the global preference/)).toBeTruthy();
 await userEvent.click(global);await userEvent.click(screen.getByRole('button',{name:'Cancel notifications'}));expect((global as HTMLInputElement).checked).toBe(false);expect(f.request.mock.calls.some(([,v])=>v?.method==='PUT')).toBe(false);
 await userEvent.click(screen.getByRole('checkbox',{name:'Rule enabled'}));const cooldown=screen.getByRole('spinbutton',{name:'Cooldown (seconds)'});await userEvent.clear(cooldown);await userEvent.type(cooldown,'120');
 await userEvent.click(screen.getByRole('button',{name:'Save notifications'}));await screen.findByText('Notification settings saved. Delivery remains unavailable.');const body=JSON.parse(String(f.request.mock.calls.find(([,v])=>v?.method==='PUT')?.[1]?.body));expect(body).toMatchObject({expectedRevision:1,configuration:{deliveryEnabled:false,rules:[{enabled:false,cooldownSeconds:120,channels:[1],zoneIds:[zone],categories:['PERSON']}]}});
 expect(f.request.mock.calls.some(([url])=>String(url).includes('/ai/'))).toBe(false);
});
it('previews without writes, explains all outcomes and archives only when explicitly requested',async()=>{
 const f=setup();await screen.findByRole('button',{name:'Preview rules'});await userEvent.click(screen.getByRole('button',{name:'Preview rules'}));await screen.findByText(/4 canonical events · 1 would match · 1 cooldown suppressions · 1 uncertain/);
 expect(f.request.mock.calls.some(([url])=>String(url)==='/api/notifications/evaluations')).toBe(false);
 await userEvent.click(screen.getByText('Entrance people · 1 matches'));for(const text of['Source category and zone','Rule cooldown','Unknown excluded','Zone not selected'])expect(screen.getByText(new RegExp(text,'i'))).toBeTruthy();
 expect(screen.getAllByRole('link').every(a=>a.getAttribute('href')?.startsWith('/explore?event='))).toBe(true);
 await userEvent.click(screen.getByRole('button',{name:'Save evaluation record'}));await screen.findByText('Evaluation record saved. Nothing was sent.');expect(f.request.mock.calls.filter(([url])=>String(url)==='/api/notifications/evaluations')).toHaveLength(1);
});
it('supports camera/zone/category selections and explicit uncertain handling without automatic writes',async()=>{
 const f=setup();const section=await screen.findByRole('region',{name:'Notification rule 1'}),scope=within(section);
 await userEvent.click(scope.getByRole('checkbox',{name:'motor vehicle'}));await userEvent.click(scope.getByRole('combobox',{name:'Unknown / missing geometry'}));await userEvent.click(screen.getByRole('option',{name:'Include'}));
 await userEvent.click(screen.getByRole('button',{name:'Save notifications'}));await screen.findByText('Notification settings saved. Delivery remains unavailable.');const saved=JSON.parse(String(f.request.mock.calls.find(([,v])=>v?.method==='PUT')?.[1]?.body));expect(saved.configuration.rules[0]).toMatchObject({categories:['PERSON','MOTOR_VEHICLE'],unknown:'include',ambiguous:'exclude'});
 await userEvent.click(screen.getByRole('button',{name:'Add notification rule'}));expect(screen.getAllByRole('region',{name:/Notification rule/})).toHaveLength(2);expect((screen.getByRole('button',{name:'Preview rules'}) as HTMLButtonElement).disabled).toBe(true);
 await userEvent.click(screen.getByRole('button',{name:'Cancel notifications'}));expect(screen.getAllByRole('region',{name:/Notification rule/})).toHaveLength(1);
});
it('handles unavailable migration and read-only access without offering writes',async()=>{
 setup(false,false);await screen.findByText('Notification migration required. Existing source events are unaffected.');for(const button of['Add notification rule','Save notifications','Preview rules'])expect(screen.getByRole('button',{name:button}).matches(':disabled')).toBe(true);
});
it('keeps an edited draft after failed save and lets the user cancel',async()=>{
 const f=setup();await screen.findByRole('textbox',{name:'Rule name'});await userEvent.clear(screen.getByRole('textbox',{name:'Rule name'}));await userEvent.type(screen.getByRole('textbox',{name:'Rule name'}),'Draft name');f.request.mockImplementationOnce(async()=>new Response(null,{status:409}));await userEvent.click(screen.getByRole('button',{name:'Save notifications'}));await screen.findByRole('alert');expect((screen.getByRole('textbox',{name:'Rule name'}) as HTMLInputElement).value).toBe('Draft name');await userEvent.click(screen.getByRole('button',{name:'Cancel notifications'}));await waitFor(()=>expect((screen.getByRole('textbox',{name:'Rule name'}) as HTMLInputElement).value).toBe('Entrance people'));
});
