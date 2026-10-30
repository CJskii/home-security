import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual, hkdfSync } from 'node:crypto';
export function credentialCipher(keyHex: string) {
    if (!/^[0-9a-f]{64}$/.test(keyHex))
        throw Error('Invalid notification credential key');
    const master = Buffer.from(keyHex, 'hex'), key = Buffer.from(hkdfSync('sha256', master, 'home-security', 'notification-credential-v1', 32)), confirmationKey = Buffer.from(hkdfSync('sha256', master, 'home-security', 'notification-confirmation-v1', 32));
    return {
        seal(secret: string, installation: string) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(installation)); const data = Buffer.concat([c.update(secret, 'utf8'), c.final()]); return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.'); },
        open(value: string, installation: string) { const parts = value.split('.'); if (parts.length !== 4 || parts[0] !== 'v1')
            throw Error('Invalid encrypted signing credential'); const c = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url')); c.setAAD(Buffer.from(installation)); c.setAuthTag(Buffer.from(parts[2]!, 'base64url')); return Buffer.concat([c.update(Buffer.from(parts[3]!, 'base64url')), c.final()]).toString('utf8'); },
        sign(value: unknown) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return body + '.' + createHmac('sha256', confirmationKey).update('notification-test:v1:' + body).digest('base64url'); },
        verify(token: string): unknown { const parts = token.split('.'); if (parts.length !== 2)
            throw Error('Invalid test confirmation'); const expected = createHmac('sha256', confirmationKey).update('notification-test:v1:' + parts[0]).digest(), actual = Buffer.from(parts[1]!, 'base64url'); if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw Error('Invalid test confirmation'); return JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as unknown; }
    };
}
