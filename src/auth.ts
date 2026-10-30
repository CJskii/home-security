import { createHash, timingSafeEqual } from 'node:crypto';

export function bearerAuthorization(token: string): (header: unknown) => boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(token);
  return (header) => {
    if (typeof header !== 'string') return false;
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(header);
    return match?.[1] !== undefined && match[0] === header && timingSafeEqual(expected, digest(match[1]));
  };
}
