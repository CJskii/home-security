import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, sessionEvents, formatTime, display } from '@/lib/api';
import { deliverySettingsSchema, deliveryPreviewSchema, testResultSchema } from '@/lib/notification-delivery';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
async function send(path: string, method: 'POST' | 'PUT', body: unknown) { const r = await fetch('/api/notifications/delivery/' + path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) {
    if (r.status === 401)
        sessionEvents.dispatchEvent(new Event('ended'));
    throw new ApiError(r.status);
} return r.json() as Promise<unknown>; }
export function NotificationDelivery() {
    const client = useQueryClient(), query = useQuery({ queryKey: ['notification-delivery'], queryFn: ({ signal }) => api('/api/notifications/delivery/settings', deliverySettingsSchema, signal), refetchInterval: q => q.state.data?.tests.some(t => t.state === 'SENDING') ? 2000 : false });
    const [url, setUrl] = useState<string | null>(null), [secret, setSecret] = useState(''), [http, setHttp] = useState(false), [confirm, setConfirm] = useState(false), [copy, setCopy] = useState<string | null>(null);
    const data = query.data, value = url ?? data?.configured?.url ?? '', dirty = url !== null || secret.length > 0;
    const preview = useMutation({ mutationFn: async () => deliveryPreviewSchema.parse(await send('preview', 'POST', {})) });
    const save = useMutation({ mutationFn: async () => deliverySettingsSchema.parse(await send('settings', 'PUT', { expectedRevision: data?.revision, url: value, acknowledgeHttp: http, ...(secret ? { signingSecret: secret } : {}) })), onSuccess: next => { client.setQueryData(['notification-delivery'], next); setUrl(null); setHttp(false); preview.reset(); }, onSettled: () => setSecret('') });
    const test = useMutation({ retry: false, mutationFn: async () => { if (!preview.data)
            throw Error('Preview required'); return testResultSchema.parse(await send('test', 'POST', { confirmation: preview.data.confirmation, confirmed: true })); }, onSettled: () => { void client.invalidateQueries({ queryKey: ['notification-delivery'] }); } });
    const busy = save.isPending || test.isPending || preview.isPending;
    const resetPreview = () => { preview.reset(); test.reset(); setCopy(null); setConfirm(false); };
    return <section aria-label="Notification delivery configuration" className="space-y-3 border-t pt-4">
  <h3 className="font-medium">Delivery</h3>
  <p role="status" className="rounded border border-amber-400/30 p-3 text-amber-200">Automatic delivery requires the saved global preference, an armed producer with a start cutoff, and the separately managed worker. This page cannot start a worker. Saving URL or credentials disarms the producer; a manual TEST requires separate confirmation.</p>
  {query.isPending && <p>Loading delivery configuration…</p>}
  {query.isError && <p role="alert">Delivery configuration unavailable. A compatible API, migration and server configuration are required.</p>}
  {data && <>
   {!data.available && <p role="status">Webhook settings migration required. No test can be sent.</p>}
   {!data.writable && data.available && <p role="status">An operator must provision the separate encryption key and approve an exact destination URL/IP before settings can be saved.</p>}
   <p>Saved global preference: {data.globalDeliveryEnabled ? 'on' : 'off'} · producer {data.producerEnabled ? 'armed' : 'disarmed'} · signing secret {data.secretConfigured ? 'saved (hidden)' : 'not configured'}</p>
   <form onSubmit={e => { e.preventDefault(); save.mutate(); }} className="space-y-3">
    <fieldset disabled={!data.available || !data.writable || busy} className="space-y-3 disabled:opacity-60">
     <div className="space-y-2"><Label htmlFor="delivery-url">Webhook destination URL</Label><Input id="delivery-url" type="url" required value={value} list="approved-webhook-urls" placeholder="http://192.168.50.20:8123/api/webhook/home-security" onChange={e => { setUrl(e.target.value); setHttp(false); save.reset(); resetPreview(); }}/><datalist id="approved-webhook-urls">{data.approved.map(p => <option key={p.url} value={p.url}/>)}</datalist></div>
     <p className="text-muted-foreground">One endpoint for every camera. Only an operator-approved exact URL and pinned IP can be saved. Redirects are never followed. HTTPS verifies the certificate and hostname; a private CA must be trusted on the server.</p>
     {value.startsWith('http:') && <Label className="flex gap-2"><Input type="checkbox" className="size-4" checked={http} onChange={e => setHttp(e.target.checked)}/>I explicitly accept unencrypted HTTP to this approved LAN endpoint. HMAC authenticates the body; it does not encrypt it.</Label>}
     <div className="space-y-2"><Label htmlFor="delivery-secret">New signing secret {data.secretConfigured ? '(leave blank to retain saved secret)' : '(required)'}</Label><Input id="delivery-secret" type="password" autoComplete="new-password" value={secret} minLength={32} maxLength={256} pattern="[A-Za-z0-9_-]{32,256}" onChange={e => { setSecret(e.target.value); resetPreview(); }} placeholder={data.secretConfigured ? 'Saved secret is never returned' : '32–256 URL-safe characters'}/></div>
     <div className="flex gap-2"><Button size="sm" type="submit" disabled={!dirty}>{save.isPending ? 'Saving destination…' : 'Save destination'}</Button><Button size="sm" type="button" variant="outline" disabled={!dirty} onClick={() => { setUrl(null); setSecret(''); setHttp(false); save.reset(); resetPreview(); }}>Cancel destination</Button></div>
    </fieldset>
   </form>
   {save.isSuccess && <p role="status">Destination saved. Producer remains disarmed; no webhook was sent.</p>}
   {save.isError && <p role="alert">Destination not saved ({save.error.message}). Check operator approval, HTTP acknowledgement, secret and revision. Re-enter a replacement secret if needed.</p>}
   {data.configured && <p>Saved URL: {data.configured.url} · pinned {data.configured.address} · revision {data.revision}{data.updatedAt ? ` · ${formatTime(data.updatedAt)}` : ''}</p>}
   <Button size="sm" variant="outline" disabled={!data.available || !data.writable || !data.secretConfigured || !data.configured || dirty || busy} onClick={() => { test.reset(); setCopy(null); preview.mutate(); }}>Preview TEST payload</Button>
   {preview.isError && <p role="alert">Preview unavailable ({preview.error.message}). Save a valid destination and verify the server signing configuration.</p>}
   {preview.data && !dirty && <div className="space-y-3">
    <p>Exact TEST wire JSON · no real event, image or delivery job is created by preview. Confirmation expires {formatTime(preview.data.expiresAt)}.</p>
    <pre data-testid="webhook-wire-body" className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted p-3">{preview.data.body}</pre>
    <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(preview.data!.body).then(() => setCopy('Payload copied.'), () => setCopy('Clipboard unavailable. Select and copy the JSON.')); }}>Copy payload</Button>{copy && <p role="status">{copy}</p>}
    <details><summary className="cursor-pointer">HMAC headers and signing format</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3">{Object.entries(preview.data.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre><p className="mt-2">Sign timestamp + "." + Idempotency-Key + "." + exact raw JSON body with HMAC-SHA256. The saved secret is never shown.</p></details>
    <Button size="sm" disabled={busy || preview.data.revision !== data.revision} onClick={() => setConfirm(true)}>Test webhook</Button>
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>Send one TEST webhook?</DialogTitle><DialogDescription>This contacts {preview.data.destination} using the saved signing secret, even while live delivery is OFF. The receiver may send one TEST notification to its configured test phone. No real event or rule is processed, and automatic delivery settings are unchanged.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>Cancel test</Button><Button disabled={test.isPending} onClick={() => { setConfirm(false); test.mutate(); }}>Send TEST webhook</Button></DialogFooter></DialogContent></Dialog>
   </div>}
   {test.isPending && <p role="status">Sending one TEST request…</p>}
   {test.isError && <p role="alert">Test action did not return ({test.error.message}). Check recent TEST attempts before preparing a new test; an interrupted request may have reached the receiver.</p>}
   {test.data && <p role="status">TEST {test.data.state === 'DELIVERED' ? 'acknowledged' : display(test.data.state)} · HTTP {test.data.httpStatus ?? 'unavailable'} · {test.data.durationMs ?? 'unknown'} ms · {formatTime(test.data.at)} · {display(test.data.code ?? 'in progress')}. This does not confirm a phone notification.</p>}
   <details open={data.tests.length > 0}><summary className="cursor-pointer">Recent TEST attempts ({data.tests.length})</summary><p className="mt-2 text-muted-foreground">Separate from live event delivery. One explicit test per minute, no automatic retries. Reusing a confirmation returns the same attempt.</p><ul className="mt-2 space-y-2">{data.tests.map(t => <li key={t.id} className="rounded border p-2">TEST · {formatTime(t.at)} · {t.state === 'DELIVERED' ? 'acknowledged' : display(t.state)} · HTTP {t.httpStatus ?? 'unavailable'} · {t.durationMs ?? 'unknown'} ms · {display(t.code ?? 'in progress')}{t.state === 'UNCERTAIN' && <p className="text-amber-200">The request may have been accepted. Check the receiver before sending a new test.</p>}<p className="break-all text-muted-foreground">{t.id}</p></li>)}</ul></details>
  </>}
 </section>;
}
