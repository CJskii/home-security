import type * as Fs from 'node:fs';
import type * as Path from 'node:path';
import type * as Crypto from 'node:crypto';
import type { WebhookPayload } from './delivery-contract.js';

// Embedded into the isolated Node-RED Functions by the preparation script. No
// runtime imports, credentials, remote calls or startup side effects in this factory.
export function createReceiverToolkit(fs: typeof Fs, path: typeof Path, crypto: typeof Crypto, directory: string, mediaOrigin?: string, capacity = 1024) {
  type RecordState = 'IN_FLIGHT' | 'FIRST_PHONE_ACK' | 'ACCEPTED' | 'HELD_LOCAL_DISABLED' | 'UNCERTAIN';
  type Entry = { version: 1; key: string; notificationId: string; eventId: string | null; hash: string; token: string; state: RecordState; at: string; updatedAt: string; scope?:string; revision?:number };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const accepted = (id: string) => ({ version: 1, notificationId: id, outcome: 'accepted' });
  const rejected = (id: string, retryable = false) => ({ version: 1, notificationId: id, outcome: 'rejected', retryable });
  const error = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  function validate(raw: Buffer, headers: Record<string, unknown>, secret: unknown, installation: string, now = Date.now()) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) return error('receiver_not_configured');
    if (!Buffer.isBuffer(raw) || raw.length > 65536) return error('raw_body_required_or_too_large');
    const timestamp = headers['x-home-security-timestamp'], key = headers['idempotency-key'], signature = headers['x-home-security-signature'];
    if (typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 || typeof key !== 'string' || key.length > 128 || typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return error('authentication_rejected');
    const expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + key + '.').update(raw).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) return error('authentication_rejected');
    if (typeof headers['content-type'] !== 'string' || !/^application\/json(?:\s*;|$)/i.test(headers['content-type'])) return error('json_required');
    let body: WebhookPayload;
    try { body = JSON.parse(raw.toString('utf8')) as WebhookPayload; } catch { return error('invalid_json'); }
    if (!body || body.version !== 1 || !uuid.test(body.notificationId ?? '') || body.idempotencyKey !== key || !uuid.test(installation)) return error('invalid_notification_identity');
    if (!body.camera || ![1, 2].includes(body.camera.channel) || typeof body.camera.name !== 'string' || body.camera.name.length > 128 || !body.timestamps || typeof body.timestamps.receivedAt !== 'string' || !Number.isFinite(Date.parse(body.timestamps.receivedAt)) || (body.timestamps.occurredAt !== null && (typeof body.timestamps.occurredAt !== 'string' || !Number.isFinite(Date.parse(body.timestamps.occurredAt))))) return error('invalid_source_metadata');
    if (!Array.isArray(body.objects) || body.objects.length < 1 || body.objects.length > 128 || body.objects.some(o => !o || !uuid.test(o.id ?? '') || !['PERSON', 'MOTOR_VEHICLE', 'NON_MOTOR_VEHICLE'].includes(o.category) || !Array.isArray(o.zoneIds) || o.zoneIds.length > 8 || o.zoneIds.some(z => !uuid.test(z)) || !Array.isArray(o.zoneVersionIds) || o.zoneVersionIds.length > 16 || o.zoneVersionIds.some(z => !uuid.test(z)) || (o.zoneNames !== undefined && (!Array.isArray(o.zoneNames) || o.zoneNames.length > 8 || o.zoneNames.some(z => !z || !uuid.test(z.id) || !o.zoneIds.includes(z.id) || typeof z.name !== 'string' || z.name.length > 128))))) return error('invalid_objects');
    if (!Array.isArray(body.rules) || !Array.isArray(body.images)) return error('invalid_source_metadata');
    const isTest = body.type === 'security.test';
    if (isTest ? (!['test','update'].includes(body.action??'') || body.test !== true || body.eventId !== null || body.rules.length !== 0 || (body.images.length !== 0 && !uuid.test(body.sampleEventId ?? '')) || headers['x-home-security-test'] !== 'true' || key !== `${body.action==='update'?'notification-test-update':'notification-test'}:v1:${installation}:${body.notificationId}`) : (body.type !== 'security.event' || !['create','update'].includes(body.action??'') || body.test === true || !uuid.test(body.eventId ?? '') || headers['x-home-security-test'] === 'true' || body.sampleEventId !== undefined || key !== `${body.action==='update'?'notification-update':'notification'}:v1:${installation}:${body.eventId}`)) return error('unsupported_test_or_event_identity');
    if(body.action==='update'){
      const e=body.enrichment;
      if(!e||!Number.isInteger(e.revision)||e.revision<1||body.ai?.status!=='completed'||body.ai.revision!==e.revision||typeof body.ai.summary!=='string'||!body.ai.summary.trim()||body.ai.summary.length>512||!Array.isArray(e.objectIds)||e.objectIds.length<1||e.objectIds.length>8||e.objectIds.some(id=>!body.objects.some(o=>o.id===id))||!Number.isFinite(Date.parse(e.completedAt))||Date.parse(e.completedAt)>now||!isTest&&now-Date.parse(body.timestamps.receivedAt)>120000)return error('invalid_enrichment');
    }else if(body.enrichment!==undefined)return error('invalid_enrichment');
    if(body.images.length>2 || body.images.some(image=>{if(!image||!uuid.test(image.id))return true;if(!image.delivery)return false;const eventId=isTest?body.sampleEventId:body.eventId,prefix=`${mediaOrigin}/api/notification-media/${eventId}/${image.id}?token=`;return !mediaOrigin||!image.delivery.url.startsWith(prefix)||!/^[-_A-Za-z0-9]+\.[a-f0-9]{64}$/.test(image.delivery.url.slice(prefix.length))||image.delivery.url.length>1024||!Number.isFinite(Date.parse(image.delivery.expiresAt))||Date.parse(image.delivery.expiresAt)<=now;}))return error('invalid_source_metadata');
    return { body, isTest, hash: crypto.createHash('sha256').update(raw).digest('hex') };
  }
  // Unknown takes precedence over a home indication: a broken presence check must
  // not silently discard a potentially relevant alert. Named HA zones mean away.
  function presence(primary: unknown, secondary: unknown): 'phones_away' | 'phones_unknown' | 'local_held' {
    const state = (value: unknown) => typeof value !== 'string' || !value.trim() || ['unknown', 'unavailable', 'none', 'null'].includes(value.trim().toLowerCase()) ? 'unknown' : value.trim().toLowerCase() === 'home' ? 'home' : 'away';
    const values = [state(primary), state(secondary)];
    return values.includes('unknown') ? 'phones_unknown' : values.includes('home') ? 'local_held' : 'phones_away';
  }
  function notification(body: WebhookPayload, isTest: boolean) {
    const categories = [...new Set(body.objects.map(o => o.category === 'PERSON' ? 'Person' : 'Vehicle'))].join(' and ');
    const zones = [...new Set(body.objects.flatMap(o => o.zoneNames?.map(z => z.name) ?? []))].join(', ') || 'Zone not established';
    const time = body.timestamps.occurredAt ?? body.timestamps.receivedAt;
    const readableTime = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'}).format(new Date(time));
    const zoneNames=body.objects.flatMap(o=>o.zoneNames?.map(z=>z.name)??[]);
    const where = zoneNames.includes('My Driveway') ? 'Front driveway' : zoneNames.includes('My Walkway') ? 'Back walkway' : zones==='Zone not established'?body.camera.name:zones;
    const rich = !isTest || Boolean(body.sampleEventId);
    const title = `${isTest ? 'TEST · ' : ''}🚨 ${where}`;
    const message = `${body.action==='update'?body.ai.summary?.replace(/^(?:A|The) person\b/,'Someone'):`${categories==='Person'?'Someone':categories} detected`}\n${readableTime}${isTest?'\nControlled TEST — not a new detection.':''}`;
    const image = body.images.find(i=>i.delivery)?.delivery?.url;
    return { title:rich?title:'Home Security · TEST', message:rich?message:`${categories} detected — TEST only\nCamera: ${body.camera.name}\nZone: ${zones}\n${body.timestamps.occurredAt?'Time':'Received'}: ${readableTime}\nNo real detection. Presence bypassed.`, data: { ...(image?{image}:{}), alert_once:true,notification_icon:'mdi:shield-alert', channel:'Home Security',importance:'high',priority:'high',ttl:0,clickAction:body.dashboardUrl,tag: 'home-security:' + body.notificationId, group: 'home-security', notification_id: body.notificationId, event_id: body.eventId ?? '', sample_event_id:body.sampleEventId??'', event_timestamp: time, test: isTest ? 'true' : 'false', camera: String(body.camera.channel) } };
  }
  function folder() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) return error('journal_directory_invalid');
    fs.chmodSync(directory, 0o700);
    const parent = fs.openSync(path.dirname(directory), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  const file = (key: string) => path.join(directory, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  function syncDirectory() { const fd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  function read(key: string): Entry {
    const name = file(key);
    if (fs.lstatSync(name).isSymbolicLink()) return error('journal_record_invalid');
    const data = fs.readFileSync(name, 'utf8');
    if (Buffer.byteLength(data) > 4096) return error('journal_record_invalid');
    const record = JSON.parse(data) as Entry;
    if (record.version !== 1 || record.key !== key || !uuid.test(record.notificationId) || !uuid.test(record.token) || !/^[a-f0-9]{64}$/.test(record.hash) || !['IN_FLIGHT', 'FIRST_PHONE_ACK', 'ACCEPTED', 'HELD_LOCAL_DISABLED', 'UNCERTAIN'].includes(record.state)) return error('journal_record_invalid');
    return record;
  }
  function claim(body: WebhookPayload, hash: string, now = new Date()) {
    folder();
    const name = file(body.idempotencyKey);
    const scope=crypto.createHash('sha256').update(JSON.stringify({eventId:body.eventId,camera:body.camera,timestamps:body.timestamps,objects:body.objects,rules:body.rules,images:body.images,dashboardUrl:body.dashboardUrl})).digest('hex');
    if(body.action==='update'){
      const parent=read(body.idempotencyKey.replace('notification-test-update:v1:','notification-test:v1:').replace('notification-update:v1:','notification:v1:'));
      if(body.type==='security.test'&&Date.now()-Date.parse(parent.at)>120000)return {outcome:'conflict' as const};
      if(parent.state!=='ACCEPTED'||parent.notificationId!==body.notificationId||parent.eventId!==body.eventId||parent.scope!==scope||(parent.revision??0)>=(body.enrichment?.revision??0))return {outcome:'conflict' as const};
      if(fs.existsSync(file('dismissed:'+body.notificationId)))return {outcome:'dismissed' as const};
    }
    if (fs.existsSync(name)) {
      const old = read(body.idempotencyKey);
      if (old.hash !== hash || old.notificationId !== body.notificationId || old.eventId !== body.eventId) return { outcome: 'conflict' as const };
      return { outcome: ['ACCEPTED', 'HELD_LOCAL_DISABLED'].includes(old.state) ? 'accepted' as const : 'uncertain' as const, entry: old };
    }
    // No eviction of accepted or uncertain identities. Full means fail closed.
    // A retention/capacity policy must be reviewed before automatic live use.
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000 || fs.readdirSync(directory).length >= capacity) return error('journal_capacity_reached');
    const entry: Entry = { version: 1, key: body.idempotencyKey, notificationId: body.notificationId, eventId: body.eventId, hash, token: crypto.randomUUID(), state: 'IN_FLIGHT', at: now.toISOString(), updatedAt: now.toISOString(),scope,revision:body.ai.revision??0 };
    let fd: number;
    try { fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { outcome: 'uncertain' as const };
      throw e;
    }
    try { fs.writeFileSync(fd, JSON.stringify(entry)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory();
    return { outcome: 'claimed' as const, entry };
  }
  function finish(key: string, token: string, state: RecordState) {
    folder();
    const record = read(key);
    if (record.token !== token) return error('journal_claim_changed');
    if (['ACCEPTED', 'HELD_LOCAL_DISABLED'].includes(record.state)) return record;
    const next = { ...record, state, updatedAt: new Date().toISOString() }, name = file(key), temp = name + '.tmp.' + crypto.randomUUID();
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, name); syncDirectory();
    return next;
  }
  function dismiss(tag:unknown){
    if(typeof tag!=='string'||!tag.startsWith('home-security:')||!uuid.test(tag.slice(14)))return false;
    folder();const name=file('dismissed:'+tag.slice(14));if(fs.existsSync(name))return true;
    if(fs.readdirSync(directory).length>=capacity)return error('journal_capacity_reached');
    const fd=fs.openSync(name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory();return true;
  }
  return { validate, presence, notification, claim, finish, accepted, rejected, dismiss };
}
