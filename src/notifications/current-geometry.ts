import type { LocationObject, LocationZone } from '../uniview/object-location.js';
// Scheduled observation is not an expiry. Carry forward ONLY the latest version
// of every slot for recent notifications, never over a subsequently detected change.
// Two missed 600s observations fail closed. No NVR request or persisted mutation.
export const NOTIFICATION_GEOMETRY_MAX_AGE_MS = 1200000;
export function notificationGeometry(object: Pick<LocationObject,'sourceTimestamp'>, versions: readonly LocationZone[], now: Date) {
    const time = object.sourceTimestamp?.getTime();
    if (time === undefined || time > now.getTime() + 1000) return { versions, cached: false };
    const latest = [...new Set(versions.map(v => v.slot))].map(slot => versions.filter(v => v.slot === slot).sort((a,b) => b.observedAt.getTime()-a.observedAt.getTime())[0]!);
    if (latest.length !== 4 || latest.some(v => versions.some(other => other.slot === v.slot && other.id !== v.id && other.observedAt.getTime() === v.observedAt.getTime()))) return { versions, cached: false };
    const extend = latest.filter(v => time > v.lastObservedAt.getTime());
    if (!extend.length || latest.some(v => time < Math.max(v.observedAt.getTime(),v.nameEffectiveAt.getTime()) || now.getTime()-v.lastObservedAt.getTime() > NOTIFICATION_GEOMETRY_MAX_AGE_MS)) return { versions, cached: false };
    return { cached: true, versions: versions.map(v => extend.includes(v) ? {...v,lastObservedAt:new Date(time)} : v) };
}
