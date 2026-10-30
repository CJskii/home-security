import {afterAll,beforeAll,afterEach,expect,it,vi} from 'vitest';import{cleanup,render,screen,waitFor,fireEvent}from'@testing-library/react';import userEvent from'@testing-library/user-event';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{MemoryRouter,useSearchParams}from'react-router';import{ExploreFilters}from'./explore-filters';
vi.mock('./zone-filter',()=>({ZoneFilter:({value,onChange}:{value:string;onChange:(s:string)=>void})=><select aria-label="Geometric zone filter" value={value} onChange={e=>onChange(e.target.value)}><option value="all">All locations</option><option value="interested">Interested zones</option></select>,useZoneFilterOptions:()=>({options:[['interested','Interested zones']],cameras:{data:{cameras:[{id:'camera_1',name:'Driveway'}]}}})}));
const originals=new Map<string,PropertyDescriptor|undefined>();
beforeAll(()=>{for(const name of ['hasPointerCapture','setPointerCapture','releasePointerCapture','scrollIntoView']){originals.set(name,Object.getOwnPropertyDescriptor(Element.prototype,name));Object.defineProperty(Element.prototype,name,{configurable:true,value:name==='hasPointerCapture'?()=>false:()=>{}});}});
afterAll(()=>{for(const[name,value]of originals)if(value)Object.defineProperty(Element.prototype,name,value);else Reflect.deleteProperty(Element.prototype,name);});
afterEach(cleanup);
function View(){const[s,set]=useSearchParams();return <><output aria-label="query">{s.toString()}</output><ExploreFilters search={s} setSearch={set} camera={s.get('camera')??'all'} now={Date.parse('2026-10-25T12:00:00Z')}/></>;}
function mount(q=''){render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/explore?'+q]}><View/></MemoryRouter></QueryClientProvider>);}
it('keeps filters in the URL, gives named chips, clears time and resets selections',async()=>{
 mount('camera=camera_1&location=interested&aiOutcome=capacity&sort=oldest&event=old');
 expect(screen.getByRole('button',{name:'Clear Interested zones'})).toBeTruthy();expect(screen.getByRole('button',{name:'Clear Driveway'})).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Clear Last 24 hours'}));expect(screen.getByLabelText('query').textContent).toContain('time=all');expect(screen.getByLabelText('query').textContent).not.toContain('event=');
 await userEvent.click(screen.getByRole('combobox',{name:'Notification outcome filter'}));await userEvent.click(screen.getByRole('option',{name:'Webhook accepted'}));expect(screen.getByLabelText('query').textContent).toContain('notificationOutcome=accepted');expect(screen.getByLabelText('query').textContent).toContain('aiOutcome=capacity');
 await userEvent.click(screen.getByRole('button',{name:'Reset filters'}));expect(screen.getByLabelText('query').textContent).toBe('');
});
it('applies custom London bounds, displays both autumn occurrences and rejects the spring gap',async()=>{
 mount('time=custom&from=2026-10-24T12:00:00Z&to=2026-10-25T12:00:00Z');
 fireEvent.change(screen.getByLabelText('Start'),{target:{value:'2026-10-25T01:30'}});await userEvent.click(screen.getByRole('button',{name:'Apply range'}));expect(screen.getByRole('alert').textContent).toContain('occurs twice');
 await userEvent.click(screen.getByRole('combobox',{name:'Start DST occurrence'}));await userEvent.click(screen.getByRole('option',{name:/Later/}));await userEvent.click(screen.getByRole('button',{name:'Apply range'}));await waitFor(()=>expect(decodeURIComponent(screen.getByLabelText('query').textContent!)).toContain('from=2026-10-25T01:30:00.000Z'));
 fireEvent.change(screen.getByLabelText('Start'),{target:{value:'2026-03-29T01:30'}});await userEvent.click(screen.getByRole('button',{name:'Apply range'}));expect(screen.getByRole('alert').textContent).toContain('does not exist');
});
