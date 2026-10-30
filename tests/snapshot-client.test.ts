import { expect, it, vi } from 'vitest';
import { createSnapshotClient } from '../src/uniview/snapshot-client.js';
import { config, jpeg } from './uniview-fixtures.js';
it('digest authentication and bounded JPEG streaming use memory-only requests', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'www-authenticate': 'Digest realm="NVR", nonce="nonce", qop="auth", algorithm=MD5' } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg' } }));
  const client = createSnapshotClient({ ...config, UNIVIEW_USERNAME: 'test', UNIVIEW_PASSWORD: 'secret' }, request);
  expect(await client(1, new AbortController().signal)).toEqual(jpeg);
  expect(request.mock.calls[1]![1]).toMatchObject({ redirect: 'error', headers: { authorization: expect.stringContaining('Digest username="test"') } });
});
it('rejects oversize JPEGs and failed/wrong-content responses', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg' } }))
    .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const client = createSnapshotClient({ ...config, UNIVIEW_USERNAME: 'test', UNIVIEW_PASSWORD: 'secret', UNIVIEW_MAX_IMAGE_BYTES: 1 }, request);
  await expect(client(1, new AbortController().signal)).rejects.toThrow('limit'); await expect(client(1, new AbortController().signal)).rejects.toThrow('unavailable');
});
