// Compiled into the existing button-card JavaScript action, not a new HA resource.
export interface HistoryHass {
  states: Record<string, { attributes: { dashboardUrl?:string; zoneActivity?: {channel:number;slot:number;zoneId:string;name:string}[] } }>;
  callApi<T>(method:string,path:string,data:Record<string,string>):Promise<T>;
}
interface HistoryItem {eventId:string;category:string;camera:string;zone:string;time:string;timestamp?:string;description:string;notification:string;thumbnail:string|null;fullFrame:string|null}
interface HistoryPage {zone:{name:string};from:string;until:string;nextCursor:string|null;items:HistoryItem[]}

// Presentation only: accepted text is never used to infer actions or identities.
export function activityText(category:string,zone:string,description:string){
  const generic=/^(?:(?:a|an|the) )?(?:person|vehicle|motor vehicle|non.motor vehicle|object)(?: is| appears to be)? (?:visible|present|detected)(?: in (?:the )?(?:image|scene|zone))?[.!]?$/i;
  const clean=description.trim();
  const subject=category==='Person'?'Someone':category||'Detection';
  const useful=clean&&!generic.test(clean);
  let headline=useful?clean.replace(/^(?:A|The) person\b/,'Someone'):subject+' detected';
  const place=zone==='My Driveway'?'in your driveway':zone==='My Walkway'?'on your walkway':null;
  // Only these simple accepted action sentences receive a verified location suffix.
  const simple=/^Someone(?: appears to be| is)? (?:walking|standing|running|sitting)[.!]?$/;
  if(place&&(!useful||simple.test(headline)))headline=headline.replace(/[.!]$/,'')+' '+place;
  const context=place&&headline.endsWith(place)?'':zone;
  return {headline,context};
}
export function activityCard(category:string,zone:string,description:string){
  const clean=description.trim();
  const generic=/^(?:(?:a|an|the) )?(?:person|vehicle|motor vehicle|non.motor vehicle|object)(?: is| appears to be)? (?:visible|present|detected)(?: in (?:the )?(?:image|scene|zone))?[.!]?$/i;
  let detail=generic.test(clean)||!clean?'Detection recorded':clean;
  if(category==='Person')detail=detail.replace(/^(?:(?:A|The) person|Someone) is\s+/,'').replace(/^(?:(?:A|The) person|Someone)\s+(?=(?:appears|seems|has|wears|wearing)\b)/,'');
  if(detail)detail=detail.charAt(0).toUpperCase()+detail.slice(1);
  return {title:[category||'Detection',zone].filter(Boolean).join(' · '),description:detail,icon:category==='Person'?'mdi:account':category.toLowerCase().includes('vehicle')?'mdi:car':'mdi:cctv'};
}
export function notificationLabel(value:string){
  return ({'Awaiting source geometry':'Checking detection','Delivery held':'Not sent','Unknown zone excluded':'Zone not confirmed','Boundary excluded':'Boundary not confirmed','Acceptance uncertain':'Delivery unconfirmed'} as Record<string,string>)[value]??value;
}
export function activityTime(value:string,now=new Date()){
  const date=/^\d{4}-\d{2}-\d{2}T/.test(value)?new Date(value):new Date(NaN);
  if(!Number.isFinite(+date))return value.replace(/:(\d{2})(?= (?:BST|GMT)$)/,'').replace(/ (?:BST|GMT)$/,'');
  const day=(d:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  const [y,m,d]=day(now).split('-').map(Number);
  const yesterday=new Date(Date.UTC(y!,m!-1,d!-1,12));
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'}).format(date);
  return day(date)===day(now)?time:day(date)===day(yesterday)?'Yesterday, '+time:new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',...(date.getUTCFullYear()!==now.getUTCFullYear()?{year:'numeric'}:{})}).format(date)+', '+time;
}
export function relativeZoneTime(value:string,now=new Date()){
  const at=new Date(value);
  if(!Number.isFinite(+at))return 'No verified activity';
  const elapsed=+now-+at;
  if(elapsed < -60000)return 'Time uncertain';
  const day=(d:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  if(day(at)!==day(now))return activityTime(value,now);
  if(elapsed<60000)return 'Just now';
  const minutes=Math.floor(elapsed/60000),hours=Math.floor(minutes/60);
  return minutes<60?`${minutes} minute${minutes===1?'':'s'} ago`:`${hours} hour${hours===1?'':'s'} ago`;
}

export function eventDashboardUrl(hass:HistoryHass,eventId:string):string|null{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(eventId))return null;
  const configured=hass.states['sensor.home_security_history']?.attributes.dashboardUrl;
  if(!configured)return null;
  try{const url=new URL(configured);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    url.pathname='/explore';url.search='';url.hash='';url.searchParams.set('event',eventId);return url.href;
  }catch{return null;}
}

function eventDetails(item:HistoryItem){
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Delivery & event details';details.append(summary);
  for(const value of [item.notification,item.time,'Event '+item.eventId]){const p=document.createElement('p');p.textContent=value;details.append(p);}return details;
}

const dialogCss=`
    .hs-zone-history,.hs-zone-frame{color:var(--primary-text-color,#e1e1e1);background:var(--card-background-color,#1c1c1c);border:1px solid var(--divider-color,#444);border-radius:12px;padding:0;width:min(860px,calc(100vw - 28px));max-width:calc(100vw - 28px);max-height:88dvh;box-sizing:border-box;font:14px Roboto,Noto,sans-serif}
    .hs-zone-history::backdrop,.hs-zone-frame::backdrop{background:#0009}
    .hs-zone-history header,.hs-zone-frame header{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--divider-color,#444)}
    .hs-zone-history h2,.hs-zone-frame h2{margin:0;font-size:20px;font-weight:500;flex:1}
    .hs-zone-history button,.hs-zone-frame button{font:inherit;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--divider-color,#444);border-radius:8px;padding:8px 12px}
    .hs-zone-history button:focus-visible,.hs-zone-frame button:focus-visible{outline:2px solid var(--primary-color,#03a9f4)}
    .hs-zone-history button:disabled{opacity:.4;cursor:default}
    .hs-zone-history .hs-caption{padding:12px 18px;color:var(--secondary-text-color,#9b9b9b);line-height:20px}
    .hs-zone-history .hs-list{overflow:auto;max-height:calc(88dvh - 180px);padding:0 12px;min-height:120px}
    .hs-zone-history .hs-event{display:grid;grid-template-columns:minmax(0,1fr) 18px;gap:12px;width:100%;padding:10px 6px;align-items:start;min-height:88px;box-sizing:border-box;border:none;border-bottom:1px solid var(--divider-color,#444);border-radius:0;text-align:left;color:inherit;text-decoration:none}.hs-zone-history .hs-event:hover{background:var(--secondary-background-color,#262626)}.hs-zone-history .hs-event:focus-visible{outline:2px solid var(--primary-color,#03a9f4);outline-offset:-2px}.hs-zone-history .hs-event-link{--mdc-icon-size:16px;align-self:center;color:var(--secondary-text-color,#9b9b9b)}
    .hs-zone-history .hs-copy{min-width:0;display:flex;flex-direction:column;gap:4px;line-height:20px}.hs-zone-history .hs-copy>*{flex-shrink:0}
    .hs-zone-history .hs-title{font-size:15px;line-height:22px;min-height:22px;font-weight:500;display:flex;align-items:center;gap:7px}.hs-zone-history .hs-title ha-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin:0;--mdc-icon-size:18px;color:var(--teal-color,#009688);flex-shrink:0}.hs-zone-history .hs-description{font-size:14px;line-height:20px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .hs-zone-history .hs-time,.hs-zone-history .hs-outcome{color:var(--secondary-text-color,#9b9b9b);font-size:13px}
    .hs-zone-history footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-top:1px solid var(--divider-color,#444)}
    .hs-zone-frame details{padding:12px 18px;color:var(--secondary-text-color,#9b9b9b)}.hs-zone-frame summary{cursor:pointer}.hs-zone-frame{width:min(1100px,calc(100vw - 28px))}.hs-zone-frame img{display:block;max-width:100%;max-height:65dvh;object-fit:contain;margin:auto}.hs-zone-frame p{padding:0 18px;line-height:20px}
    @media(max-width:600px){.hs-zone-history,.hs-zone-frame{width:calc(100vw - 16px);max-width:calc(100vw - 16px);max-height:92dvh}.hs-zone-history header{padding:14px}.hs-zone-history h2,.hs-zone-frame h2{font-size:18px}.hs-zone-history .hs-list{max-height:calc(92dvh - 210px)}.hs-zone-history .hs-caption{padding:10px 14px}}
  `;

export async function openZoneHistory(hass:HistoryHass,channel:number,slot:number):Promise<void> {
  const zone=hass.states['sensor.home_security_history']?.attributes.zoneActivity?.find(z=>z.channel===channel&&z.slot===slot);
  if(!zone)return;
  const existing=document.querySelector<HTMLDialogElement>('dialog.hs-zone-history');if(existing?.open){existing.focus();return;}
  const dialog=document.createElement('dialog');dialog.className='hs-zone-history';dialog.setAttribute('aria-label',zone.name+' activity history');
  // Native modal top-layer/focus handling; scoped rules cannot style other HA views.
  const style=document.createElement('style');style.textContent=dialogCss;
  dialog.append(style);
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const element=document.createElement(tag);if(text)element.textContent=text;return element;};
  const header=make('header'),title=make('h2',zone.name),close=make('button','Close');close.setAttribute('aria-label','Close zone history');close.onclick=()=>dialog.close();header.append(title,close);dialog.append(header);
  const caption=make('div','Activity during the last 7 days · select an event to open Home Security');caption.className='hs-caption';dialog.append(caption);
  const list=make('div');list.className='hs-list';list.setAttribute('aria-live','polite');dialog.append(list);
  const footer=make('footer'),previous=make('button','Newer'),count=make('span'),next=make('button','Older');footer.append(previous,count,next);dialog.append(footer);
  let until='',page=0,loading=false;const cursors:(string|null)[]=[null];let nextCursor:string|null=null;
  let disposed=false;
  const load=async()=>{
    if(loading||disposed)return;loading=true;list.replaceChildren(make('p','Loading zone history…'));previous.disabled=true;next.disabled=true;count.textContent='';
    try{
      const response=await hass.callApi<{service_response:{status:number;content:HistoryPage}}>('POST','services/rest_command/home_security_zone_history?return_response',{zone_id:zone.zoneId,until,cursor:cursors[page]??''});
      if(disposed)return;const reply=response.service_response;
      if(reply?.status===400){until='';page=0;cursors.splice(1);}
      if(reply?.status!==200||!Array.isArray(reply.content?.items)||reply.content.items.length>24)throw Error('History unavailable');
      const data=reply.content;until=data.until;nextCursor=data.nextCursor;title.textContent=data.zone.name;list.replaceChildren();list.scrollTop=0;
      if(!data.items.length)list.append(make('p','No verified detections in this zone during the last seven days.'));
      for(const item of data.items){const link=eventDashboardUrl(hass,item.eventId);if(!link)throw Error('Dashboard link unavailable');const row=make('a');row.className='hs-event';row.setAttribute('aria-label','Open '+item.category+' in '+item.zone+' at '+item.time+' in Home Security');row.href=link;row.target='_blank';row.rel='noopener noreferrer';
        const copy=make('span');copy.className='hs-copy';
        const display=activityCard(item.category,item.zone,item.description);const title=make('span');title.className='hs-title';const icon=document.createElement('ha-icon');icon.setAttribute('icon',display.icon);title.append(icon,make('span',display.title));copy.append(title);for(const [className,text]of [['hs-time',activityTime(item.timestamp??item.time)],['hs-description',display.description]] as const){if(!text)continue;const line=make('span',text);line.className=className;copy.append(line);}const arrow=document.createElement('ha-icon');arrow.className='hs-event-link';arrow.setAttribute('icon','mdi:open-in-new');arrow.setAttribute('aria-hidden','true');row.append(copy,arrow);list.append(row);}
      count.textContent='Page '+(page+1);previous.disabled=page===0;next.disabled=!nextCursor;
    }catch{if(!disposed){list.replaceChildren(make('p','Zone history is unavailable. Please retry.'));const retry=make('button','Retry');retry.onclick=()=>{void load();};list.append(retry);}}
    finally{loading=false;}
  };
  previous.onclick=()=>{if(page>0&&!loading){page--;void load();}};next.onclick=()=>{if(nextCursor&&!loading){cursors[++page]=nextCursor;void load();}};
  dialog.addEventListener('close',()=>{disposed=true;dialog.remove();},{once:true});
  document.body.append(dialog);dialog.showModal();await load();
}

