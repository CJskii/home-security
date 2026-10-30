import type { FastifyBaseLogger, FastifyServerOptions } from 'fastify';
import { stdTimeFunctions } from 'pino';
import { z } from 'zod';
import type { Config } from './config.js';

export function loggerOptions(config: Config): Exclude<FastifyServerOptions['logger'], undefined | boolean> {
  const sensitiveFields = [
    'NOTIFICATION_MEDIA_KEY', 'NOTIFICATION_CREDENTIAL_KEY', 'signingSecret', 'deliverySecret', 'confirmation', 'NOTIFICATION_WEBHOOK_URL', 'NOTIFICATION_WEBHOOK_SECRET', 'OLLAMA_BASE_URL', 'OLLAMA_BEARER_TOKEN', 'AI_BASE_URL', 'AI_BEARER_TOKEN',
    'objects', 'actions', 'shortDescription', 'detailedDescription', 'people', 'vehicles', 'supplementary', 'uncertainties', 'subjects', 'movementDirection',
    'HA_HISTORY_TOKEN', 'CAMERA_SYNC_TOKEN', 'DASHBOARD_PASSWORD', 'DASHBOARD_SESSION_KEY', 'username', 'DATABASE_URL', 'EVENTS_TOKEN', 'METRICS_TOKEN', 'password', 'passwordHash', 'credentials',
    'authorization', 'cookie', 'headers', 'token', 'accessToken', 'refreshToken', 'apiKey',
    'access_token', 'refresh_token', 'api_key',
    'secret', 'clientSecret', 'body', 'payload', 'selectedPayload',
    'notificationPayload', 'deliveryMetadata', 'jobMetadata', 'result',
    'prompt', 'messages', 'images', 'imageUrl', 'snapshotRef', 'clipRef', 'personalDetails',
  ];
  return {
    level: config.LOG_LEVEL,
    timestamp: stdTimeFunctions.isoTime,
    base: { pid: process.pid, service: config.SERVICE_NAME, environment: config.NODE_ENV },
    redact: {
      paths: [
        ...sensitiveFields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
        'req.headers', 'request.headers', 'res.headers',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      // Never serialize request bodies, headers, raw URLs, or query strings.
      req: (req) => ({
        method: req.method,
        route: req.routeOptions?.url ?? '<unmatched>',
      }),
      res: (res) => ({ statusCode: res.statusCode }),
      // Driver errors can embed URLs, payloads or SQL. Keep logs safe by design.
      err: () => ({ type: 'Error', message: 'Details withheld', stack: '' }),
    },
  };
}

const contextId = z.uuid().transform((id) => id.toLowerCase());

export function requestCorrelationId(header: unknown, requestId: string): string {
  const parsed = contextId.safeParse(header);
  return parsed.success ? parsed.data : requestId;
}

// Event handlers pass internal UUIDs, never arbitrary payloads.
export function eventContextLogger(logger: FastifyBaseLogger, context: {
  eventId: string;
  correlationId: string;
}): FastifyBaseLogger {
  const parsed = z.object({ eventId: contextId, correlationId: contextId }).safeParse(context);
  if (!parsed.success) throw new Error('Invalid event log context');
  return logger.child(parsed.data);
}
