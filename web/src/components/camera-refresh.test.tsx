import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Outlet,Route,Routes} from 'react-router';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CamerasPage} from '../app';
vi.mock('./live-view',()=>({LiveView:({name}:{name:string})=><div>{name} player</div>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('refreshes metadata in place, using stable camera IDs for filtering and disabling duplicate clicks',async()=>{
 let name='NVR initial',finish!:(r:Response)=>void;
 const request=vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input);
  if(init?.method==='POST')return new Promise(resolve=>{finish=resolve;});
  if(url==='/api/cameras')return Response.json({refreshAvailable:true,cameras:[{id:'camera_1',name,channel:1,defaultProfile:'sub',streamHealth:'unmonitored',synchronization:{state:'fresh',lastSuccessfulAt:'2026-10-20T00:00:00Z',lastAttemptAt:'2026-10-20T00:00:00Z',error:null,intervalSeconds:600}}]});
  if(url.endsWith('/streams'))return Response.json({profiles:[],discovery:{state:'fresh',stale:false,refreshedAt:null}});
  if(url.endsWith('/zones'))return Response.json({zones:[]});
  throw new Error('Unexpected request');
 });vi.stubGlobal('fetch',request);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route element={<Outlet context={{camera:'camera_1'}}/>}><Route path="/" element={<CamerasPage/>}/></Route></Routes></MemoryRouter></QueryClientProvider>);
 await screen.findByText('NVR initial player');const button=screen.getByRole('button',{name:'Refresh camera configuration'});
 await userEvent.click(button);expect((screen.getByRole('button',{name:'Refreshing…'}) as HTMLButtonElement).disabled).toBe(true);
 name='NVR updated';finish(Response.json({channels:[{channel:1,status:'SYNCED'},{channel:2,status:'SYNCED'}]}));
 await screen.findByText('NVR updated player');await waitFor(()=>expect(screen.getByText('Camera configuration refreshed from the NVR.')).toBeTruthy());
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(request.mock.calls.filter(([url])=>String(url).endsWith('/zones')).length).toBeGreaterThan(1);
 expect(request.mock.calls.filter(([url])=>String(url).endsWith('/streams')).length).toBeGreaterThan(1);client.clear();
});
