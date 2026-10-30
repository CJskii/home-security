import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from '../app';
const successful='2026-10-20T12:00:00Z';
const polygon=[{X:100,Y:100},{X:5000,Y:100},{X:9000,Y:5000},{X:5000,Y:9000},{X:100,Y:5000}];
const zoneId='17b01e57-cc3d-4db5-9bdd-f7d89e8149bb';
let client:QueryClient;
afterEach(()=>{cleanup();client?.clear();vi.unstubAllGlobals();});
function setup(available=true, preferences=false) {
 let preference:{displayName:string|null;interested:boolean;updatedAt:string}|null=null;
 let pendingPreference:typeof preference=null;
 let stale=false,name='NVR Camera 1',fingerprint='a'.repeat(64);
 let finish!:(r:Response)=>void;
 const request=vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input);
  if(init?.method==='PATCH'){pendingPreference={...JSON.parse(String(init.body)),updatedAt:successful};return new Promise(resolve=>{finish=resolve;});}
  if(init?.method==='POST')return new Promise(resolve=>{finish=resolve;});
  if(String(input)==='/api/notifications/delivery/settings')return Response.json({available:false,writable:false,revision:0,updatedAt:null,configured:null,secretConfigured:false,approved:[],globalDeliveryEnabled:false,producerEnabled:false,automaticDeliveryAvailable:false,tests:[]});
  if(url==='/api/notifications/history')return Response.json({available:true,producerEnabled:false,deliveryEnabled:false,nextCursor:null,items:[]});
  if(url==='/api/notifications/settings')return Response.json({available:false,writable:false,archivable:false,deliveryAvailable:false,revision:0,updatedAt:null,configuration:{deliveryEnabled:false,rules:[]},cameras:[],zones:[],evaluations:[]});
  if(url==='/api/ai/processing')return Response.json({enforcementAvailable:false,available:false,writable:false,updatedAt:null,configuration:{enabled:true,uncertain:'analyse',unmatched:'analyse',zones:[]},zones:[],latestRecordedAnalysis:null,recent:[],metricsWindowHours:24});
  if(url==='/api/cameras')return Response.json({refreshAvailable:available,cameras:[{id:'camera_1',name,channel:1,defaultProfile:'sub',streamHealth:'unmonitored',synchronization:{state:stale?'stale':'fresh',lastSuccessfulAt:successful,lastAttemptAt:successful,error:stale?'nvr_configuration_unavailable':null,intervalSeconds:600}}]});
  if(url.endsWith('/streams'))return Response.json({profiles:[{id:'sub',videoCodec:'h264',width:1280,height:720,fps:25,enabled:true}],discovery:{state:'fresh',stale:false,refreshedAt:successful}});
  if(url.endsWith('/zones'))return Response.json({preferencesAvailable:preferences,zones:[{id:zoneId,slot:0,name:'Entrance',preference,current:{geometryFingerprint:fingerprint,enabled:true,ruleEnabled:true,polygon,observedAt:successful,configuration:{sensitivity:75,priority:1,targets:[{Type:2,Enabled:1}]}}},{id:'27b01e57-cc3d-4db5-9bdd-f7d89e8149bb',slot:1,name:null,current:{enabled:false,ruleEnabled:true,polygon:[],observedAt:successful}}]});
  throw new Error('Unexpected request');
 });vi.stubGlobal('fetch',request);client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><SettingsPage/></QueryClientProvider>);
 return {request,finish:(r:Response)=>{if(r.ok && pendingPreference)preference=pendingPreference;finish(r)},update:()=>{name='Updated NVR name';},fail:()=>{stale=true;},geometryChanges:()=>{fingerprint='b'.repeat(64);void client.invalidateQueries({queryKey:['zones']});}};
}
it('shows actual metadata and multi-vertex counts, with disabled rules collapsed and future sections free of controls',async()=>{
 setup();await screen.findByText('Entrance');
 expect(screen.getByText(/5 vertices/)).toBeTruthy();expect(screen.getByText(/H264 · 1280×720 · 25 fps configured/)).toBeTruthy();
 expect(screen.getByText('Sensitivity 75 · priority 1')).toBeTruthy();expect(screen.getByText(/NVR target type 2 · enabled/)).toBeTruthy();
 const summary=screen.getByText('Disabled or unverified rules (1)');expect(summary.closest('details')?.open).toBe(false);
 await userEvent.click(summary);expect(screen.getByText('Zone 1')).toBeTruthy();
 for(const label of ['Notifications','AI Processing','System'])expect(screen.getByRole('heading',{name:label})).toBeTruthy();
 expect(screen.queryByRole('textbox')).toBeNull();expect(screen.getAllByRole('checkbox').every(c=>c.matches(':disabled'))).toBe(true);
});
it('refreshes a selected camera, disables all refresh buttons and refetches metadata without reloading',async()=>{
 const f=setup();await screen.findByText('Entrance');await userEvent.click(screen.getByRole('button',{name:'Refresh NVR Camera 1 from NVR'}));
 expect(screen.getAllByRole('button').filter(b=>b.textContent?.includes('from NVR')).every(b=>(b as HTMLButtonElement).disabled)).toBe(true);
 const call=f.request.mock.calls.find(([,init])=>init?.method==='POST');expect(JSON.parse(String(call?.[1]?.body))).toEqual({cameraId:'camera_1'});
 f.update();f.finish(Response.json({channels:[{channel:1,status:'SYNCED'}]}));await screen.findByRole('heading',{name:'Updated NVR name'});
 await waitFor(()=>expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('/zones')).length).toBeGreaterThan(1));
 expect(screen.getByText('Camera configuration refreshed from the NVR.')).toBeTruthy();
});
it('retains metadata and shows stale/error status when refresh fails',async()=>{
 const f=setup();await screen.findByText('Entrance');await userEvent.click(screen.getByRole('button',{name:'Refresh both cameras from NVR'}));f.fail();f.finish(new Response(null,{status:503}));
 await screen.findByRole('alert');expect(screen.getByText('Entrance')).toBeTruthy();expect(screen.getByText(/Stale · showing the last verified/)).toBeTruthy();expect(screen.getByText(/The last synchronization failed/)).toBeTruthy();
});
it('keeps refresh disabled with a clear upgrade explanation on the existing production schema',async()=>{
 setup(false);await screen.findByText('Entrance');expect(screen.getByText(/Refresh is unavailable until the upgraded receiver/)).toBeTruthy();
 expect(screen.getAllByRole('button').filter(b=>b.textContent?.includes('from NVR')).every(b=>(b as HTMLButtonElement).disabled)).toBe(true);
});
it('edits local preferences with a preview and explicit interest semantics; cancel never writes and save refetches names',async()=>{
 const f=setup(true,true);await screen.findByText('Entrance');
 expect(screen.getByRole('img',{name:'Zone 0 current polygon'}).querySelector('polygon')?.getAttribute('points')?.split(' ')).toHaveLength(5);
 const edit=screen.getByRole('button',{name:'Edit local preferences for zone 0'});await userEvent.click(edit);
 await userEvent.type(screen.getByRole('textbox',{name:'Local display name'}),'Unsubmitted');await userEvent.click(screen.getByRole('checkbox',{name:'Interested (local preference)'}));await userEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(f.request.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false);expect(screen.getByText('Entrance')).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Edit local preferences for zone 0'}));await userEvent.type(screen.getByRole('textbox',{name:'Local display name'}),'Local entrance');await userEvent.click(screen.getByRole('checkbox',{name:'Interested (local preference)'}));
 expect(screen.getByText(/does not change NVR enablement/)).toBeTruthy();await userEvent.click(screen.getByRole('button',{name:'Save'}));
 const call=f.request.mock.calls.find(([,i])=>i?.method==='PATCH');expect(String(call?.[0])).toBe(`/api/cameras/camera_1/zones/${zoneId}/preferences`);expect(JSON.parse(String(call?.[1]?.body))).toEqual({displayName:'Local entrance',interested:true,expectedGeometryFingerprint:'a'.repeat(64)});
 expect((screen.getByRole('button',{name:'Saving…'}) as HTMLButtonElement).disabled).toBe(true);f.finish(Response.json({}));await screen.findByText('Local entrance');expect(screen.getByText('Local zone preferences saved.')).toBeTruthy();expect(screen.getByText('Interested')).toBeTruthy();expect(screen.getByText('NVR Enabled')).toBeTruthy();expect(screen.queryByRole('textbox')).toBeNull();
});
it('keeps failed edits and explains stale geometry without claiming a successful save',async()=>{
 const f=setup(true,true);await screen.findByText('Entrance');await userEvent.click(screen.getByRole('button',{name:'Edit local preferences for zone 0'}));await userEvent.type(screen.getByRole('textbox',{name:'Local display name'}),'Draft');await userEvent.click(screen.getByRole('button',{name:'Save'}));f.finish(new Response(null,{status:409}));await screen.findByRole('alert');expect(screen.getByText(/Zone geometry changed/)).toBeTruthy();expect((screen.getByRole('textbox',{name:'Local display name'}) as HTMLInputElement).value).toBe('Draft');expect(screen.queryByText('Local zone preferences saved.')).toBeNull();
});
it('keeps drafts intact but prevents saving against geometry replaced by automatic metadata refetch',async()=>{
 const f=setup(true,true);await screen.findByText('Entrance');await userEvent.click(screen.getByRole('button',{name:'Edit local preferences for zone 0'}));await userEvent.type(screen.getByRole('textbox',{name:'Local display name'}),'Review needed');f.geometryChanges();await screen.findByText(/polygon changed while editing/);expect((screen.getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('textbox',{name:'Local display name'}) as HTMLInputElement).value).toBe('Review needed');
});
