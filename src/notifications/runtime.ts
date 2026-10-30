import { z } from 'zod';
import { type WebhookTarget } from './webhook.js';
import { approvedDestinations, type PinnedDestination } from './destination-contract.js';
const flag = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
const date = z.iso.datetime().transform(v => new Date(v));
export type NotificationRuntime = {
    enabled: false;
} | {
    enabled: true;
    updatesEnabled: boolean;
    updatesFrom: Date | null;
    databaseUrl: string;
    installation: string;
    dashboardOrigin: string;
    deliveryEnabled: boolean;
    activatedAt: Date | null;
    target: WebhookTarget | null;
    key: string | undefined;
    approved: PinnedDestination[];
};
export function notificationRuntime(env: NodeJS.ProcessEnv): NotificationRuntime {
    try {
        if (!flag.parse(env.NOTIFICATION_WORKER_ENABLED))
            return { enabled: false };
        const base = z.object({ DATABASE_URL: z.string().url().refine(v => ['postgres:', 'postgresql:'].includes(new URL(v).protocol)), UNIVIEW_INSTALLATION_ID: z.uuid(), NOTIFICATION_DASHBOARD_ORIGIN: z.string().url().refine(v => { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; }), NOTIFICATION_DELIVERY_ENABLED: flag }).parse(env);
        const deliveryEnabled = base.NOTIFICATION_DELIVERY_ENABLED;
        // The dashboard and worker share exactly one encrypted destination. Do not
        // silently use a second URL/secret from the historical environment contract.
        if (deliveryEnabled && [env.NOTIFICATION_WEBHOOK_URL, env.NOTIFICATION_WEBHOOK_SECRET, env.NOTIFICATION_WEBHOOK_ADDRESS].some(Boolean))
            throw Error('Use saved destination');
        const key = deliveryEnabled ? z.string().regex(/^[a-f0-9]{64}$/).parse(env.NOTIFICATION_CREDENTIAL_KEY) : undefined;
        const approved = deliveryEnabled ? approvedDestinations(env.NOTIFICATION_APPROVED_DESTINATIONS ?? '[]') : [];
        if (deliveryEnabled && !approved.length)
            throw Error('Approved destination required');
        const target = null;
        const updatesEnabled=flag.parse(env.NOTIFICATION_AI_UPDATES_ENABLED);
        const updatesFrom=updatesEnabled?date.parse(env.NOTIFICATION_AI_UPDATES_FROM):null;
        const activatedAt = deliveryEnabled ? date.parse(env.NOTIFICATION_ACTIVATED_AT) : null;
        return { enabled: true, updatesEnabled, updatesFrom, databaseUrl: base.DATABASE_URL, installation: base.UNIVIEW_INSTALLATION_ID, dashboardOrigin: new URL(base.NOTIFICATION_DASHBOARD_ORIGIN).origin, deliveryEnabled, target, activatedAt, key, approved };
    }
    catch {
        throw new Error('Invalid notification worker configuration');
    }
}
