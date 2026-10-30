import { deliverySettings, deliveryPreview, testOutcome, deliverySave, testSend, DeliveryConfigurationError } from '../notifications/destination-contract.js';
import type { DeliveryStore } from '../notifications/destination.js';
import type { Config } from '../config.js';
// Fixed loopback forwarding, never an arbitrary browser URL or credential proxy.
// The encryption key and webhook credentials remain in the production-compatible API.
export function developmentDeliveryClient(config: Config, token: string | undefined, request: typeof fetch = fetch): DeliveryStore | undefined {
    if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
        return undefined;
    async function forward(installation: string, path: 'settings' | 'preview' | 'test', method: 'GET' | 'PUT' | 'POST', value?: unknown, signal?: AbortSignal) {
        if (installation !== config.UNIVIEW_INSTALLATION_ID)
            throw new Error('Unknown delivery scope');
        const response = await request('http://127.0.0.1:3000/api/notifications/delivery/' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('Missing delivery response');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                size += next.value.length;
                if (size > 65536)
                    throw new Error('Delivery response limit');
                chunks.push(next.value);
            }
        }
        finally {
            await reader.cancel();
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!response.ok) {
            const code = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error) ? data.error : 'delivery_configuration_unavailable';
            throw new DeliveryConfigurationError([400, 409, 410, 429, 503].includes(response.status) ? response.status : 503, code);
        }
        return data;
    }
    return { read: async (id) => deliverySettings.parse(await forward(id, 'settings', 'GET')), save: async (id, input) => deliverySettings.parse(await forward(id, 'settings', 'PUT', deliverySave.parse(input))), preview: async (id) => deliveryPreview.parse(await forward(id, 'preview', 'POST', {})), test: async (id, confirmation, signal) => testOutcome.parse(await forward(id, 'test', 'POST', testSend.parse({ confirmation, confirmed: true }), signal)) };
}
