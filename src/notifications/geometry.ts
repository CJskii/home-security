import { notificationGeometry } from './current-geometry.js';
import { locateObject, type LocationObject, type LocationZone } from '../uniview/object-location.js';
import { rectangleMembership } from '../uniview/zone-geometry.js';
import type { NotificationObject, NotificationEvent } from './evaluate.js';
interface Observation extends LocationObject {
    id: string;
    category: string;
    memberships: {
        zoneVersionId: string;
        relationship: string;
    }[];
}
export function projectNotificationEvent(e: {
    id: string;
    nvrChannel: number;
    firstReceivedAt: Date;
    objects: Observation[];
}, versions: readonly LocationZone[], liveAt?: Date): NotificationEvent {
    return { id: e.id, channel: e.nvrChannel, receivedAt: e.firstReceivedAt.toISOString(), truncated: e.objects.length > 128, objects: e.objects.slice(0, 128).map(o => {
            const original = versions.filter(v => v.channel === e.nvrChannel);
            const geometry = liveAt ? notificationGeometry(o, original, liveAt) : {versions: original, cached: false};
            const scoped = geometry.versions, location = locateObject(o, scoped,'person_ground_point');
            let status = location.status, zoneIds = location.matches.map(z => z.zoneId), reason = location.reason;
            let reliableZoneIds = location.status === 'MATCHED' ? [...zoneIds] : [];
            const applicable = scoped.filter(v => location.evaluatedVersionIds.includes(v.id)), active = applicable.filter(v => v.enabled && v.ruleEnabled);
            if (o.memberships.length > 16) {
                status = 'UNKNOWN';
                zoneIds = [];
                reliableZoneIds = [];
                reason = 'membership_limit';
            }
            else if (o.memberships.length && status !== 'UNKNOWN') {
                const consistent = o.memberships.every(m => applicable.some(v => v.id === m.zoneVersionId && rectangleMembership({ xMin: o.xMin!, yMin: o.yMin!, xMax: o.xMax!, yMax: o.yMax! }, v.polygon) === m.relationship)) && active.every(v => o.memberships.some(m => m.zoneVersionId === v.id));
                if (!consistent) {
                    status = 'UNKNOWN';
                    zoneIds = [];
                    reliableZoneIds = [];
                    reason = 'inconsistent_stored_membership';
                }
                else if(location.reason!=='person_ground_point') {
                    const inside = active.filter(v => o.memberships.some(m => m.zoneVersionId === v.id && m.relationship === 'WITHIN'));
                    zoneIds = inside.map(v => v.zoneId);
                    reliableZoneIds = [...zoneIds];
                    status = active.some(v => o.memberships.some(m => m.zoneVersionId === v.id && m.relationship === 'INTERSECTS')) ? 'AMBIGUOUS' : inside.length ? 'MATCHED' : 'UNMATCHED';
                    reason = 'stored_rectangle_membership';
                }
            }
            return { id: o.id, category: o.category, status, zoneIds, reliableZoneIds, versionIds: location.evaluatedVersionIds, basis: geometry.cached ? 'latest_confirmed_geometry_assumed_unchanged' : o.memberships.length ? 'stored_membership' : 'stored_geometry_projection', reason } satisfies NotificationObject;
        }) };
}
