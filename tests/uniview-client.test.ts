import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createUniviewClient, UniviewClientError, type SmartSearchSession } from '../src/uniview/snapshot-client.js';
import fixture from './fixtures/uniview-client.json' with { type: 'json' };
import { config, jpeg } from './uniview-fixtures.js';

const settings = { ...config, UNIVIEW_USERNAME: 'test', UNIVIEW_PASSWORD: 'secret' };
const query = { ChannelID: 1, Begin: 1700000000, End: 1700000030, AlarmType: 'EnterArea', ObjectType: 2 };
const json = (Data: unknown, StatusCode = 0) => new Response(JSON.stringify({ Response: { ResponseCode: 0, StatusCode, Data } }), { headers: { 'content-type': 'application/json;CHARset=utf-8' } });
const image = (body = jpeg, headers: Record<string, string> = {}) => new Response(new Uint8Array(body), { headers: { 'content-type': 'image/jpeg', ...headers } });
const challenge = (algorithm = 'MD5') => new Response(null, { status: 401, headers: { 'www-authenticate': `Digest realm="NVR", nonce="nonce", qop="auth", algorithm=${algorithm}` } });
function searches(page = fixture.searchPage) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    const path = String(url);
    if (options?.method === 'PUT') return json(fixture.searchStart);
    if (options?.method === 'DELETE') return json({});
    return json(path.includes('/Progress?') ? fixture.searchProgress : page);
  });
}
afterEach(() => vi.useRealTimers());

it.each([1, 2] as const)('retrieves Type %i by exact Name/Size without fetching the source URL or re-encoding JPEGs', async (Type) => {
  // Embedded APP data contains its own EOI: it must not truncate the main image.
  const embedded = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225, 0, 6, 255, 217, 1, 2]), jpeg.subarray(2)]);
  const body = Buffer.concat([embedded, Buffer.from([0, 255, 217, 123])]);
  const request = vi.fn<typeof fetch>().mockResolvedValue(image(body, { 'content-length': String(body.length) }));
  const bytes = await createUniviewClient(settings, request).historicalPicture({ Type, Name: 'exact name&part', Size: 12345 });
  expect(bytes).toEqual(embedded);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(embedded).digest('hex'));
  expect(request.mock.calls[0]![0]).toBe(`http://10.0.0.1/LAPI/V1.0/System/Picture?Type=${Type}&Index=exact+name%26part&Size=12345`);
  expect(request).toHaveBeenCalledOnce();
});

