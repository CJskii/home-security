import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, display, formatTime } from '@/lib/api';
import { historySchema } from '@/lib/notifications';
import { Button } from './ui/button';
export function NotificationHistory() {
    const query = useInfiniteQuery({ queryKey: ['notification-history'], initialPageParam: null as string | null,
        queryFn: ({ pageParam, signal }) => api('/api/notifications/history' + (pageParam ? '?before=' + encodeURIComponent(pageParam) : ''), historySchema, signal), getNextPageParam: last => last.nextCursor ?? undefined });
    const current = query.data?.pages[0];
    return <section aria-label="Notification delivery history" className="space-y-3 border-t pt-4">
  <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Delivery history</h3><Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh history</Button></div>
  {query.isPending && <p>Loading delivery history…</p>}
  {query.isError && <p role="alert">Delivery history unavailable. A compatible API and migration are required.</p>}
  {current && <>
   <p role="status">{!current.available ? 'Delivery ledger migration required.' : !current.producerEnabled ? 'Delivery disabled · live event capture is disarmed.' : 'Live event ledger armed · sending additionally requires a separately configured worker.'} Saved global preference: {current.deliveryEnabled ? 'on' : 'off'}. This view cannot start delivery.</p>
   {!current.items.length && <p className="text-muted-foreground">No live evaluation records. Read-only previews remain separate from delivery history; historical events are never queued by opening this page.</p>}
   {query.data?.pages.flatMap(page => page.items).map(item => <details key={item.id} className="rounded border p-3">
    <summary className="cursor-pointer">{formatTime(item.receivedAt ?? item.createdAt)} · Camera {item.channel ?? 'unknown'} · {display(item.intent?.state ?? item.state)} · {item.intent?.attemptCount ?? 0} attempts</summary>
    <div className="mt-3 space-y-2">
     <Link className="underline" to={`/explore?event=${item.eventId}`}>Open canonical event</Link>
     {item.deliveryHeldReason && <p>Held: {display(item.deliveryHeldReason)}</p>}
     <ul className="space-y-2">{item.decisions.map(d => <li key={d.ruleId}><strong>{d.ruleName}</strong> · {display(d.outcome)} · {display(d.reason)}{d.cooldownUntil?` · until ${formatTime(d.cooldownUntil)}`:''}{d.reservationId?' · another intent is pending':''}<p className="break-all text-muted-foreground">{d.objectIds.length} source objects · {d.zoneVersionIds.length} zone versions · scope {d.scopeKey}</p></li>)}</ul>
     {item.intent && <><p>Created {formatTime(item.intent.createdAt)}{item.intent.deliveredAt ? ` · acknowledged ${formatTime(item.intent.deliveredAt)}` : ''}{item.intent.lastError ? ` · ${display(item.intent.lastError)}` : ''}</p>
      {item.intent.state === 'UNCERTAIN' && <p className="text-amber-200">The receiver may have accepted this event. Automatic retries are held pending reconciliation.</p>}
      {item.intent.enrichment && <div className="border-l pl-3"><p>AI text update · {display(item.intent.enrichment.state)} · {item.intent.enrichment.attemptCount} attempts{item.intent.enrichment.lastError?` · ${display(item.intent.enrichment.lastError)}`:''}</p><ul>{item.intent.enrichment.attempts.map(a=><li key={a.ordinal}>Update attempt {a.ordinal} · {display(a.outcome)}{a.httpStatus?` · HTTP ${a.httpStatus}`:''}{a.durationMs!==null?` · ${a.durationMs} ms`:''}</li>)}</ul><p className="break-all text-muted-foreground">Update ledger {item.intent.enrichment.id} · same notification tag · no additional cooldown</p></div>}
      <ul>{item.intent.attempts.map(a => <li key={a.ordinal}>Attempt {a.ordinal} · {formatTime(a.startedAt)} · {display(a.outcome)}{a.httpStatus ? ` · HTTP ${a.httpStatus}` : ''}{a.errorCode ? ` · ${display(a.errorCode)}` : ''}{a.durationMs !== null ? ` · ${a.durationMs} ms` : ''}{a.mayHaveReached ? ' · may have reached receiver' : ''}</li>)}</ul>
     </>}
     <p className="break-all text-muted-foreground">Evaluation {item.id} · configuration revision {item.revision}{item.intent ? ` · notification ${item.intent.id}` : ''}</p>
    </div>
   </details>)}
   {query.hasNextPage && <Button size="sm" variant="outline" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>Load older history</Button>}
  </>}
 </section>;
}
