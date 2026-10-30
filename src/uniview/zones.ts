import { z } from 'zod';
import { zoneRuleConfigurationSchema, type AccessZoneConfiguration } from './client-schemas.js';
import { geometryFingerprint, polygonSchema, usablePolygon, type Vertex } from './zone-geometry.js';
export interface ObservedZone { slot: number; enabled: boolean; ruleEnabled: boolean; polygon: Vertex[]; geometryFingerprint: string; name?: string; configuration?: z.infer<typeof zoneRuleConfigurationSchema> }
export interface ZoneVersion extends Omit<ObservedZone,'configuration'> {
  id: string; displayName: string; observedAt: Date; lastObservedAt: Date; nameEffectiveAt: Date;
}
export interface ZoneObservationStore {
  observe(installationId: string, channel: number, zones: ObservedZone[], observedAt: Date): Promise<void>;
}
export function observedZones(raw: AccessZoneConfiguration): ObservedZone[] {
  if (raw.Areas.Num !== raw.Areas.PolygonInfoList.length || new Set(raw.Areas.PolygonInfoList.map((v) => v.ID)).size !== raw.Areas.Num) throw new Error('Invalid zone slots');
  return raw.Areas.PolygonInfoList.map((slot) => {
    // This firmware reports unused disabled slots as three zero vertices.
    // They have no polygon: retain the disabled slot, never invent a quadrilateral.
    const placeholder = slot.Enabled === 0 && slot.PointNum === 3 && slot.PointList.length === 3
      && slot.PointList.every(({X,Y}) => X === 0 && Y === 0);
    if(slot.Num !== undefined && slot.Num !== slot.DetectTargetList?.length)throw new Error('Invalid detection target count');
    const points = placeholder ? [] : slot.PointList.map(({ X, Y }) => ({ X, Y }));
    if ((!placeholder && slot.PointNum !== points.length) || (points.length === 0 && slot.Enabled !== 0)) throw new Error('Invalid zone polygon');
    if (points.length && (!polygonSchema.safeParse(points).success || !usablePolygon(points))) throw new Error('Invalid zone polygon');
    if (slot.Enabled === 1 && !usablePolygon(points)) throw new Error('Invalid enabled polygon');
    return { slot: slot.ID, enabled: slot.Enabled === 1, ruleEnabled: raw.Rule.Enabled === 1,
      polygon: points, geometryFingerprint: geometryFingerprint(points), ...(slot.Name ? {name:zoneNameSchema.parse(slot.Name)} : {}),
      configuration:zoneRuleConfigurationSchema.parse({sensitivity:slot.Sensitivity??null,priority:slot.Priority??null,targets:slot.DetectTargetList??[]}) };
  });
}
export function observedAtTime(version: ZoneVersion, time: Date) {
  return time >= version.observedAt && time >= version.nameEffectiveAt && time <= version.lastObservedAt;
}
export function triggeringMatch(rule: Vertex[] | null, versions: ZoneVersion[], time: Date) {
  if (!rule || !usablePolygon(rule)) return { status: 'UNKNOWN' as const, zoneVersionId: null, reason: 'missing_or_invalid_rule' };
  const fingerprint = geometryFingerprint(rule);
  const matches = versions.filter((v) => v.enabled && v.ruleEnabled && observedAtTime(v, time) && v.geometryFingerprint === fingerprint);
  if (matches.length === 1) return { status: 'CONFIRMED_GEOMETRY_MATCH' as const, zoneVersionId: matches[0]!.id, reason: 'unique_observed_geometry' };
  return { status: matches.length ? 'AMBIGUOUS' as const : 'UNKNOWN' as const, zoneVersionId: null,
    reason: matches.length ? 'multiple_observed_zones' : 'no_observed_configuration_match' };
}
export const zoneNameSchema = z.string().trim().min(1).max(128).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
