import { localWorkerHeartbeat } from './notifications/worker-health.js';
import { notificationMedia } from './notifications/media.js';
import { configuredTarget } from './notifications/destination.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { notificationRuntime } from './notifications/runtime.js';
import { createNotificationPipeline } from './notifications/pipeline.js';
import { createWebhookSender } from './notifications/webhook.js';
import { notificationTick } from './notifications/worker.js';
function log(code: string) { process.stdout.write(JSON.stringify({ time: new Date().toISOString(), service: 'home-security-notifications', environment: ['production', 'test', 'development'].includes(process.env.NODE_ENV ?? '') ? process.env.NODE_ENV : 'unknown', code }) + '\n'); }
export async function notificationMain() {
    loadEnv({ quiet: true });
    const settings = notificationRuntime(process.env);
    if (!settings.enabled) {
        log('WORKER_DISABLED');
        return;
    }
    const health = localWorkerHeartbeat();
    health.clear();
    const stop = new AbortController();
    let wake: () => void = () => { };
    const onStop = () => { stop.abort(); wake(); };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: settings.databaseUrl, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000, application_name: 'home-security-notifications' }), log: [] });
    const listener = new Client({ connectionString: settings.databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000, application_name: 'home-security-notification-wakeup' });
    listener.on('notification', () => wake());
    listener.on('error', () => { log('WAKEUP_CONNECTION_UNAVAILABLE'); wake(); });
    try {
        // Only reads: migrations and producer activation are explicit operator actions.
        await prisma.$queryRaw `SELECT (SELECT count(*) FROM "NotificationIntent" WHERE false), (SELECT count(*) FROM "NotificationAttempt" WHERE false), (SELECT count(*) FROM "NotificationCooldown" WHERE false)`;
        const saved = settings.deliveryEnabled ? await prisma.notificationConfiguration.findUniqueOrThrow({ where: { sourceInstallationId: settings.installation } }) : null;
        const target = saved ? configuredTarget(saved, { key: settings.key, approved: settings.approved, dashboardOrigin: settings.dashboardOrigin }) : null;
        const pipeline = createNotificationPipeline(prisma, { updatesEnabled:settings.updatesEnabled,updatesFrom:settings.updatesFrom,media:notificationMedia(process.env),installation: settings.installation, deliveryEnabled: settings.deliveryEnabled, activatedAt: settings.activatedAt, destinationId: target?.id ?? 'disabled', dashboardOrigin: settings.dashboardOrigin, ...(saved ? { destinationRevision: saved.deliveryRevision } : {}) });
        const sender = target ? createWebhookSender(target) : null;
        try {
            await listener.connect();
            await listener.query('LISTEN home_security_notifications');
        }
        catch {
            log('WAKEUP_UNAVAILABLE_POLLING');
        }
        log(settings.deliveryEnabled ? 'WORKER_STARTED_REQUIRES_DATABASE_ARM' : 'WORKER_STARTED_DELIVERY_DISABLED');
        while (!stop.signal.aborted) {
            try {
                await notificationTick(pipeline, sender, stop.signal);
                if (!stop.signal.aborted && !health.mark()) log('WORKER_HEALTH_UNAVAILABLE');
            }
            catch {
                health.clear();
                log('WORKER_TICK_FAILED');
            }
            if (!stop.signal.aborted)
                await new Promise<void>(done => {
                    const timer = setTimeout(finish, 1000);
                    function finish() { clearTimeout(timer); wake = () => { }; done(); }
                    wake = finish;
                    if (stop.signal.aborted)
                        finish();
                });
        }
    }
    finally {
        health.clear();
        process.off('SIGINT', onStop);
        process.off('SIGTERM', onStop);
        await listener.end().catch(() => { });
        await prisma.$disconnect();
        log('WORKER_STOPPED');
    }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
    void notificationMain().catch(() => { log('WORKER_INITIALIZATION_FAILED'); process.exitCode = 1; });
