import type { SecurityEvent } from '@/lib/contracts';
import { display } from '@/lib/api';
export function locationNames(event:SecurityEvent){
  return [...new Map(event.objects.flatMap(o=>o.location?.status==='MATCHED'?o.location.matches:[]).map(z=>[z.zoneId,z])).values()];
}
export function aiStatus(event:SecurityEvent){
  const reason=event.processing?.reason,status=event.processing?.status;
  if(status==='SKIPPED'&&(reason==='zone_not_selected'||reason==='zone_uncertain_not_selected'||reason==='zone_unmatched_not_selected'))return 'AI not selected';
  if(status==='SKIPPED'&&reason==='capacity_exceeded')return 'AI skipped · capacity';
  if((status==='COMPLETE'||status==='SKIPPED')&&reason==='ai_disabled')return 'AI disabled';
  if(status==='COMPLETE'&&reason==='ai_complete')return 'AI completed';
  return `AI ${display(event.processing?.status??'not processed')}`;
}
export function ObjectLocationDetails({object}:{object:SecurityEvent['objects'][number]}){
 const location=object.location;if(!location)return null;
 return <details className="mb-3 rounded border p-2 text-xs"><summary className="cursor-pointer">Geometric location · {location.status==='MATCHED'?location.matches.map(z=>`${z.name} (v${z.revision??'?'})`).join(', '):display(location.status)}</summary><div className="mt-2 space-y-1 text-muted-foreground"><p>Object location estimate only; not proof of which NVR rule fired. Local names identify current slot aliases; historical polygons can cover different areas.</p><p>{display(location.reason)} · bottom-centre / bbox-centre consensus · conservative boundary band</p>{location.status==='AMBIGUOUS'&&location.matches.length>0&&<p>Tentative bottom-centre locations: {location.matches.map(z=>z.name).join(', ')}. These are excluded from named-zone filters.</p>}<p className="break-all">Algorithm {location.algorithm} · observed configuration bracket · version IDs: {location.evaluatedVersionIds.join(', ')||'none'}</p></div></details>;
}
