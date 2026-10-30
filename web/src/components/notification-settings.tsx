import {NotificationDelivery} from './notification-delivery';
import { NotificationHistory } from './notification-history';
import { useState } from 'react';
import { useQuery,useMutation,useQueryClient } from '@tanstack/react-query';
import { api,ApiError,sessionEvents,formatTime,display } from '@/lib/api';
import { settingsSchema,previewSchema,type NotificationConfiguration,type NotificationRule } from '@/lib/notifications';
import { Card,CardHeader,CardTitle,CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from './ui/select';
const categories=['PERSON','MOTOR_VEHICLE','NON_MOTOR_VEHICLE'] as const;
async function send(path:string,method:string,body:unknown){
 const response=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 if(!response.ok){if(response.status===401)sessionEvents.dispatchEvent(new Event('ended'));throw new ApiError(response.status);}
 return response.json() as Promise<unknown>;
}
export function NotificationSettings(){
 const client=useQueryClient(),query=useQuery({queryKey:['notification-settings'],queryFn:({signal})=>api('/api/notifications/settings',settingsSchema,signal)});
 const [draft,setDraft]=useState<NotificationConfiguration|null>(null),[hours,setHours]=useState('1');
 const data=query.data,value=draft??data?.configuration;
 const preview=useMutation({mutationFn:async(evaluationId?:string)=>{if(evaluationId)return api('/api/notifications/evaluations/'+encodeURIComponent(evaluationId),previewSchema);const to=new Date(),from=new Date(to.getTime()-Number(hours)*3600000);return previewSchema.parse(await send('/api/notifications/preview','POST',{from:from.toISOString(),to:to.toISOString()}));}});
 const archive=useMutation({mutationFn:async()=>{const p=preview.data;if(!p)throw Error('Preview required');return send('/api/notifications/evaluations','POST',{...p.window,expectedRevision:p.revision,fingerprint:p.fingerprint});},onSuccess:()=>{void client.invalidateQueries({queryKey:['notification-settings']});}});
 const save=useMutation({mutationFn:async()=>settingsSchema.parse(await send('/api/notifications/settings','PUT',{expectedRevision:data?.revision,configuration:value})),onSuccess:next=>{client.setQueryData(['notification-settings'],next);void client.invalidateQueries({queryKey:['notification-delivery']});setDraft(null);preview.reset();archive.reset();}});
 const change=(next:NotificationConfiguration)=>{setDraft(next);save.reset();preview.reset();archive.reset();};
 const update=(id:string,next:Partial<NotificationRule>)=>{if(value)change({...value,rules:value.rules.map(r=>r.id===id?{...r,...next}:r)});};
 const busy=save.isPending||preview.isPending||archive.isPending;
 return <Card><CardHeader><CardTitle><h2>Notifications</h2></CardTitle></CardHeader><CardContent className="space-y-4 text-xs">
  <p role="status" className="rounded border border-amber-400/30 p-3 text-amber-200">Automatic delivery requires the global preference, an operator-armed producer with a start cutoff, and the separate delivery worker. Saving rules cannot start or arm them. Turning the global preference OFF stops new sends; a request already in flight cannot be recalled. The separate confirmed TEST action contacts the saved webhook. Rules use NVR categories and geometry independently of AI.</p>
  {query.isPending&&<p>Loading notification settings…</p>}
  {query.isError&&<p role="alert">Notification settings unavailable. A compatible API is required. <Button size="sm" variant="outline" onClick={()=>{void query.refetch();}}>Retry notifications</Button></p>}
  {data&&value&&<>
   {!data.available&&<p role="status">Notification migration required. Existing source events are unaffected.</p>}
   {!data.writable&&data.available&&<p role="status">Read-only settings. Use the compatible authenticated API to save changes.</p>}
   <form onSubmit={e=>{e.preventDefault();save.mutate();}} className="space-y-4">
    <fieldset disabled={!data.available||!data.writable||busy} className="space-y-4 disabled:opacity-60">
     <div className="flex items-center gap-2"><Input id="notification-global" type="checkbox" className="size-4" checked={value.deliveryEnabled} onChange={e=>change({...value,deliveryEnabled:e.target.checked})}/><Label htmlFor="notification-global">Global delivery preference (default off; sender unavailable)</Label></div>
     {value.rules.map((rule,index)=><section key={rule.id} aria-label={`Notification rule ${index+1}`} className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-3"><Label htmlFor={`notification-name-${rule.id}`}>Rule name</Label><Input id={`notification-name-${rule.id}`} className="max-w-xs" value={rule.name} required maxLength={80} onChange={e=>update(rule.id,{name:e.target.value})}/><Label className="flex items-center gap-2"><Input type="checkbox" className="size-4" checked={rule.enabled} onChange={e=>update(rule.id,{enabled:e.target.checked})}/>Rule enabled</Label><Button type="button" size="sm" variant="ghost" onClick={()=>change({...value,rules:value.rules.filter(r=>r.id!==rule.id)})}>Remove rule</Button></div>
      <div className="grid gap-3 md:grid-cols-2">
       <fieldset className="space-y-2"><legend className="mb-2 font-medium">Cameras and named zones</legend>{data.cameras.map(camera=><div key={camera.channel} className="space-y-2"><Label className="flex items-center gap-2"><Input type="checkbox" className="size-4" checked={rule.channels.includes(camera.channel)} onChange={e=>update(rule.id,{channels:e.target.checked?[...rule.channels,camera.channel]:rule.channels.filter(c=>c!==camera.channel),zoneIds:e.target.checked?rule.zoneIds:rule.zoneIds.filter(id=>!data.zones.some(z=>z.id===id&&z.channel===camera.channel))})}/>Camera {camera.channel} · {camera.name}</Label><div className="ml-5 flex flex-wrap gap-3">{data.zones.filter(z=>z.channel===camera.channel).map(zone=><Label key={zone.id} className="flex items-center gap-2"><Input type="checkbox" className="size-4" disabled={!rule.channels.includes(camera.channel)} checked={rule.zoneIds.includes(zone.id)} onChange={e=>update(rule.id,{zoneIds:e.target.checked?[...rule.zoneIds,zone.id]:rule.zoneIds.filter(id=>id!==zone.id)})}/>{zone.name} · slot {zone.slot}</Label>)}</div></div>)}</fieldset>
       <div className="space-y-3"><fieldset><legend className="mb-2 font-medium">Authoritative NVR categories</legend><div className="flex flex-wrap gap-3">{categories.map(category=><Label key={category} className="flex items-center gap-2"><Input type="checkbox" className="size-4" checked={rule.categories.includes(category)} onChange={e=>update(rule.id,{categories:e.target.checked?[...rule.categories,category]:rule.categories.filter(c=>c!==category)})}/>{display(category)}</Label>)}</div></fieldset>
        <Label className="flex items-center gap-3">Cooldown (seconds)<Input type="number" className="w-28" min={0} max={86400} step={1} required value={rule.cooldownSeconds} onChange={e=>update(rule.id,{cooldownSeconds:Number(e.target.value)})}/></Label>
        {(['ambiguous','unknown'] as const).map(key=><div key={key} className="flex items-center gap-3"><Label htmlFor={`${key}-${rule.id}`}>{key==='ambiguous'?'Ambiguous / overlapping geometry':'Unknown / missing geometry'}</Label><Select value={rule[key]} onValueChange={v=>update(rule.id,{[key]:v as 'include'|'exclude'})}><SelectTrigger id={`${key}-${rule.id}`} className="w-32"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="exclude">Exclude</SelectItem><SelectItem value="include">Include</SelectItem></SelectContent></Select></div>)}
        <div className="flex items-center gap-3"><Label htmlFor={`scope-${rule.id}`}>Cooldown scope</Label><Select value={rule.cooldownScope??'rule'} onValueChange={v=>update(rule.id,{cooldownScope:v as 'rule'|'rule_camera'})}><SelectTrigger id={`scope-${rule.id}`} className="w-56"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="rule">Per rule · all selected cameras</SelectItem><SelectItem value="rule_camera">Per rule and camera</SelectItem></SelectContent></Select></div>
       </div>
      </div><p className="text-muted-foreground">Select at least one zone for each selected camera and one category. The same source object must meet both category and location conditions. This does not identify the NVR rule that fired.</p>
     </section>)}
     <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={value.rules.length>=10} onClick={()=>change({...value,rules:[...value.rules,{id:crypto.randomUUID(),name:'New notification rule',enabled:true,channels:[],zoneIds:[],categories:['PERSON'],cooldownSeconds:60,ambiguous:'exclude',unknown:'exclude'}]})}>Add notification rule</Button><Button type="submit" size="sm" disabled={!draft}>Save notifications</Button><Button type="button" size="sm" variant="outline" disabled={!draft} onClick={()=>{setDraft(null);save.reset();}}>Cancel notifications</Button></div>
    </fieldset>
   </form>
   {save.isError&&<p role="alert">Settings not saved. Check selections or reload if another editor changed them. {save.error.message}</p>}{save.isSuccess&&<p role="status">Notification settings saved. Delivery remains unavailable.</p>}
   <p>{data.updatedAt?`Saved ${formatTime(data.updatedAt)} · revision ${data.revision}`:'No saved rules; delivery preference is off.'}</p>
   <div className="flex flex-wrap items-center gap-2"><Label htmlFor="notification-hours">Preview recent events</Label><Select disabled={busy} value={hours} onValueChange={v=>{setHours(v);preview.reset();archive.reset();}}><SelectTrigger id="notification-hours" className="w-32"><SelectValue/></SelectTrigger><SelectContent>{['1','6','24'].map(h=><SelectItem key={h} value={h}>{h} hour{h==='1'?'':'s'}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="outline" disabled={!data.available||!!draft||busy} onClick={()=>{archive.reset();preview.mutate(undefined);}}>{preview.isPending?'Evaluating…':'Preview rules'}</Button></div>
   <p className="text-muted-foreground">Preview reads saved rules and canonical events only. Cooldowns are simulated per rule within this window, starting with no prior sends; suppressed matches do not extend the cooldown. No AI completion is required. If the window exceeds 1,000 events or 4,096 observations, choose a shorter window.</p>
   {preview.isError&&<p role="alert">Preview failed ({preview.error.message}). Select a shorter window or refresh settings and retry.</p>}
   {preview.data&&<div className="space-y-3"><p>{preview.data.eventCount} canonical events · {preview.data.decisions.filter(d=>d.outcome==='would_notify').length} would match · {preview.data.decisions.filter(d=>d.outcome==='cooldown').length} cooldown suppressions · {preview.data.decisions.filter(d=>d.outcome==='uncertain').length} uncertain. Decisions are per event/rule, not distinct people.</p>
    {preview.data.configuration.rules.map(rule=><details key={rule.id} className="rounded border p-3"><summary className="cursor-pointer">{rule.name} · {preview.data.decisions.filter(d=>d.ruleId===rule.id&&d.outcome==='would_notify').length} matches</summary><ul className="mt-3 max-h-80 space-y-2 overflow-auto">{preview.data.decisions.filter(d=>d.ruleId===rule.id).map(d=><li key={d.idempotencyKey} className="rounded bg-muted p-2"><a className="underline" href={`/explore?event=${d.eventId}`}>{formatTime(d.receivedAt)} · {d.eventId}</a><p>{display(d.outcome)} · {display(d.reason)}{d.cooldownUntil?` · until ${formatTime(d.cooldownUntil)}`:''}</p><details><summary className="cursor-pointer">Source evidence and future delivery identity</summary><p className="break-all">Objects: {d.objectIds.join(', ')||'none'} · source versions: {d.zoneVersionIds.join(', ')||'none'}</p><p className="break-all">{d.idempotencyKey}</p>{preview.data?.objects.find(e=>e.eventId===d.eventId)?.objects.map(o=><div key={o.id}><p>{display(o.category)} · {display(o.status)} · {display(o.basis)} · {display(o.reason)}</p><p className="break-all">Reliable zone IDs: {o.reliableZoneIds?.join(', ')||'none'}</p></div>)}</details></li>)}</ul></details>)}
    <Button size="sm" variant="outline" disabled={!data.archivable||busy||preview.data.revision!==data.revision} onClick={()=>archive.mutate()}>{archive.isPending?'Saving evaluation…':'Save evaluation record'}</Button><p className="text-muted-foreground">Optional audit record only. Saving it neither queues delivery nor advances cooldown state.</p>
   </div>}
   {archive.isSuccess&&<p role="status">Evaluation record saved. Nothing was sent.</p>}{archive.isError&&<p role="alert">Evaluation not saved. Run preview again if settings or geometry changed.</p>}
   {!!data.evaluations.length&&<details><summary className="cursor-pointer">Recent saved evaluations ({data.evaluations.length})</summary><ul className="mt-2">{data.evaluations.map(e=><li key={e.id}><Button type="button" variant="link" size="sm" disabled={!!draft||busy} onClick={()=>{archive.reset();preview.mutate(e.id);}}>View evaluation {formatTime(e.createdAt)} · revision {e.configurationRevision}</Button></li>)}</ul></details>}
  </>}
 <NotificationDelivery/>
 <NotificationHistory/>
 </CardContent></Card>;
}
