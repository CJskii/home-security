export const timeOptions = [['hour','Last hour'],['day','Last 24 hours'],['week','Last 7 days'],['today','Today'],['yesterday','Yesterday'],['custom','Custom range'],['all','Any time']] as const;
export const aiOptions = [['all','All AI outcomes'],['completed','AI completed'],['excluded','AI intentionally excluded'],['capacity','AI skipped · capacity/resources'],['failed','AI failed / interrupted'],['pending','AI pending'],['other_skipped','AI skipped · other reason']] as const;
export const notificationOptions = [['all','All notifications'],['accepted','Webhook accepted'],['cooldown','Cooldown suppressed'],['excluded','Rule excluded'],['uncertain','Uncertain zone or delivery'],['failed','Delivery failed / cancelled'],['pending','Notification pending'],['held','Delivery held'],['not_evaluated','Not evaluated']] as const;
const london = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function londonInput(value:Date|string|number){const p=Object.fromEntries(london.formatToParts(new Date(value)).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
export function londonCandidates(value:string):number[]{
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return [];
 const [y,m,d,h,min]=value.split(/[-T:]/).map(Number),guess=Date.UTC(y!,m!-1,d!,h!,min!),offsets=new Set<number>();
 for(let hours=-36;hours<=36;hours+=6){const t=guess+hours*3600000,p=londonInput(t).split(/[-T:]/).map(Number);offsets.add(Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!)-t);}
 return [...offsets].map(o=>guess-o).filter(t=>londonInput(t)===value).sort((a,b)=>a-b);
}
export function londonInstant(value:string,fold?:string){const candidates=londonCandidates(value);if(!candidates.length)throw Error('This London date/time does not exist. Check the date and daylight-saving change.');if(candidates.length>1&&!['earlier','later'].includes(fold??''))throw Error('This time occurs twice. Choose the earlier or later occurrence.');return candidates[fold==='later'?candidates.length-1:0]!;}
export function timePreset(search:URLSearchParams){const value=search.get('time');if(timeOptions.some(([v])=>v===value))return value!;return search.get('days')==='7'?'week':search.get('days')==='30'?'legacy30':'day';}
const validDate=(s:string|null)=>s!==null&&Number.isFinite(Date.parse(s))?Date.parse(s):undefined;
export function exploreRange(search:URLSearchParams,now:number):{after?:string;before?:string;label:string;error?:string}{
 const preset=timePreset(search),anchor=validDate(search.get('at'))??now;let start:number,end=anchor;
 if(preset==='all')return{label:'Any time'};
 if(preset==='custom'){const from=validDate(search.get('from')),to=validDate(search.get('to'));if(from===undefined||to===undefined||from>to)return{label:'Custom range',error:'Choose a valid start and end time.'};start=from;end=to;}
 else if(preset==='today'||preset==='yesterday'){
  const local=londonInput(anchor).slice(0,10),midnight=londonInstant(local+'T00:00');
  if(preset==='today')start=midnight;
  else{const [y,m,d]=local.split('-').map(Number);const previous=new Date(Date.UTC(y!,m!-1,d!-1)).toISOString().slice(0,10);start=londonInstant(previous+'T00:00');end=midnight-1;}
 }else start=anchor-({hour:3600000,day:86400000,week:7*86400000,legacy30:30*86400000}[preset]??86400000);
 const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
 return{after:new Date(start).toISOString(),before:new Date(end).toISOString(),label:`${fmt.format(start)} – ${fmt.format(end)}`};
}
export function exploreParams(search:URLSearchParams,camera:string,now:number){const range=exploreRange(search,now),q=new URLSearchParams();if(range.after)q.set('occurredAfter',range.after);if(range.before)q.set('occurredBefore',range.before);if(camera!=='all')q.set('camera',camera);
 for(const key of ['category','vehicleGroup','aiOutcome','notificationOutcome']){const value=search.get(key);if(value&&value!=='all')q.set(key,value);}
 if(search.get('sort')==='oldest')q.set('sort','oldest');
 const zone=search.get('location')??'all';if(zone==='interested')q.set('interestedZonesOnly','true');else if(zone==='other')q.set('zoneInterest','other');else if(['uncertain','unmatched','ambiguous','unknown'].includes(zone))q.set('locationStatus',zone);else if(zone!=='all')q.set('locationZoneId',zone);
 return q;
}
