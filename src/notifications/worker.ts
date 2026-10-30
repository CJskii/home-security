import type { NotificationPipeline } from './pipeline.js';
import type { DeliveryResult, WebhookPayload } from './delivery-contract.js';
export type NotificationSender = (payload: WebhookPayload, signal: AbortSignal) => Promise<DeliveryResult>;
// DI keeps the executable separate from API/receiver startup and all tests offline.
export async function notificationTick(pipeline: NotificationPipeline, sender: NotificationSender | null, signal: AbortSignal) {
    await pipeline.recover();
    await pipeline.reconcile();
    for (let n = 0; n < 20 && !signal.aborted; n++)
        if (!await pipeline.evaluateNext())
            break;
    if (!sender)
        return;
    for (let n = 0; n < 5 && !signal.aborted; n++) {
        const claim = await pipeline.claim();
        if (!claim)
            break;
        let result: DeliveryResult;
        if (!await pipeline.authorize(claim))
            result = { outcome: 'failed', code: 'cancelled_before_send', status: null, mayHaveReached: false, durationMs: 0, receipt: null };
        else {
            try {
                result = await sender(claim.payload, signal);
            }
            // A thrown transport error cannot establish whether a side effect occurred.
            catch {
                result = { outcome: 'uncertain', code: 'transport_exception_unknown', status: null, mayHaveReached: true, durationMs: 0, receipt: null };
            }
        }
        // If persistence fails, do not send again. Lease recovery marks uncertainty.
        await pipeline.finish(claim, result);
    }
    await pipeline.enrich?.();
}
