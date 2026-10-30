import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openZoneHistory,activityText,activityCard,activityTime,relativeZoneTime,eventDashboardUrl,type HistoryHass} from './ha-zone-dialog';
const zone='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event('close'));}});

});
afterEach(()=>{document.querySelector<HTMLDialogElement>('.hs-zone-history')?.close();document.body.replaceChildren();vi.unstubAllGlobals();vi.useRealTimers();});
function fixture(count=1){const items=Array.from({length:count},(_,i)=>({eventId:'10000000-0000-4000-8000-'+String(i).padStart(12,'0'),category:'Person',camera:'Driveway',zone:'My Driveway',time:'22 Oct, 11:00 BST',description:'Person detected',notification:'Webhook accepted',thumbnail:('http://lan/api/notification-media/crop-'+i) as string|null,fullFrame:('http://lan/api/notification-media/frame-'+i) as string|null}));const page={zone:{name:'My Driveway'},until:'2026-10-22T10:00:00Z',from:'2026-10-15T10:00:00Z',nextCursor:null as string|null,items};const call=vi.fn(async()=>({service_response:{status:200,content:page}}));const hass:HistoryHass={states:{'sensor.home_security_history':{attributes:{dashboardUrl:'https://192.168.50.10:5173/explore',zoneActivity:[{channel:1,slot:0,zoneId:zone,name:'My Driveway'}]}}},callApi:call as HistoryHass['callApi']};return {hass,call,page};}
it('opens a native in-HA seven-day dialog using only the configured server-side read action',async()=>{
 const {hass,call}=fixture();await openZoneHistory(hass,1,0);const d=document.querySelector<HTMLDialogElement>('.hs-zone-history')!;expect(d.open).toBe(true);expect(d.textContent).toContain('Person · My Driveway');expect(d.textContent).not.toContain('Webhook accepted');expect(call).toHaveBeenCalledWith('POST','services/rest_command/home_security_zone_history?return_response',{zone_id:zone,until:'',cursor:''});expect(d.querySelectorAll('a')).toHaveLength(1);expect(d.querySelector('button')?.textContent).toBe('Close');
});
it('is safe against double clicks and leaves no modal when closed',async()=>{const {hass,call}=fixture();await Promise.all([openZoneHistory(hass,1,0),openZoneHistory(hass,1,0)]);expect(call).toHaveBeenCalledTimes(1);expect(document.querySelectorAll('.hs-zone-history')).toHaveLength(1);document.querySelector<HTMLDialogElement>('.hs-zone-history')!.close();expect(document.querySelector('.hs-zone-history')).toBeNull();});
it('escapes server/model text by using textContent, and keeps AI state out of the activity text',async()=>{const {hass,page}=fixture();page.items[0]!.description='<img src=x onerror=alert(1)>';await openZoneHistory(hass,1,0);expect(document.querySelector('.hs-description')!.textContent).toBe('<img src=x onerror=alert(1)>');expect(document.querySelector('.hs-description img')).toBeNull();});
it('never creates media elements or observers for history, even when all records contain signed image references',async()=>{
 const {hass}=fixture(24);const observer=vi.fn();vi.stubGlobal('IntersectionObserver',observer);await openZoneHistory(hass,1,0);
 expect(document.querySelectorAll('.hs-event')).toHaveLength(24);expect(document.querySelectorAll('.hs-zone-history img,.hs-zone-history video,.hs-zone-history [data-source]')).toHaveLength(0);expect(observer).not.toHaveBeenCalled();
});
it('uses the configured dashboard origin and exact canonical event ID with a safe new-tab link',async()=>{
 const {hass,page}=fixture();await openZoneHistory(hass,1,0);const row=document.querySelector<HTMLAnchorElement>('a.hs-event')!;
 expect(row.href).toBe('https://192.168.50.10:5173/explore?event='+page.items[0]!.eventId);expect(row.target).toBe('_blank');expect(row.rel).toBe('noopener noreferrer');expect(document.querySelector('.hs-zone-frame')).toBeNull();
});
it('paginates the full cohort using a fixed seven-day window rather than filtering the loaded page',async()=>{const {hass,call,page}=fixture();page.nextCursor='next';await openZoneHistory(hass,1,0);const older=[...document.querySelectorAll('button')].find(b=>b.textContent==='Older')!;older.click();await vi.waitFor(()=>expect(call).toHaveBeenCalledTimes(2));expect(call).toHaveBeenLastCalledWith('POST',expect.any(String),{zone_id:zone,until:page.until,cursor:'next'});});
it('shows a useful failure and can retry without creating a notification or navigating away',async()=>{const {hass,call}=fixture();call.mockRejectedValueOnce(new Error('offline'));await openZoneHistory(hass,1,0);expect(document.body.textContent).toContain('Zone history is unavailable');const retry=[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry')!;retry.click();await vi.waitFor(()=>expect(document.querySelectorAll('.hs-event')).toHaveLength(1));expect(call).toHaveBeenCalledTimes(2);});
it('renders an honest empty history and missing media without fabricating source images',async()=>{const {hass,page}=fixture(0);await openZoneHistory(hass,1,0);expect(document.body.textContent).toContain('No verified detections');expect(document.querySelectorAll('img')).toHaveLength(0);expect(page.items).toHaveLength(0);});

it('keeps links functional when original media references are missing',async()=>{
 const {hass,page}=fixture();page.items[0]!.thumbnail=null;page.items[0]!.fullFrame=null;await openZoneHistory(hass,1,0);expect(document.querySelectorAll('img')).toHaveLength(0);expect(document.querySelector<HTMLAnchorElement>('a.hs-event')!.href).toContain(page.items[0]!.eventId);
});

it('opens an individual event in HA, with canonical full frame and outcomes, without loading history or navigating',async()=>{
 const {openEventDetails}=await import('./ha-zone-dialog');const {hass,page,call}=fixture();call.mockResolvedValue({service_response:{status:200,content:page.items[0]!}} as unknown as Awaited<ReturnType<typeof call>>);
 await openEventDetails(hass,'10000000-0000-4000-8000-000000000000');expect(call).toHaveBeenCalledWith('POST','services/rest_command/home_security_event?return_response',{event_id:'10000000-0000-4000-8000-000000000000'});const d=document.querySelector<HTMLDialogElement>('.hs-zone-event')!;expect(d.open).toBe(true);expect(d.querySelector('img')!.src).toBe(page.items[0]!.fullFrame);expect(d.textContent).toContain('Webhook accepted');expect(d.querySelectorAll('a')).toHaveLength(0);d.close();expect(document.querySelector('.hs-zone-event')).toBeNull();
});
it('does not show the wrong event or a late reply after an individual dialog closes',async()=>{
 const {openEventDetails}=await import('./ha-zone-dialog');const {hass,page,call}=fixture();call.mockResolvedValue({service_response:{status:200,content:{...page.items[0],eventId:'wrong'}}} as unknown as Awaited<ReturnType<typeof call>>);await openEventDetails(hass,'10000000-0000-4000-8000-000000000000');expect(document.querySelector('.hs-zone-event img')).toBeNull();document.querySelector<HTMLDialogElement>('.hs-zone-event')!.close();
 let finish!:(v:unknown)=>void;hass.callApi=vi.fn(()=>new Promise(resolve=>{finish=resolve})) as HistoryHass['callApi'];const pending=openEventDetails(hass,'10000000-0000-4000-8000-000000000000');document.querySelector<HTMLDialogElement>('.hs-zone-event')!.close();finish({service_response:{status:200,content:page.items[0]}});await pending;expect(document.querySelector('.hs-zone-event')).toBeNull();
});

it('uses one descriptive headline, hides delivery diagnostics in activity rows and avoids visible image alt text',async()=>{
 const {hass,page}=fixture();page.items[0]!.description='A person appears to be walking.';await openZoneHistory(hass,1,0);
 const row=document.querySelector('.hs-event')!;expect(row.querySelector('.hs-title')!.textContent).toBe('Person · My Driveway');expect(row.querySelector('.hs-description')!.textContent).toBe('Appears to be walking.');expect(row.querySelector('.hs-time')!.textContent).not.toContain('Driveway');expect(row.textContent).not.toContain('Webhook accepted');expect(row.querySelector('img')).toBeNull();expect(document.querySelector('.hs-zone-frame')).toBeNull();
});

it('keeps accepted uncertainty and avoids inventing actions, locations or identities',()=>{
 expect(activityText('Person','My Driveway','A person appears to be walking.')).toEqual({headline:'Someone appears to be walking in your driveway',context:''});
 expect(activityText('Person','Boundary uncertain','A person appears to be walking.')).toEqual({headline:'Someone appears to be walking.',context:'Boundary uncertain'});
 expect(activityText('Person','My Driveway','A person in a jacket is standing with a backpack.')).toEqual({headline:'Someone in a jacket is standing with a backpack.',context:'My Driveway'});
 expect(activityText('Vehicle','Road','Vehicle detected')).toEqual({headline:'Vehicle detected',context:'Road'});
 expect(activityText('Person','My Walkway','Person detected').headline).toBe('Someone detected on your walkway');
});
it('formats UK days and daylight saving transitions using actual timestamps',()=>{
 expect(activityTime('2026-10-22T15:01:10Z',new Date('2026-10-22T17:00:00Z'))).toBe('16:01');
 expect(activityTime('2026-10-21T15:01:10Z',new Date('2026-10-22T17:00:00Z'))).toBe('Yesterday, 16:01');
 expect(activityTime('2026-10-25T00:30:00Z',new Date('2026-10-25T10:00:00Z'))).toBe('01:30');
 expect(activityTime('2026-10-25T01:30:00Z',new Date('2026-10-25T10:00:00Z'))).toBe('01:30');
 expect(activityTime('22 Oct, 16:01:10 BST')).toBe('22 Oct, 16:01');
});

it('keeps category and zone in the title, the accepted detail below and no generic duplicate',()=>{
 expect(activityCard('Person','My Driveway','A person appears to be walking.')).toEqual({title:'Person · My Driveway',description:'Appears to be walking.',icon:'mdi:account'});
 expect(activityCard('Person','My Walkway','Person detected').description).toBe('Detection recorded');
 expect(activityCard('Person','My Walkway','A person in a jacket is standing.').description).toBe('A person in a jacket is standing.');
 expect(activityCard('Vehicle','Road','A white car is visible.')).toEqual({title:'Vehicle · Road',description:'A white car is visible.',icon:'mdi:car'});
});

it('always supplies a truthful description line without inventing skipped AI details',()=>{
 expect(activityCard('Person','My Driveway','').description).toBe('Detection recorded');
 expect(activityCard('Person','My Walkway','Person detected').description).toBe('Detection recorded');
 expect(activityCard('Vehicle','Road','Vehicle detected').description).toBe('Detection recorded');
 expect(activityCard('Person','My Driveway','A person appears to be walking.').description).toBe('Appears to be walking.');
});


it('uses relative time today and a local clock for previous days, with DST-safe day boundaries',()=>{
 const now=new Date('2026-10-22T17:00:00Z');
 expect(relativeZoneTime('2026-10-22T16:59:45Z',now)).toBe('Just now');
 expect(relativeZoneTime('2026-10-22T16:40:00Z',now)).toBe('20 minutes ago');
 expect(relativeZoneTime('2026-10-22T14:00:00Z',now)).toBe('3 hours ago');
 expect(relativeZoneTime('2026-10-22T16:59:00Z',now)).toBe('1 minute ago');
 expect(relativeZoneTime('2026-10-22T16:00:00Z',now)).toBe('1 hour ago');
 expect(relativeZoneTime('2026-10-21T17:40:00Z',now)).toBe('Yesterday, 18:40');
 expect(relativeZoneTime('2026-10-20T17:40:00Z',now)).toBe('20 Oct, 18:40');
 expect(relativeZoneTime('2026-10-24T22:30:00Z',new Date('2026-10-25T10:00:00Z'))).toBe('Yesterday, 23:30');
 expect(relativeZoneTime('2026-10-25T00:30:00Z',new Date('2026-10-25T02:30:00Z'))).toBe('2 hours ago');
 expect(relativeZoneTime('invalid',now)).toBe('No verified activity');
 expect(relativeZoneTime('2026-10-22T17:05:00Z',now)).toBe('Time uncertain');
});


it('rejects unsafe dashboard schemes, embedded credentials and malformed event IDs',()=>{
 const {hass,page}=fixture();const id=page.items[0]!.eventId;
 for(const dashboardUrl of ['javascript:alert(1)','https://user:password@dashboard.example/explore','not a URL']){hass.states['sensor.home_security_history']!.attributes.dashboardUrl=dashboardUrl;expect(eventDashboardUrl(hass,id)).toBeNull();}
 hass.states['sensor.home_security_history']!.attributes.dashboardUrl='https://dashboard.example/explore?unrelated=1#old';
 expect(eventDashboardUrl(hass,'../../event')).toBeNull();expect(eventDashboardUrl(hass,id)).toBe('https://dashboard.example/explore?event='+id);
});
it('does not render a late history response after the dialog closes',async()=>{
 const {hass,page}=fixture();let finish!:(v:unknown)=>void;hass.callApi=vi.fn(()=>new Promise(resolve=>{finish=resolve})) as HistoryHass['callApi'];const pending=openZoneHistory(hass,1,0);document.querySelector<HTMLDialogElement>('.hs-zone-history')!.close();finish({service_response:{status:200,content:page}});await pending;expect(document.querySelector('.hs-zone-history')).toBeNull();expect(document.querySelectorAll('img')).toHaveLength(0);
});
