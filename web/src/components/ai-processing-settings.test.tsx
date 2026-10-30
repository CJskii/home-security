import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AiProcessingSettings} from './ai-processing-settings';
import {aiStatus,locationNames} from './event-location';
import type {SecurityEvent} from '@/lib/contracts';
let client:QueryClient;afterEach(()=>{cleanup();client?.clear();vi.unstubAllGlobals();});
const id='10000000-0000-4000-8000-000000000000';
it('saves independent proposals, supports cancel and keeps enforcement visibly held back',async()=>{
 let configuration={enabled:true,uncertain:'analyse',unmatched:'analyse',zones:[{zoneId:id,enabled:true}]};
 const request=vi.fn<typeof fetch>(async(_input,init)=>{if(init?.method==='PUT')configuration=JSON.parse(String(init.body));return Response.json({available:true,writable:true,enforcementAvailable:false,updatedAt:null,configuration,zones:[{zoneId:id,channel:1,slot:0,name:'Entrance',interested:false}],latestRecordedAnalysis:{model:'fixture-model',promptVersion:5,schemaVersion:3,completedAt:'2026-10-20T12:00:00Z'},recent:[{status:'SKIPPED',reason:'capacity_exceeded',count:3}],metricsWindowHours:24});});
 vi.stubGlobal('fetch',request);client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><AiProcessingSettings/></QueryClientProvider>);
 const checkbox=await screen.findByRole('checkbox',{name:/Analyse with AI/});expect((checkbox as HTMLInputElement).checked).toBe(true);expect(screen.getByText(/Camera 1 · slot 0 · Interested: no/)).toBeTruthy();
 await userEvent.click(checkbox);await userEvent.click(screen.getByRole('button',{name:'Cancel proposal'}));expect((checkbox as HTMLInputElement).checked).toBe(true);
 await userEvent.click(checkbox);await userEvent.click(screen.getByRole('button',{name:'Save proposal'}));await screen.findByText('Settings saved. They apply to new events only when the receiver switch is explicitly enabled.');
 expect(configuration.zones[0]?.enabled).toBe(false);expect(screen.getByText(/Activation is controlled only by the receiver/)).toBeTruthy();
 await waitFor(()=>expect(request.mock.calls.filter(([,v])=>v?.method==='PUT')).toHaveLength(1));
 expect(screen.getByText(/Latest recorded analysis: fixture-model/)).toBeTruthy();
});
it('keeps reliable zone labels separate from tentative locations and AI skip reasons distinct',()=>{
 const event={objects:[{location:{status:'MATCHED',matches:[{zoneId:id,name:'Entrance'}]}},{location:{status:'MATCHED',matches:[{zoneId:id,name:'Entrance'}]}},{location:{status:'AMBIGUOUS',matches:[{zoneId:'other',name:'Tentative'}]}}],processing:{status:'SKIPPED',reason:'zone_not_selected'}} as unknown as SecurityEvent;
 expect(locationNames(event)).toHaveLength(1);expect(aiStatus(event)).toBe('AI not selected');expect(aiStatus({...event,processing:{status:'SKIPPED',reason:'capacity_exceeded'}})).toBe('AI skipped · capacity');expect(aiStatus({...event,processing:{status:'COMPLETE',reason:'ai_disabled'}})).toBe('AI disabled');expect(aiStatus({...event,processing:{status:'SKIPPED',reason:'ai_disabled'}})).toBe('AI disabled');
});
it('offers an explicit editable driveway/walkway-only proposal without following notification interest or saving automatically',async()=>{
 const ids=['10000000-0000-4000-8000-000000000000','20000000-0000-4000-8000-000000000000','30000000-0000-4000-8000-000000000000'];
 const request=vi.fn<typeof fetch>(async()=>Response.json({available:true,writable:true,enforcementAvailable:false,updatedAt:null,configuration:{enabled:false,uncertain:'exclude',unmatched:'analyse',zones:ids.map(zoneId=>({zoneId,enabled:false}))},zones:[{zoneId:ids[0],channel:1,slot:0,name:'My Driveway',interested:false},{zoneId:ids[1],channel:2,slot:0,name:'My Walkway',interested:false},{zoneId:ids[2],channel:1,slot:3,name:'Road',interested:true}],latestRecordedAnalysis:null,recent:[],metricsWindowHours:24}));
 vi.stubGlobal('fetch',request);client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><AiProcessingSettings/></QueryClientProvider>);
 await userEvent.click(await screen.findByRole('button',{name:'Propose driveway and walkway only'}));
 for(const name of['My Driveway','My Walkway'])expect((screen.getByRole('checkbox',{name:new RegExp(`Analyse with AI · ${name}`)}) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByRole('checkbox',{name:/Analyse with AI · Road/}) as HTMLInputElement).checked).toBe(false);
 expect(request.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Cancel proposal'}));expect((screen.getByRole('checkbox',{name:/Analyse with AI · My Driveway/}) as HTMLInputElement).checked).toBe(false);
});
