import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const identity = z.object({ eventId: z.uuid(), imageId: z.uuid(), notificationId: z.uuid(), expires: z.number().int().positive(), view:z.enum(['focused','full']).optional(), context:z.number().min(1).max(5).optional(), boxes: z.array(z.tuple([z.number().int().min(0).max(10000),z.number().int().min(0).max(10000),z.number().int().min(0).max(10000),z.number().int().min(0).max(10000)]).refine(b=>b[0]<b[2]&&b[1]<b[3])).min(1).max(8).optional() }).strict();
export interface NotificationMedia { key: string; origin: string; contextFactor?: number }
export const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
export function notificationMedia(env: { NOTIFICATION_MEDIA_KEY?: string | undefined; NOTIFICATION_MEDIA_ORIGIN?: string | undefined; NOTIFICATION_IMAGE_CONTEXT_FACTOR?: number | string | undefined }): NotificationMedia | undefined {
    if (!env.NOTIFICATION_MEDIA_KEY && !env.NOTIFICATION_MEDIA_ORIGIN) return undefined;
    const key = z.string().regex(/^[a-f0-9]{64}$/).parse(env.NOTIFICATION_MEDIA_KEY);
    const origin = z.string().url().parse(env.NOTIFICATION_MEDIA_ORIGIN), url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw Error('Invalid media origin');
    return { key, origin, contextFactor:z.coerce.number().min(1).max(5).parse(env.NOTIFICATION_IMAGE_CONTEXT_FACTOR??1.8) };
}
export function mediaLink(config: NotificationMedia, eventId: string, imageId: string, notificationId: string, now: Date, boxes?: number[][], view: 'focused'|'full' = 'focused') {
    const value = identity.parse({ eventId, imageId, notificationId, expires: now.getTime() + MEDIA_TTL_MS, ...(boxes?.length ? {boxes,view,context:config.contextFactor??1.8} : {}) });
    const data = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(config.key, 'hex')).update('notification-media:v1:' + data).digest('hex');
    return { url: `${config.origin}/api/notification-media/${eventId}/${imageId}?token=${data}.${signature}`, expiresAt: new Date(value.expires).toISOString() };
}
export function verifyMedia(config: NotificationMedia | undefined, token: string, eventId: string, imageId: string, now = Date.now()): boolean {
    try {
        if (!config || token.length > 1024) return false;
        const [data, signature, extra] = token.split('.');
        if (!data || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature)) return false;
        const expected = createHmac('sha256', Buffer.from(config.key, 'hex')).update('notification-media:v1:' + data).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return false;
        const value = identity.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
        return value.eventId === eventId && value.imageId === imageId && value.expires > now && value.expires <= now + MEDIA_TTL_MS + 60000;
    } catch { return false; }
}

// Call only after verifyMedia: the annotation scope is covered by the same HMAC.
export function mediaBoxes(token: string): number[][] | undefined { return identity.parse(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'))).boxes; }

export function mediaFrameOptions(token:string) { const value=identity.parse(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')));return {variant:value.view??'full',contextFactor:value.context??1.8} as const; }
