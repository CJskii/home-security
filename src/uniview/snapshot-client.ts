import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import { jpegDimensions, originalJpeg } from './jpeg.js';
import { parseNotificationJson } from './schemas.js';
import { CLIENT_LIMITS, cameraOsdSchema, accessZoneSchema, channelSchema, pageQuerySchema, pictureReferenceSchema, progressSchema,
  rangeSchema, recordReferenceSchema, recordsSchema, videoStreamsSchema, searchPageSchema, searchQuerySchema, startSchema,
  type HistoricalPictureReference, type SmartSearchEntry, type SmartSearchPage, type SmartSearchQuery } from './client-schemas.js';
export type { HistoricalPictureReference, SmartSearchQuery, SmartSearchPage, SmartSearchEntry, AccessZoneConfiguration,
  RecordingPage, RecordingReference, VideoStreamSettings } from './client-schemas.js';
export type SnapshotClient = (channel: number, signal: AbortSignal) => Promise<Buffer>;
type Failure = 'unavailable' | 'limit' | 'invalid_response' | 'invalid_request' | 'authentication' | 'timeout' | 'aborted' | 'busy' | 'search_cleanup_failed' | 'nvr_error';
export class UniviewClientError extends Error {
  constructor(readonly code: Failure, readonly sourceStatusCode?: number, readonly httpStatus?: number) { super(`NVR ${code}`); }
}
export interface SmartSearchSession {
  progress(): Promise<z.infer<typeof progressSchema>>;
  page(query?: { Offset?: number; Limit?: number }): Promise<SmartSearchPage>;
}
function parsed<T>(schema: z.ZodType<T>, value: unknown, code: Failure = 'invalid_response'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new UniviewClientError(code);
  return result.data;
}
function aborted(signal: AbortSignal): UniviewClientError {
  return new UniviewClientError(signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'aborted');
}
// Also bounds injected transports/readers that do not themselves honor AbortSignal.
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(aborted(signal));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel)).catch(() => {});
    if (signal.aborted) cancel();
  });
}
function digestAuthorization(config: Config, challenge: string, method: string, path: string): string {
  if (!challenge.startsWith('Digest ') || challenge.length > 4096) throw new UniviewClientError('authentication');
  const params = Object.fromEntries([...challenge.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1]!.toLowerCase(), m[2] ?? m[3]!]));
  const algorithm = (params.algorithm ?? 'MD5').toUpperCase();
  if (!params.realm || !params.nonce || !['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm)) throw new UniviewClientError('authentication');
  const qop = params.qop?.split(',').map((v) => v.trim());
  if (qop && !qop.includes('auth')) throw new UniviewClientError('authentication');
  const hash = (value: string) => createHash(algorithm.startsWith('MD5') ? 'md5' : 'sha256').update(value).digest('hex');
  const cnonce = randomBytes(16).toString('hex'), nc = '00000001';
  let ha1 = hash(`${config.UNIVIEW_USERNAME}:${params.realm}:${config.UNIVIEW_PASSWORD}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${params.nonce}:${cnonce}`);
  const response = hash(`${ha1}:${params.nonce}:${qop ? `${nc}:${cnonce}:auth:` : ''}${hash(`${method}:${path}`)}`);
  let auth = `Digest username=${JSON.stringify(config.UNIVIEW_USERNAME)}, realm=${JSON.stringify(params.realm)}, nonce=${JSON.stringify(params.nonce)}, uri=${JSON.stringify(path)}, response=${JSON.stringify(response)}, algorithm=${algorithm}`;
  if (!qop && algorithm.endsWith('-SESS')) auth += `, cnonce=${JSON.stringify(cnonce)}`;
  if (qop) auth += `, qop=auth, nc=${nc}, cnonce=${JSON.stringify(cnonce)}`;
  if (params.opaque) auth += `, opaque=${JSON.stringify(params.opaque)}`;
  return auth;
}

// Single fixed-origin transport for live JPEGs and typed, read-only LAPI operations.
// No caller-supplied URL, redirect, disk persistence, media cache or logging.
export function createUniviewClient(config: Config, request: typeof fetch = fetch) {
  let active = 0, searching = false;
  const concurrency = Math.min(4, config.UNIVIEW_MAX_CONCURRENT_UPLOADS);
  async function admitted<T>(work: () => Promise<T>): Promise<T> {
    if (active >= concurrency) throw new UniviewClientError('busy');
    active++;
    try { return await work(); } finally { active--; }
  }
  async function transport(method: 'GET' | 'PUT' | 'DELETE', path: string, kind: 'json' | 'jpeg', maxBytes: number,
    signal: AbortSignal | undefined, timeout: number, body?: unknown): Promise<Buffer> {
    const controller = AbortSignal.timeout(timeout);
    const deadline = signal ? AbortSignal.any([signal, controller]) : controller;
    let response: Response | undefined;
    try {
      if (!config.UNIVIEW_USERNAME || !config.UNIVIEW_PASSWORD || !config.UNIVIEW_NVR_IP || !isIP(config.UNIVIEW_NVR_IP)) throw new UniviewClientError('authentication');
      if (deadline.aborted) throw aborted(deadline);
      const host = config.UNIVIEW_NVR_IP.includes(':') ? `[${config.UNIVIEW_NVR_IP}]` : config.UNIVIEW_NVR_IP;
      const url = `http://${host}${path}`;
      const headers: Record<string, string> = { 'accept-encoding': 'identity', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      const options: RequestInit = { method, signal: deadline, redirect: 'error', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const send = (options: RequestInit) => bounded(request(url, options).then((r) => {
        if (deadline.aborted) void r.body?.cancel().catch(() => {});
        return r;
      }), deadline);
      response = await send(options);
      if (response.status === 401) {
        const challenge = response.headers.get('www-authenticate') ?? '';
        await bounded(response.body?.cancel() ?? Promise.resolve(), deadline);
        headers.authorization = digestAuthorization(config, challenge, method, path);
        response = await send({ ...options, headers });
      }
      if (response.status === 401) throw new UniviewClientError('authentication');
      if (!response.ok) throw new UniviewClientError('unavailable', undefined, response.status);
      if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== (kind === 'jpeg' ? 'image/jpeg' : 'application/json') || !response.body) throw new UniviewClientError('unavailable');
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw new UniviewClientError('invalid_response');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new UniviewClientError('invalid_response');
      if (declared !== null && Number(declared) > maxBytes) throw new UniviewClientError('limit');
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let bytes = 0;
      try {
        while (true) {
          const next = await bounded(reader.read(), deadline); if (next.done) break;
          bytes += next.value.length;
          if (bytes > maxBytes) throw new UniviewClientError('limit');
          chunks.push(Buffer.from(next.value));
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (declared !== null && bytes !== Number(declared)) throw new UniviewClientError('invalid_response');
      return Buffer.concat(chunks, bytes);
    } catch (error) {
      void response?.body?.cancel().catch(() => {});
      if (error instanceof UniviewClientError) throw error;
      throw deadline.aborted ? aborted(deadline) : new UniviewClientError('unavailable');
    }
  }
  async function json<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown, timeout = config.UNIVIEW_REQUEST_TIMEOUT_MS, budget?: { remaining: number }): Promise<T> {
    const maxBytes = Math.min(CLIENT_LIMITS.jsonBytes, config.UNIVIEW_MAX_BODY_BYTES, budget?.remaining ?? Infinity);
    if (maxBytes <= 0) throw new UniviewClientError('limit');
    const bytes = await transport(method, path, 'json', maxBytes, signal, timeout, body);
    if (budget) budget.remaining -= bytes.length;
    let value: unknown;
    try { value = parseNotificationJson(bytes); } catch { throw new UniviewClientError('invalid_response'); }
    const envelope = parsed(z.object({ Response: z.object({ ResponseCode: z.number().int(), StatusCode: z.number().int(), Data: z.unknown() }) }), value);
    if (envelope.Response.ResponseCode !== 0 || envelope.Response.StatusCode !== 0) throw new UniviewClientError('nvr_error', envelope.Response.StatusCode);
    return parsed(schema, envelope.Response.Data);
  }
  async function jpeg(path: string, signal: AbortSignal | undefined, historical: boolean) {
    const maxBody = historical ? Math.min(config.UNIVIEW_MAX_BODY_BYTES, Math.ceil(config.UNIVIEW_MAX_IMAGE_BYTES / 3) * 4 + 65536) : config.UNIVIEW_MAX_IMAGE_BYTES;
    const bytes = await transport('GET', path, 'jpeg', maxBody, signal, config.UNIVIEW_SNAPSHOT_TIMEOUT_MS);
    try {
      const original = originalJpeg(bytes);
      if (original.length > config.UNIVIEW_MAX_IMAGE_BYTES) throw new UniviewClientError('limit');
      const { width, height } = jpegDimensions(original);
      if (width * height > config.UNIVIEW_MAX_PIXELS) throw new UniviewClientError('limit');
      // Copy only the original so a returned small JPEG does not retain padding RAM.
      return original.length === bytes.length ? bytes : Buffer.from(original);
    } catch (error) { if (error instanceof UniviewClientError) throw error; throw new UniviewClientError('invalid_response'); }
  }
  async function snapshot(channel: number, signal?: AbortSignal) {
    const id = parsed(channelSchema, channel, 'invalid_request');
    return admitted(() => jpeg(`/LAPI/V1.0/Channels/${id}/Media/Video/Streams/0/Snapshot`, signal, false));
  }
  async function historicalPicture(reference: HistoricalPictureReference, signal?: AbortSignal) {
    const ref = parsed(pictureReferenceSchema, reference, 'invalid_request');
    const maxSize = Math.min(config.UNIVIEW_MAX_BODY_BYTES, Math.ceil(config.UNIVIEW_MAX_IMAGE_BYTES / 3) * 4 + 65536);
    if (ref.Size > maxSize) throw new UniviewClientError('limit');
    const query = new URLSearchParams({ Type: String(ref.Type), Index: ref.Name, Size: String(ref.Size) });
    return admitted(() => jpeg(`/LAPI/V1.0/System/Picture?${query}`, signal, true));
  }
  async function withSmartSearch<T>(query: SmartSearchQuery, use: (session: SmartSearchSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const q = parsed(searchQuerySchema, query, 'invalid_request');
    if (searching) throw new UniviewClientError('busy');
    return admitted(async () => {
      searching = true;
      const controller = new AbortController();
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(config.UNIVIEW_REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      let id: number | undefined, closed = false, pending: Promise<unknown> | undefined, returned = 0;
      let result!: T; let failure: unknown; let failed = false, cleanupFailed = false;
      const budget = { remaining: Math.min(CLIENT_LIMITS.jsonBytes, config.UNIVIEW_MAX_BODY_BYTES) };
      const searchJson = <R>(method: 'GET' | 'PUT', path: string, schema: z.ZodType<R>, body?: unknown) =>
        json(method, path, schema, deadline, body, config.UNIVIEW_REQUEST_TIMEOUT_MS, budget);
      async function scoped<R>(work: () => Promise<R>): Promise<R> {
        if (closed || deadline.aborted) throw new UniviewClientError('aborted');
        if (pending) throw new UniviewClientError('busy');
        const running = work(); pending = running;
        try { return await running; } finally { if (pending === running) pending = undefined; }
      }
      try {
        const conditions = [
          { QryType: 4, QryCondition: 3, QryData: String(q.Begin) }, { QryType: 4, QryCondition: 4, QryData: String(q.End) },
          { QryType: 35, QryCondition: 7, QryData: String(q.ChannelID) },
          ...(q.AlarmType === undefined ? [] : [{ QryType: 8, QryCondition: 0, QryData: q.AlarmType }]),
          ...(q.ObjectType === undefined ? [] : [{ QryType: 97, QryCondition: 0, QryData: String(q.ObjectType) }]),
        ];
        id = (await searchJson('PUT', '/LAPI/V1.0/Channels/Smart/ObjectSearch/Start', startSchema, { Num: conditions.length, QueryInfos: conditions })).SearchID;
        const session: SmartSearchSession = {
          progress: () => scoped(() => searchJson('GET', `/LAPI/V1.0/Channels/Smart/ObjectSearch/Progress?SearchID=${id}`, progressSchema)),
          page: (options = {}) => scoped(async () => {
            const page = parsed(pageQuerySchema, options, 'invalid_request');
            const result = await searchJson('GET', `/LAPI/V1.0/Channels/Smart/ObjectSearch?SearchID=${id}&Limit=${page.Limit}&Offset=${page.Offset}`, searchPageSchema);
            if (result.Num > page.Limit || (result.Num && page.Offset + result.Num > result.Total)) throw new UniviewClientError('invalid_response');
            returned += result.Num;
            if (returned > CLIENT_LIMITS.searchResults) throw new UniviewClientError('limit');
            return result;
          }),
        };
        result = await bounded(Promise.resolve().then(() => use(session)), deadline);
      } catch (error) { failed = true; failure = error; } finally {
        closed = true; controller.abort();
        try {
          await pending?.catch(() => {});
          if (id !== undefined) {
            try { await json('DELETE', '/LAPI/V1.0/Channels/Smart/ObjectSearch/Stop', z.object({}).passthrough(), undefined, { SearchID: id }, config.UNIVIEW_SNAPSHOT_TIMEOUT_MS); }
            catch { cleanupFailed = true; }
          }
        } finally { searching = false; }
      }
      if (cleanupFailed) throw new UniviewClientError('search_cleanup_failed');
      if (failed) throw failure;
      return result;
    });
  }
  async function searchObjects(query: SmartSearchQuery, signal?: AbortSignal): Promise<SmartSearchEntry[]> {
    return withSmartSearch(query, async (session) => {
      while ((await session.progress()).Percent !== 100) await delay(100, undefined, { signal });
      const results: SmartSearchEntry[] = [];
      while (results.length < CLIENT_LIMITS.searchResults) {
        const page = await session.page({ Offset: results.length, Limit: 5 });
        if (page.Total > CLIENT_LIMITS.searchResults) throw new UniviewClientError('limit');
        results.push(...page.SmartObjectInfoList);
        if (results.length >= page.Total) return results;
        if (!page.Num) throw new UniviewClientError('invalid_response');
      }
      return results;
    }, signal);
  }
  async function accessZone(channel: number, signal?: AbortSignal) {
    const id = parsed(channelSchema, channel, 'invalid_request');
    return admitted(() => json('GET', `/LAPI/V1.0/Channels/${id}/Smart/AccessZone`, accessZoneSchema, signal));
  }
  async function recordings(channel: number, range: { Begin: number; End: number }, options: { Offset?: number; Limit?: number; Types?: number } = {}, signal?: AbortSignal) {
    const id = parsed(channelSchema, channel, 'invalid_request'), times = parsed(rangeSchema, range, 'invalid_request');
    const page = parsed(pageQuerySchema.extend({ Types: z.number().int().nonnegative().max(0xffffffff).optional() }), options, 'invalid_request');
    const query = new URLSearchParams({ Begin: String(times.Begin), End: String(times.End), Limit: String(page.Limit), Offset: String(page.Offset), ...(page.Types === undefined ? {} : { Types: String(page.Types) }) });
    return admitted(async () => {
      const result = await json('GET', `/LAPI/V1.0/Channels/${id}/Media/Video/Streams/0/Records?${query}`, recordsSchema, signal);
      if (result.Nums > page.Limit) throw new UniviewClientError('invalid_response');
      return result;
    });
  }
  async function recordingReference(channel: number, range: { Begin: number; End: number }, signal?: AbortSignal) {
    const id = parsed(channelSchema, channel, 'invalid_request'), times = parsed(rangeSchema, range, 'invalid_request');
    return admitted(() => json('GET', `/LAPI/V1.0/Channels/${id}/Media/Video/Streams/RecordURL?Begin=${times.Begin}&End=${times.End}`, recordReferenceSchema, signal));
  }
  async function videoStreams(channel: number, signal?: AbortSignal) {
    const id = parsed(channelSchema,channel,'invalid_request');
    return admitted(()=>json('GET',`/LAPI/V1.0/Channels/${id}/Media/Video/Streams/DetailInfos`,videoStreamsSchema,signal,undefined,
      Math.min(5000,config.UNIVIEW_REQUEST_TIMEOUT_MS),{remaining:131072}));
  }
  async function liveStreamReference(channel: number, profile: number, signal?: AbortSignal) {
    const id = parsed(channelSchema,channel,'invalid_request'), stream = parsed(z.number().int().min(0).max(2),profile,'invalid_request');
    // Returned URL is private source data. Never follow it or pass it to a browser.
    return admitted(()=>json('GET',`/LAPI/V1.0/Channels/${id}/Media/Video/Streams/${stream}/LiveStreamURL?TransProtocol=0`,recordReferenceSchema,signal,undefined,
      Math.min(2000,config.UNIVIEW_REQUEST_TIMEOUT_MS),{remaining:8192}));
  }
  async function cameraName(channel: number, signal?: AbortSignal) {
    const id = parsed(channelSchema, channel, 'invalid_request');
    const osd = await admitted(() => json('GET', `/LAPI/V1.0/Channels/${id}/Media/OSDs`, cameraOsdSchema, signal));
    const names = osd.ContentList.flatMap(v => v.ContentInfo).filter(v => v.ContentType === 12).map(v => v.Value.trim()).filter(Boolean);
    return names.length === 1 ? names[0]! : null;
  }
  return { cameraName, videoStreams, liveStreamReference, snapshot, historicalPicture, withSmartSearch, searchObjects, accessZone, recordings, recordingReference };
}
export type UniviewClient = ReturnType<typeof createUniviewClient>;

// Existing receiver/evidence contract remains unchanged and shares this transport.
export function createSnapshotClient(config: Config, request: typeof fetch = fetch): SnapshotClient {
  return createUniviewClient(config, request).snapshot;
}