it.each(['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'])('signs the exact method and query using %s Digest', async (algorithm) => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(challenge(algorithm)).mockResolvedValueOnce(image());
  await createUniviewClient(settings, request).historicalPicture({ Type: 2, Name: 'fixture_crop', Size: 40 });
  const [url, options] = request.mock.calls[1]!;
  const auth = (options!.headers as Record<string, string>).authorization!;
  const params = Object.fromEntries([...auth.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
  const path = new URL(String(url)).pathname + new URL(String(url)).search;
  const hash = (s: string) => createHash(algorithm.startsWith('MD5') ? 'md5' : 'sha256').update(s).digest('hex');
  let ha1 = hash('test:NVR:secret');
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:nonce:${params.cnonce}`);
  expect(params.uri).toBe(path);
  expect(params.response).toBe(hash(`${ha1}:nonce:00000001:${params.cnonce}:auth:${hash(`GET:${path}`)}`));
  expect(options!.redirect).toBe('error');
});

it('uses method-aware Digest for search start/stop and releases the exact owned session', async () => {
  const seen: RequestInit[] = [];
  const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    if (!(options!.headers as Record<string, string>).authorization) return challenge();
    seen.push(options!);
    return options!.method === 'PUT' ? json(fixture.searchStart) : json({});
  });
  await createUniviewClient(settings, request).withSmartSearch(query, async () => 'done');
  expect(seen.map((r) => r.method)).toEqual(['PUT', 'DELETE']);
  expect(JSON.parse(String(seen[0]!.body))).toEqual({ Num: 5, QueryInfos: [
    { QryType: 4, QryCondition: 3, QryData: '1700000000' }, { QryType: 4, QryCondition: 4, QryData: '1700000030' },
    { QryType: 35, QryCondition: 7, QryData: '1' }, { QryType: 8, QryCondition: 0, QryData: 'EnterArea' }, { QryType: 97, QryCondition: 0, QryData: '2' },
  ] });
  expect(JSON.parse(String(seen[1]!.body))).toEqual({ SearchID: 7 });
  // A wrong GET-only implementation produces a different Digest for PUT/DELETE.
  for (const option of seen) {
    const auth = (option.headers as Record<string, string>).authorization!;
    const params = Object.fromEntries([...auth.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const hash = (s: string) => createHash('md5').update(s).digest('hex');
    expect(params.response).toBe(hash(`${hash('test:NVR:secret')}:nonce:00000001:${params.cnonce}:auth:${hash(`${option.method}:${params.uri}`)}`));
  }
});

it('returns typed source fields, inline synthetic data and paginated results without deriving labels or zones', async () => {
  const page = structuredClone(fixture.searchPage);
  Object.assign(page.SmartObjectInfoList[0]!.FullPicture, { Data: jpeg.toString('base64') });
  page.Total = 2;
  const request = searches(page);
  request.mockImplementation(async (url, options) => {
    if (options?.method === 'PUT') return json(fixture.searchStart);
    if (options?.method === 'DELETE') return json({});
    if (String(url).includes('/Progress?')) return json(fixture.searchProgress);
    return json({ ...page, SmartObjectInfoList: [{ ...page.SmartObjectInfoList[0], RecordID: String(url).includes('Offset=0') ? 'first' : 'second' }] });
  });
  const results = await createUniviewClient(settings, request).searchObjects(query);
  expect(results.map((v) => v.RecordID)).toEqual(['first', 'second']);
  expect(results[0]!.ObjectList[0]!.ObjectInfo.PersonInfo!.Position).toBe('2000,3000;4000,8000');
  expect(results[0]!.FullPicture).toMatchObject({ Name: 'fixture_full', Data: jpeg.toString('base64'), URL: 'http://invalid/untrusted-reference' });
  expect(request.mock.calls.every(([url]) => String(url).startsWith('http://10.0.0.1/LAPI/'))).toBe(true);
  expect(request.mock.calls.at(-1)![1]!.method).toBe('DELETE');
});

it.each(['callback', 'progress', 'page', 'limit', 'abort'] as const)('cleans up on %s failure and invalidates escaped session handles', async (failure) => {
  const request = searches(); const abort = new AbortController();
  if (failure === 'progress') request.mockImplementation(async (_url, options) => options?.method === 'PUT' ? json(fixture.searchStart) : options?.method === 'DELETE' ? json({}) : json({}, 50808));
  if (failure === 'page') request.mockImplementation(async (_url, options) => options?.method === 'PUT' ? json(fixture.searchStart) : options?.method === 'DELETE' ? json({}) : json({ Num: 5, Total: 5, SmartObjectInfoList: [] }));
  const client = createUniviewClient(settings, request); let escaped!: SmartSearchSession;
  await expect(client.withSmartSearch(query, async (session) => {
    escaped = session;
    if (failure === 'abort') { abort.abort(); await session.progress(); }
    else if (failure === 'progress') await session.progress();
    else if (failure === 'page') await session.page();
    else if (failure === 'limit') await session.page({ Limit: 21 });
    else throw new Error('callback failed');
  }, abort.signal)).rejects.toThrow();
  expect(request.mock.calls.at(-1)![1]).toMatchObject({ method: 'DELETE', body: '{"SearchID":7}' });
  expect(request.mock.calls.at(-1)![1]!.signal!.aborted).toBe(false);
  const count = request.mock.calls.length;
  await expect(escaped.page()).rejects.toMatchObject({ code: 'aborted' });
  expect(request).toHaveBeenCalledTimes(count);
});

it('reports failed cleanup and releases local admission without pretending the remote session stopped', async () => {
  const request = searches();
  request.mockImplementation(async (_url, options) => options?.method === 'PUT' ? json(fixture.searchStart) : json({}, 1));
  const client = createUniviewClient(settings, request);
  await expect(client.withSmartSearch(query, async () => {})).rejects.toMatchObject({ code: 'search_cleanup_failed' });
  request.mockResolvedValue(image());
  expect(await client.snapshot(1)).toEqual(jpeg);
});

it('does not guess a session ID or retry an uncertain Start response', async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('private connection details'));
  const callback = vi.fn();
  await expect(createUniviewClient(settings, request).withSmartSearch(query, callback)).rejects.toMatchObject({ code: 'unavailable' });
  expect(callback).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]![1]!.method).toBe('PUT');
});

it('caps total search results and refuses stalled pagination rather than looping', async () => {
  for (const page of [{ ...fixture.searchPage, Total: 101 }, { Num: 0, Total: 1, SmartObjectInfoList: [] }]) {
    const request = searches();
    request.mockImplementation(async (url, options) => options?.method === 'PUT' ? json(fixture.searchStart) : options?.method === 'DELETE' ? json({}) : String(url).includes('/Progress?') ? json(fixture.searchProgress) : json(page));
    await expect(createUniviewClient(settings, request).searchObjects(query)).rejects.toBeInstanceOf(UniviewClientError);
    expect(request.mock.calls.at(-1)![1]!.method).toBe('DELETE');
  }
});

it('reads both cameras and recording metadata through fixed GET paths only', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture.accessZone)).mockResolvedValueOnce(json(fixture.accessZone))
    .mockResolvedValueOnce(json(fixture.recordings)).mockResolvedValueOnce(json(fixture.recordingReference));
  const client = createUniviewClient(settings, request);
  expect(await client.accessZone(1)).toEqual(fixture.accessZone);
  expect(await client.accessZone(2)).toEqual(fixture.accessZone);
  const range = { Begin: query.Begin, End: query.End };
  expect(await client.recordings(1, range, { Types: 67108864 })).toEqual(fixture.recordings);
  expect(await client.recordingReference(2, range)).toEqual(fixture.recordingReference);
  expect(request.mock.calls.map(([url]) => String(url).replace('http://10.0.0.1', ''))).toEqual([
    '/LAPI/V1.0/Channels/1/Smart/AccessZone', '/LAPI/V1.0/Channels/2/Smart/AccessZone',
    '/LAPI/V1.0/Channels/1/Media/Video/Streams/0/Records?Begin=1700000000&End=1700000030&Limit=5&Offset=0&Types=67108864',
    '/LAPI/V1.0/Channels/2/Media/Video/Streams/RecordURL?Begin=1700000000&End=1700000030',
  ]);
  expect(request.mock.calls.every(([, options]) => options!.method === 'GET')).toBe(true);
});

it.each(['-1', '3.5', '9007199254740992', '999999999', '1'])('rejects malformed, oversized or mismatched HTTP length %s safely', async (length) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(image(jpeg, { 'content-length': length }));
  await expect(createUniviewClient(settings, request).snapshot(1)).rejects.toBeInstanceOf(UniviewClientError);
});

it('bounds chunked bodies and rejects malformed JPEG/JSON, protocol errors and unexpected content', async () => {
  const cases = [image(jpeg.subarray(0, jpeg.length - 2)), image(Buffer.from([255, 216, 255, 225, 255, 255])),
    json({}, 50808), new Response('{"Response":{},"Response":{}}', { headers: { 'content-type': 'application/json' } }),
    new Response('private NVR text', { status: 500 })];
  for (const response of cases) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = createUniviewClient(settings, request);
    const method = response.headers.get('content-type')?.startsWith('image/') ? client.snapshot(1) : client.accessZone(1);
    await expect(method).rejects.toThrow(/^NVR /);
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(image());
  await expect(createUniviewClient({ ...settings, UNIVIEW_MAX_IMAGE_BYTES: 4 }, request).snapshot(1)).rejects.toMatchObject({ code: 'limit' });
});

it('rejects invalid paths, ranges and references without issuing requests', async () => {
  const request = vi.fn<typeof fetch>(); const client = createUniviewClient(settings, request);
  await expect(client.snapshot(-1)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(client.historicalPicture({ Type: 1, Name: 'bad\nname', Size: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(client.historicalPicture({ Type: 2, Name: 'fixture', Size: -1 })).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(client.recordings(1, { Begin: 100, End: 99 })).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(client.searchObjects({ ...query, End: query.Begin + 86401 })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(request).not.toHaveBeenCalled();
});

it('bounds transport and scoped callback deadlines; cleanup uses a fresh timeout', async () => {
  const request = searches(); const client = createUniviewClient({ ...settings, UNIVIEW_REQUEST_TIMEOUT_MS: 10 }, request);
  const outcome = expect(client.withSmartSearch(query, () => new Promise(() => {}))).rejects.toMatchObject({ code: 'timeout' });
  await outcome;
  expect(request.mock.calls.at(-1)![1]!.method).toBe('DELETE');
  const hanging = vi.fn<typeof fetch>(() => new Promise(() => {}));
  await expect(createUniviewClient({ ...settings, UNIVIEW_SNAPSHOT_TIMEOUT_MS: 10 }, hanging).snapshot(1)).rejects.toMatchObject({ code: 'timeout' });
});

it('caps cumulative search JSON bytes and still stops the session after the budget is exhausted', async () => {
  const request = searches(); const client = createUniviewClient({ ...settings, UNIVIEW_MAX_BODY_BYTES: 300 }, request);
  await expect(client.withSmartSearch(query, async (session) => {
    for (let i = 0; i < 10; i++) await session.progress();
  })).rejects.toMatchObject({ code: 'limit' });
  expect(request.mock.calls.at(-1)![1]!.method).toBe('DELETE');
});

it('cancels stalled response bodies on deadline and releases request admission', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([255, 216])); }, cancel });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'image/jpeg' } })).mockResolvedValueOnce(image());
  const client = createUniviewClient({ ...settings, UNIVIEW_MAX_CONCURRENT_UPLOADS: 1, UNIVIEW_SNAPSHOT_TIMEOUT_MS: 10 }, request);
  await expect(client.snapshot(1)).rejects.toMatchObject({ code: 'timeout' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(await client.snapshot(1)).toEqual(jpeg);
});

it('preserves raw motor-vehicle subtype codes and reports source status without response bodies', async () => {
  const page = structuredClone(fixture.searchPage);
  Object.assign(page.SmartObjectInfoList[0]!.ObjectList[0]!.ObjectInfo, { ObjectType: 4,
    VehicleInfo: { Position: '1000,2000;8000,4000', VehicleAttributeInfo: { Type: 998 } } });
  const result = await createUniviewClient(settings, searches(page)).searchObjects({ ...query, ObjectType: 4 });
  expect(result[0]!.ObjectList[0]!.ObjectInfo).toMatchObject({ ObjectType: 4, VehicleInfo: { VehicleAttributeInfo: { Type: 998 } } });
  const request = vi.fn<typeof fetch>().mockResolvedValue(json({ private: 'private-source-content' }, 50808));
  const error = await createUniviewClient(settings, request).accessZone(1).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: 'nvr_error', sourceStatusCode: 50808 });
  expect(String(error)).not.toContain('private-source-content');
});

it('bounds JSON bodies, JPEG pixels and declared picture size before allocating or returning media', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture.accessZone)).mockResolvedValueOnce(image());
  const client = createUniviewClient({ ...settings, UNIVIEW_MAX_BODY_BYTES: 10, UNIVIEW_MAX_PIXELS: 10 }, request);
  await expect(client.accessZone(1)).rejects.toMatchObject({ code: 'limit' });
  await expect(client.snapshot(1)).rejects.toMatchObject({ code: 'limit' });
  await expect(client.historicalPicture({ Type: 1, Name: 'fixture', Size: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: 'limit' });
  expect(request).toHaveBeenCalledTimes(2);
});

it('rejects unsupported Digest challenges with a single attempt and no plaintext credentials', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(challenge('SHA-512'));
  await expect(createUniviewClient(settings, request).snapshot(1)).rejects.toMatchObject({ code: 'authentication' });
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]![1]!.headers).not.toHaveProperty('authorization');
});

it('reports explicit HTTP missing statuses without interpreting them as permanent expiry', async () => {
  for (const status of [404, 410]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private error body', { status }));
    await expect(createUniviewClient(settings, request).historicalPicture({ Type: 1, Name: 'fixture_full', Size: 40 }))
      .rejects.toMatchObject({ code: 'unavailable', httpStatus: status });
  }
});

it('reserves bounded admission for an entire search and rejects concurrent searches without creating extra sessions', async () => {
  const request = searches(); const client = createUniviewClient({ ...settings, UNIVIEW_MAX_CONCURRENT_UPLOADS: 1 }, request);
  let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const running = client.withSmartSearch(query, async () => { entered(); await hold; });
  await ready;
  await expect(client.withSmartSearch(query, async () => {})).rejects.toMatchObject({ code: 'busy' });
  await expect(client.snapshot(1)).rejects.toMatchObject({ code: 'busy' });
  release(); await running;
  expect(request.mock.calls.filter(([, o]) => o!.method === 'PUT')).toHaveLength(1);
  expect(request.mock.calls.at(-1)![1]!.method).toBe('DELETE');
});