// Individual activity/ledger rows use the same native in-HA image presentation.
export async function openEventDetails(hass:HistoryHass,eventId:string):Promise<void>{
  const existing=document.querySelector<HTMLDialogElement>('dialog.hs-zone-event');
  if(existing?.open){existing.focus();return;}
  const view=document.createElement('dialog');view.className='hs-zone-frame hs-zone-event';view.setAttribute('aria-label','Detection details');
  const style=document.createElement('style');style.textContent=dialogCss;view.append(style);
  const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button');title.textContent='Detection';close.textContent='Close';close.setAttribute('aria-label','Close event details');close.onclick=()=>view.close();header.append(title,close);view.append(header);
  const body=document.createElement('div');view.append(body);let disposed=false;
  const text=(value:string)=>{const p=document.createElement('p');p.textContent=value;return p;};
  const load=async()=>{body.replaceChildren(text('Loading detection…'));try{
    const r=await hass.callApi<{service_response:{status:number;content:HistoryItem}}>('POST','services/rest_command/home_security_event?return_response',{event_id:eventId});if(disposed)return;
    if(r.service_response?.status!==200||r.service_response.content?.eventId!==eventId)throw Error('Event unavailable');
    const item=r.service_response.content;const display=activityCard(item.category,item.zone,item.description);title.textContent=display.title;body.replaceChildren(text(activityTime(item.timestamp??item.time)));if(display.description)body.append(text(display.description));
    if(item.fullFrame){const img=document.createElement('img');img.alt='Original NVR full-frame image';let retries=0;img.onerror=()=>{if(retries++<2)setTimeout(()=>{if(!disposed&&img.isConnected)img.src=item.fullFrame!;},600);else img.replaceWith(text('Original full frame unavailable. The detection record remains available.'));};img.src=item.fullFrame;body.append(img);}else body.append(text('No original full-frame reference is available.'));
    body.append(eventDetails(item));
  }catch{if(!disposed){body.replaceChildren(text('Detection unavailable. Please retry.'));const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>{void load();};body.append(retry);}}};
  view.addEventListener('close',()=>{disposed=true;for(const image of view.querySelectorAll('img'))image.removeAttribute('src');view.remove();},{once:true});
  document.body.append(view);view.showModal();await load();
}
