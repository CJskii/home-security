import { activityZone } from './zone-activity.js';
import { compactDetection, compactNotification, compactRow } from './compact-history.js';
import { z } from 'zod';
import type { Database } from '../database.js';
import type { DeliveryHistory } from '../notifications/history.js';
import { historySchema } from '../events/queries.js';
import { presentEvent } from '../events/presentation.js';
import { mediaLink, type NotificationMedia } from '../notifications/media.js';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown) => Array.isArray(v) ? v.map(record) : [];
// Data is rendered as text, never HTML, links or HA templates supplied by a model/NVR.
export function markdownText(value: unknown, max = 220): string {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}[\]()!|#~]/g, '\\$&');
}
const readable = (v: unknown) => markdownText(String(v ?? 'unknown').toLowerCase().replaceAll('_', ' '));
function localTime(v: unknown) {
  const date = new Date(String(v));
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date) : 'Time unknown';
}
export const haHistoryResponse = z.object({ version: z.literal(1), status: z.literal('ok'), generatedAt: z.iso.datetime(), eventCount: z.number().int().min(0).max(8), detectionsMarkdown: z.string().max(24000), notificationsMarkdown: z.string().max(24000), detections:z.array(compactRow).max(4), notificationRows:z.array(compactRow).max(4), zoneActivity:z.array(activityZone).max(8), propertyDetections:z.array(compactRow).max(4),otherDetections:z.array(compactRow).max(4),dashboardUrl:z.string().url() }).strict();
export async function homeAssistantHistory(database: Database, installation: string, origin: string, media?: NotificationMedia, now = new Date()) {
  if (!database.events || !database.notifications?.history) throw Error('History unavailable');
  const url = new URL(origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin !== origin) throw Error('Invalid dashboard origin');
  const [rows, history, attempted, zoneActivity, propertyRows, otherRows] = await Promise.all([
    database.events.history(historySchema.parse({ limit: 8, sourceInstallationId: installation })),
    database.notifications.history(installation),
    database.notifications.history(installation, undefined, true),
    database.zoneActivity?.(installation,now)??Promise.resolve([]),
    database.events.history(historySchema.parse({limit:4,sourceInstallationId:installation,zoneInterest:'interested'})),
    database.events.history(historySchema.parse({limit:4,sourceInstallationId:installation,zoneInterest:'other'})),
  ]);
  const link = (id: unknown) => origin + '/explore?event=' + z.uuid().parse(id);
  // Stable token within a 10-minute interval avoids URL churn on every 15s HA poll.
  const signedAt = new Date(Math.floor(now.getTime() / 600000) * 600000);
  const detections = rows.slice(0, 8).map((row, index) => {
    const e = presentEvent(row), objects = e.objects;
    const zones = [...new Set(objects.flatMap(o => list(record(o.location).matches).map(m => markdownText(m.name, 80))))];
    const statuses = objects.map(o => String(record(o.location).status ?? 'UNKNOWN'));
    const zone = zones.length ? zones.join(', ') + (statuses.some(s => s === 'AMBIGUOUS' || s === 'UNKNOWN') ? ' · uncertain' : '') : statuses.includes('AMBIGUOUS') ? 'Boundary uncertain' : statuses.includes('UNMATCHED') ? 'Unmatched' : 'Zone unknown';
    const processing = record(row.processing);
    const description = record(row.analysis).shortDescription ? markdownText(record(row.analysis).shortDescription) : '';
    const category = e.categories.map(c => readable(c)).join(', ') || 'Unknown category';
    const status = readable(processing.status ?? 'pending');
    const reason = processing.reason;
    const crop = objects.map(o => e.images.find(i => record(i).id === o.images.cropId && i.type === 2)).find(Boolean);
    // Two native crops at most: metadata polling never fetches or renders NVR media.
    const image = index < 2 && crop && media ? mediaLink(media, z.uuid().parse(row.id), z.uuid().parse(record(crop).id), z.uuid().parse(row.id), signedAt).url : null;
    return `**[${markdownText(row.camera ?? 'Camera ' + row.nvrChannel, 80)} · ${category}](${link(row.id)})**\n\n${localTime(e.timestamp.value)} · ${zone}\n\nAI: ${status}${reason ? ' · ' + readable(reason) : ''}${description ? ' — ' + description : ''}${image ? `\n\n[![Original NVR detection crop](${image})](${link(row.id)})` : ''}`;
  });
  const compactItems=[...new Map([...attempted.items.slice(0,2),...history.items.slice(0,2)].map(item=>[item.id,item])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const grouped=(group:Record<string,unknown>[],scope:'property'|'other')=>group.slice(0,4).flatMap(row=>{
    const event=presentEvent(row);
    const qualifying=event.objects.filter(o=>{const l=record(o.location);return l.status==='MATCHED'&&list(l.matches).some(m=>scope==='property'?m.interested===true:m.interested===false);});
    if(!qualifying.length)return [];
    const object=qualifying.find(o=>o.images.cropId)??qualifying[0];
    const crop=object&&event.images.find(i=>record(i).id===object.images.cropId&&i.type===2);
    return [{...compactDetection(row,{...event,objects:object?[object]:[]},link(row.id),localTime(event.timestamp.value),scope),thumbnail:crop&&media?mediaLink(media,z.uuid().parse(row.id),z.uuid().parse(record(crop).id),z.uuid().parse(row.id),signedAt).url:null}];
  });
  return haHistoryResponse.parse({ propertyDetections:grouped(propertyRows,'property'),otherDetections:grouped(otherRows,'other'), detections:rows.slice(0,4).map(row=>compactDetection(row,presentEvent(row),link(row.id),localTime(presentEvent(row).timestamp.value))), notificationRows:compactItems.map(item=>compactNotification(item,link(item.eventId),localTime(item.receivedAt??item.createdAt))), zoneActivity, dashboardUrl:origin+'/explore', version: 1, status: 'ok', generatedAt: now.toISOString(), eventCount: detections.length, detectionsMarkdown: detections.join('\n\n---\n\n') || 'No canonical detections available.', notificationsMarkdown: historyMarkdown({ ...history, items: [...new Map([...attempted.items.slice(0, 4), ...history.items.slice(0, 4)].map(item => [item.id, item])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }, link) });
}
export function historyMarkdown(history: DeliveryHistory, link: (id: string) => string): string {
  if (!history.available) return 'Notification ledger unavailable.';
  const rows = history.items.slice(0, 8).map(item => {
    const intent = item.intent;
    const state = intent?.state === 'DELIVERED' ? 'Webhook accepted' : readable(intent?.state ?? item.state);
    const decisions = item.decisions.map(d => `${markdownText(d.ruleName, 80)}: ${readable(d.outcome)} · ${readable(d.reason)}${d.cooldownUntil ? ' until ' + localTime(d.cooldownUntil) : ''}`).join('; ');
    return `**[Camera ${item.channel ?? '?'} · ${state}](${link(item.eventId)})**\n\n${localTime(item.receivedAt ?? item.createdAt)} · ${intent?.attemptCount ?? 0} attempts\n\n${decisions || 'Awaiting rule evaluation'}${intent?.lastError ? '\n\nError: ' + readable(intent.lastError) : ''}${item.deliveryHeldReason ? '\n\nHeld: ' + readable(item.deliveryHeldReason) : ''}`;
  });
  return 'Webhook acceptance is not confirmation that a phone displayed the alert.\n\n' + (rows.join('\n\n---\n\n') || 'No live notification evaluation records.');
}
