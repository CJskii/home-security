import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, display, formatTime, sessionEvents } from '@/lib/api';
import { aiProcessingSchema, type Proposal } from '@/lib/ai-processing';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
export function AiProcessingSettings(){
  const client=useQueryClient(),query=useQuery({queryKey:['ai-processing'],queryFn:({signal})=>api('/api/ai/processing',aiProcessingSchema,signal)});
  const [draft,setDraft]=useState<Proposal|null>(null);
  const save=useMutation({mutationFn:async(value:Proposal)=>{
    const response=await fetch('/api/ai/processing',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
    if(!response.ok){if(response.status===401)sessionEvents.dispatchEvent(new Event('ended'));throw new ApiError(response.status);}
    return aiProcessingSchema.parse(await response.json());
  },onSuccess:data=>{client.setQueryData(['ai-processing'],data);setDraft(null);}});
  const data=query.data,value=draft??data?.configuration;
  return <Card><CardHeader><CardTitle><h2>AI Processing</h2></CardTitle></CardHeader><CardContent className="space-y-4 text-xs">
    <p role="status" className="rounded-md border border-amber-400/30 p-3 text-amber-200">Activation is controlled only by the receiver switch AI_ZONE_SELECTION_ENABLED, which defaults off. Saving cannot activate it. While off, these are proposals; once explicitly enabled, saved settings apply to new events. Receiver activation status is not verified by this page.</p>
    {query.isPending&&<p>Loading AI settings…</p>}
    {query.isError&&<p role="alert">AI settings unavailable. The compatible API is required. <Button variant="outline" size="sm" onClick={()=>{void query.refetch();}}>Retry</Button></p>}
    {data&&value&&<>
      {(!data.available||!data.writable)&&<p role="status">Read-only preview. Saving requires the additive proposal migration and a compatible writable API. Production is unchanged.</p>}
      <p>Interested is a separate local preference for future notifications. The proposed selection is Camera 1 slot 0 (My Driveway) and Camera 2 slot 0 (My Walkway), independently of Interested. Existing saved choices are retained.</p>
      <Button size="sm" variant="outline" disabled={!data.available||!data.writable||save.isPending} onClick={()=>{save.reset();setDraft({enabled:true,uncertain:'analyse',unmatched:'exclude',zones:data.zones.map(z=>({zoneId:z.zoneId,enabled:(z.channel===1||z.channel===2)&&z.slot===0}))});}}>Propose driveway and walkway only</Button>
      <p>Clear selected-area matches are eligible. Boundary or missing evidence stays eligible initially. Clear exclusions use a separate not-selected outcome; they never suppress NVR events. Saving cannot activate the receiver switch.</p>
      {value.uncertain==='exclude'&&<p role="status" className="text-amber-200">The initial receiver policy requires Analyse for uncertain or missing geometry. Until corrected, it keeps events eligible rather than applying exclusions.</p>}
      <form className="space-y-4" onSubmit={e=>{e.preventDefault();save.mutate(value);}}>
        <fieldset disabled={!data.available||!data.writable||save.isPending} className="space-y-4 disabled:opacity-60">
          <div className="flex items-center gap-2"><Input className="size-4" type="checkbox" id="ai-proposal-enabled" checked={value.enabled} onChange={e=>setDraft({...value,enabled:e.target.checked})}/><Label htmlFor="ai-proposal-enabled">Proposed global AI enable</Label></div>
          <div className="grid gap-2 sm:grid-cols-2">{data.zones.map(zone=>{const id=`ai-zone-${zone.zoneId}`;return <div key={zone.zoneId} className="flex items-center gap-2 rounded border p-3"><Input id={id} className="size-4" type="checkbox" checked={value.zones.find(z=>z.zoneId===zone.zoneId)?.enabled??false} onChange={e=>setDraft({...value,zones:value.zones.map(z=>z.zoneId===zone.zoneId?{...z,enabled:e.target.checked}:z)})}/><Label htmlFor={id}>Analyse with AI · {zone.name}<span className="mt-1 block text-[10px] text-muted-foreground">Camera {zone.channel} · slot {zone.slot} · Interested: {zone.interested?'yes':'no'}</span></Label></div>;})}</div>
          {(['uncertain','unmatched'] as const).map(key=><div key={key} className="space-y-2"><Label htmlFor={`ai-${key}`}>{key==='uncertain'?'Uncertain / missing geometry':'Outside all enabled zones'}</Label><Select value={value[key]} onValueChange={v=>setDraft({...value,[key]:v as 'analyse'|'exclude'})}><SelectTrigger id={`ai-${key}`} className="w-60"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="analyse">Analyse (conservative)</SelectItem><SelectItem value="exclude" disabled={key==='uncertain'}>{key==='uncertain'?'Exclude (not supported by initial policy)':'Exclude from AI'}</SelectItem></SelectContent></Select></div>)}
          <p>A reliable match to any selected zone on any object wins. Otherwise uncertain objects use the uncertain fallback, then unmatched objects use their fallback. Other reliably matched events are intentionally not selected. Source observations remain separate.</p>
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={!draft}>{save.isPending?'Saving…':'Save proposal'}</Button><Button size="sm" variant="outline" type="button" disabled={!draft} onClick={()=>{setDraft(null);save.reset();}}>Cancel proposal</Button></div>
        </fieldset>
      </form>
      {save.isError&&<p role="alert">Proposal was not saved. {save.error.message}</p>}{save.isSuccess&&<p role="status">Settings saved. They apply to new events only when the receiver switch is explicitly enabled.</p>}
      <p>{data.updatedAt?`Proposal saved ${formatTime(data.updatedAt)}`:'No saved proposal'}</p>
      {data.latestRecordedAnalysis&&<p>Latest recorded analysis: {data.latestRecordedAnalysis.model} · prompt {data.latestRecordedAnalysis.promptVersion} / schema {data.latestRecordedAnalysis.schemaVersion} · {formatTime(data.latestRecordedAnalysis.completedAt)}. This is historical evidence, not a live receiver configuration probe.</p>}
      <details><summary className="cursor-pointer">Processing outcomes · last {data.metricsWindowHours} hours</summary><ul className="mt-2 space-y-1">{data.recent.map((r,i)=><li key={i}>{display(r.status)} · {display(r.reason??'no reason')}: {r.count}</li>)}</ul><p className="mt-2 text-muted-foreground">Counts are processing records, not unique subjects. Intentional exclusions are distinct from capacity skips. No exclusions are activated by this proposal.</p></details>
    </>}
  </CardContent></Card>;
}
