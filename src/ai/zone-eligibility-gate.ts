import { geometryFingerprint } from '../uniview/zone-geometry.js';
import type { ZoneEligibilityStore } from './zone-eligibility-store.js';
import { previewSelectedZoneEligibility } from './selected-zone-eligibility.js';
import { observedZones } from '../uniview/zones.js';
import type { UniviewClient } from '../uniview/snapshot-client.js';
import type { EligibilityGate } from '../uniview/evidence.js';

export function createZoneEligibilityGate(installation:string,store:ZoneEligibilityStore,
  nvr:Pick<UniviewClient,'accessZone'>,report:(eventId:string,reason:string)=>void=()=>{},now:()=>Date=()=>new Date()):EligibilityGate {
  return async(eventId,signal)=>{
    const keep=(reason:string)=>{report(eventId,reason);return {eligible:true,reason};};
    try {
      signal.throwIfAborted();
      const data=await store.read(installation,eventId);
      signal.throwIfAborted();
      if(!data||data.event.sourceInstallationId!==installation||data.event.id!==eventId)return keep('zone_settings_or_metadata_unavailable');
      if(!data.proposal.enabled)return {eligible:false,reason:'ai_disabled'};
      if(data.proposal.uncertain!=='analyse')return keep('zone_unsafe_uncertainty_policy');
      if(data.truncated)return keep('zone_objects_truncated');
      const catalog=data.catalog.map(z=>({...z}));
      const scoped=catalog.filter(z=>z.sourceInstallationId===installation&&z.channel===data.event.channel);
      // Historical observations remain strictly bracketed. Fresh live events would
      // otherwise always fall AFTER the last ten-minute sync observation. Confirm
      // geometry/enablement read-only; extend only the matching latest versions in
      // this decision's RAM snapshot, never PostgreSQL or a historical gap.
      const latest=scoped.filter(z=>!scoped.some(n=>n.zoneId===z.zoneId&&(n.revision??0)>(z.revision??0)));
      const needsConfirmation=data.event.objects.some(o=>o.sourceTimestamp&&latest.some(z=>o.sourceTimestamp!>z.lastObservedAt));
      if(data.proposal.enabled&&needsConfirmation&&latest.length===4){
        const live=observedZones(await nvr.accessZone(data.event.channel,signal)),confirmedAt=now();
        if(!latest.every(z=>live.some(n=>n.slot===z.slot&&n.geometryFingerprint===geometryFingerprint(z.polygon)&&n.enabled===z.enabled&&n.ruleEnabled===z.ruleEnabled)))
          return keep('zone_configuration_changed');
        for(const z of latest)if(confirmedAt>z.lastObservedAt)z.lastObservedAt=confirmedAt;
      }
      signal.throwIfAborted();
      const decision=previewSelectedZoneEligibility(data.proposal,data.event,catalog);
      report(eventId,decision.reason);return decision;
    }catch{return keep('zone_metadata_read_fallback');}
  };
}
