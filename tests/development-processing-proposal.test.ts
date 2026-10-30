import {expect,it,vi} from 'vitest';
import {developmentProcessingProposalWriter} from '../src/dashboard/development-processing-proposal.js';
import {buildDevelopmentApp} from '../src/dashboard/development.js';
import {config} from './uniview-fixtures.js';
const installation=config.UNIVIEW_INSTALLATION_ID!,value={enabled:true,uncertain:'analyse' as const,unmatched:'exclude' as const,zones:[]};
it('forwards only validated installation-scoped settings to the fixed loopback API, never an activation switch',async()=>{
 const body={enforcementAvailable:false,available:true,writable:true,updatedAt:null,configuration:value,zones:[],latestRecordedAnalysis:null,recent:[],metricsWindowHours:24},request=vi.fn<typeof fetch>(async()=>Response.json(body));
 expect(developmentProcessingProposalWriter(config,undefined,request)).toBeUndefined();
 const write=developmentProcessingProposalWriter(config,'s'.repeat(32),request)!;expect(await write(installation,value)).toEqual(body);
 expect(request).toHaveBeenCalledWith('http://127.0.0.1:3000/api/ai/processing',expect.objectContaining({method:'PUT',redirect:'error',headers:expect.objectContaining({authorization:'Bearer '+'s'.repeat(32)})}));
 await expect(write('00000000-0000-4000-8000-000000000001',value)).rejects.toThrow();
 await expect(write(installation,{...value,AI_ZONE_SELECTION_ENABLED:true} as typeof value)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 request.mockResolvedValueOnce(Response.json({...body,credentials:'forbidden extra'}));await expect(write(installation,value)).rejects.toThrow();
 request.mockResolvedValueOnce(new Response(null,{status:503}));await expect(write(installation,value)).rejects.toThrow('Compatible API');
});
it('requires session and exact origin for local AI settings and leaves all other development writes disabled',async()=>{
 const runtime={...config,AI_ENABLED:false,AI_ZONE_SELECTION_ENABLED:false,UNIVIEW_ENABLED:false,EVENTS_TOKEN:undefined,DASHBOARD_ORIGIN:'http://127.0.0.1:5173',DASHBOARD_PASSWORD:'p'.repeat(32),DASHBOARD_SESSION_KEY:'a'.repeat(64)},save=vi.fn(async()=>({enforcementAvailable:false}));
 const service=buildDevelopmentApp(runtime,{processingProposal:{read:async()=>({}),save},historicalImages:{load:async()=>null,save:async()=>false},checkReady:async()=>{},disconnect:async()=>{}});
 try{
  expect((await service.app.inject({method:'PUT',url:'/api/ai/processing',payload:value})).statusCode).toBe(401);
  const login=await service.app.inject({method:'POST',url:'/api/session',headers:{origin:runtime.DASHBOARD_ORIGIN},payload:{password:runtime.DASHBOARD_PASSWORD}}),cookie=login.headers['set-cookie'] as string;
  expect([401,403]).toContain((await service.app.inject({method:'PUT',url:'/api/ai/processing',headers:{cookie,origin:'https://wrong.example'},payload:value})).statusCode);
  expect((await service.app.inject({method:'PUT',url:'/api/ai/processing',headers:{cookie,origin:runtime.DASHBOARD_ORIGIN},payload:value})).statusCode).toBe(200);expect(save).toHaveBeenCalledOnce();
  expect(runtime.AI_ZONE_SELECTION_ENABLED).toBe(false);expect((await service.app.inject({method:'POST',url:'/api/events/00000000-0000-4000-8000-000000000001/enrich'})).statusCode).toBe(405);
 }finally{await service.app.close();}
});
