import type { Config } from '../config.js';
import { cameras } from '../uniview/verified-streams.js';
import { zonePreferenceInput, zonePreferenceSchema, ZonePreferenceConflict, type ZonePreferenceStore } from '../uniview/zone-preferences.js';
import { z } from 'zod';

// The development SQL pool stays read-only. Only this fixed metadata operation
// reaches the existing loopback production API; its bearer never reaches React.
export function developmentPreferenceWriter(config: Config, token: string | undefined, request: typeof fetch = fetch): ZonePreferenceStore['save'] {
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return undefined;
  return async (installation, channel, zoneId, input) => {
    const camera = cameras(config).find(c => c.channel === channel);
    if (installation !== config.UNIVIEW_INSTALLATION_ID || !camera) throw new Error('Unknown zone scope');
    const id = z.uuid().parse(zoneId), value = zonePreferenceInput.parse(input);
    const response = await request(`http://127.0.0.1:3000/api/cameras/${encodeURIComponent(camera.id)}/zones/${id}/preferences`, {
      method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(7000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      if (response.status === 409) throw new ZonePreferenceConflict('Zone configuration changed');
      throw new Error('Zone preferences unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Zone preferences unavailable');
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > 2048) throw new Error('Invalid preference response'); chunks.push(next.value);
    } } finally { await reader.cancel(); }
    const result = z.object({ preference: zonePreferenceSchema }).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (result.preference.zoneId !== id) throw new Error('Invalid preference response');
    return result.preference;
  };
}
