import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationDelivery } from './notification-delivery';
const url = 'http://192.168.50.20:8123/api/webhook/home-security', at = '2026-10-21T12:00:00.000Z', id = '10000000-0000-4000-8000-000000000001', wire = '{"version":1,"type":"security.test","test":true,"eventId":null}', headers = { 'Content-Type': 'application/json', 'X-Home-Security-Test': 'true', 'X-Home-Security-Signature': 'sha256=<HMAC-SHA256 hex; saved secret never displayed>' };
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
function setup(writable = true) {
    let revision = 1;
    const snapshot = () => ({ available: true, writable, revision, updatedAt: at, configured: { url, address: '192.168.50.20', allowLanHttp: true }, secretConfigured: true, approved: [{ url, address: '192.168.50.20', allowLanHttp: true }], globalDeliveryEnabled: false, producerEnabled: false, automaticDeliveryAvailable: false, tests: [] });
    const request = vi.fn<typeof fetch>(async (input, init) => { if (init?.method === 'PUT') {
        revision++;
        return Response.json(snapshot());
    } if (String(input).endsWith('/preview'))
        return Response.json({ payload: JSON.parse(wire), body: wire, confirmation: 'opaque-confirmation', expiresAt: at, destination: url, headers, revision }); if (String(input).endsWith('/test'))
        return Response.json({ id, state: 'DELIVERED', at, httpStatus: 200, code: 'acknowledged', durationMs: 20, receipt: 'accepted', mayHaveReached: true }); return Response.json(snapshot()); });
    vi.stubGlobal('fetch', request);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NotificationDelivery /></QueryClientProvider>);
    return { request };
}
it('shows global OFF, hidden saved secret and HTTP acceptance; Cancel never writes and Save never tests', async () => {
    const f = setup(), field = await screen.findByLabelText(/New signing secret/);
    expect((field as HTMLInputElement).value).toBe('');
    expect((field as HTMLInputElement).type).toBe('password');
    expect(screen.getByText(/Saved global preference: off · producer disarmed/)).toBeTruthy();
    await userEvent.type(field, 's'.repeat(48));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel destination' }));
    expect((field as HTMLInputElement).value).toBe('');
    expect(f.request.mock.calls.some(([, v]) => v?.method === 'PUT')).toBe(false);
    await userEvent.type(field, 's'.repeat(48));
    await userEvent.click(screen.getByRole('checkbox', { name: /I explicitly accept unencrypted HTTP/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save destination' }));
    await screen.findByText(/Destination saved. Producer remains disarmed/);
    const call = f.request.mock.calls.find(([, v]) => v?.method === 'PUT');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ expectedRevision: 1, url, signingSecret: 's'.repeat(48), acknowledgeHttp: true });
    expect((field as HTMLInputElement).value).toBe('');
    expect(f.request.mock.calls.some(([p]) => String(p).endsWith('/test'))).toBe(false);
    expect(document.body.textContent).not.toContain('s'.repeat(48));
});
it('previews/copies exact server wire JSON and sends only after explicit confirmation, even with global OFF', async () => {
    const clipboard = vi.fn(async () => { });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const f = setup();
    await screen.findByRole('button', { name: 'Preview TEST payload' });
    await userEvent.click(screen.getByRole('button', { name: 'Preview TEST payload' }));
    expect((await screen.findByTestId('webhook-wire-body')).textContent).toBe(wire);
    await userEvent.click(screen.getByRole('button', { name: 'Copy payload' }));
    expect(clipboard).toHaveBeenCalledWith(wire);
    await userEvent.click(screen.getByText('HMAC headers and signing format'));
    expect(screen.getByText(/sha256=<HMAC-SHA256/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Test webhook' }));
    expect(f.request.mock.calls.some(([p]) => String(p).endsWith('/test'))).toBe(false);
    const dialog = screen.getByRole('dialog', { name: 'Send one TEST webhook?' });
    expect(within(dialog).getByText(/may send one TEST notification/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel test' }));
    expect(f.request.mock.calls.some(([p]) => String(p).endsWith('/test'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Test webhook' }));
    await userEvent.dblClick(screen.getByRole('button', { name: 'Send TEST webhook' }));
    await screen.findByText(/TEST acknowledged · HTTP 200 · 20 ms/);
    expect(screen.getByText(/This does not confirm a phone notification/)).toBeTruthy();
    const calls = f.request.mock.calls.filter(([p]) => String(p).endsWith('/test'));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ confirmation: 'opaque-confirmation', confirmed: true });
    expect(f.request.mock.calls.some(([, v]) => v?.method === 'PUT')).toBe(false);
});
it('invalidates a preview when destination or secret changes and keeps testing unavailable until saved', async () => {
    const f = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Preview TEST payload' }));
    await screen.findByRole('button', { name: 'Test webhook' });
    await userEvent.type(screen.getByLabelText(/New signing secret/), 'z'.repeat(48));
    expect(screen.queryByRole('button', { name: 'Test webhook' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Preview TEST payload' }) as HTMLButtonElement).disabled).toBe(true);
    expect(f.request.mock.calls.some(([p]) => String(p).endsWith('/test'))).toBe(false);
});
it('shows server setup requirements and disables controls without a key/approval', async () => {
    setup(false);
    await screen.findByText(/An operator must provision the separate encryption key/);
    expect(screen.getByRole('button', { name: 'Save destination' }).matches(':disabled')).toBe(true);
    expect((screen.getByRole('button', { name: 'Preview TEST payload' }) as HTMLButtonElement).disabled).toBe(true);
});
it('reports ambiguous HTTP 200 or failed test actions without retrying or claiming phone delivery', async () => {
    const f = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Preview TEST payload' }));
    await screen.findByRole('button', { name: 'Test webhook' });
    f.request.mockImplementationOnce(async () => Response.json({ id, state: 'UNCERTAIN', at, httpStatus: 200, code: 'invalid_receipt', durationMs: 30, receipt: null, mayHaveReached: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Test webhook' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send TEST webhook' }));
    await screen.findByText(/TEST Uncertain · HTTP 200 · 30 ms/i);
    expect(screen.getByText(/This does not confirm a phone notification/)).toBeTruthy();
    await waitFor(() => expect(f.request.mock.calls.filter(([p]) => String(p).endsWith('/test'))).toHaveLength(1));
});
