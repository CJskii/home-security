import { useQueries } from '@tanstack/react-query';
import { useCameras } from '@/lib/camera-configuration';
import { api } from '@/lib/api';
import { zonesSchema } from '@/lib/contracts';
import { zoneName } from '@/lib/zones';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
export function useZoneFilterOptions(value:string){
 const cameras=useCameras();
 const zones=useQueries({queries:(cameras.data?.cameras??[]).map(c=>({queryKey:['zones',c.id],queryFn:({signal}:{signal:AbortSignal})=>api(`/api/cameras/${encodeURIComponent(c.id)}/zones`,zonesSchema,signal),refetchInterval:60_000}))});
 const options=[['all','All locations'],['interested','Interested zones'],['other','Other zones'],['uncertain','Uncertain / missing geometry'],['unmatched','Outside enabled zones'],...(['ambiguous','unknown'].includes(value)?[[value,value==='ambiguous'?'Boundary ambiguous':'Missing geometry']]:[]),...zones.flatMap((q,i)=>q.data?.zones.filter(z=>z.current?.enabled&&z.current.ruleEnabled!==false||z.id===value).map(zone=>[zone.id,`Camera ${cameras.data?.cameras[i]?.channel} · ${zoneName(zone)}${!zone.current?.enabled?' (disabled now)':''}`])??[])];
 return{options,cameras,error:zones.some(q=>q.isError)};
}
export function ZoneFilter({value,onChange,options,error=false}:{value:string;onChange:(value:string)=>void;options:string[][];error?:boolean}){
 return <div className="space-y-1"><Select value={value} onValueChange={onChange}><SelectTrigger aria-label="Geometric zone filter" className="h-9 w-40 text-xs sm:w-60"><SelectValue/></SelectTrigger><SelectContent>
 {options.map(([v,label])=><SelectItem key={v} value={v!}>{label}</SelectItem>)}
 </SelectContent></Select>{error&&<p className="text-[10px] text-amber-200">Zone names unavailable. Retry metadata refresh.</p>}</div>;
}
