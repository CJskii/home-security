import { approvedDestinations } from './notifications/destination-contract.js';
import { isIP } from 'node:net';
import { z } from 'zod';

export const DEFAULT_SERVICE_NAME = 'residential-security-backend';

const positiveInteger = (fallback: number, max: number) =>
  z.coerce.number().int().positive().max(max).default(fallback);

const postgresUrl = z.string().url().superRefine((value, ctx) => {
  if (!URL.canParse(value)) return; // The URL validator has already recorded this issue.
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname || !url.username || !url.password || url.pathname.length < 2) {
    ctx.addIssue({ code: 'custom', message: 'Expected PostgreSQL URL with credentials and database' });
  }
});

const optionalText = (max: number) => z.preprocess((value) => value === '' ? undefined : value,
  z.string().min(1).max(max).optional());
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: positiveInteger(3000, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .refine((value) => value.trim() === value).default(DEFAULT_SERVICE_NAME),
  METRICS_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  METRICS_TOKEN: z.preprocess((value) => value === '' ? undefined : value,
    z.string().min(32).max(256).refine((value) => !/[^A-Za-z0-9_-]/.test(value)).optional()),
  CAMERA_SYNC_OWNER_URL: z.preprocess(v => v === '' ? undefined : v, z.string().url().refine(v => {
    if(!URL.canParse(v))return false;
    const u=new URL(v),host=u.hostname;
    const privateHost=host==='localhost' || isIP(host)===4 && /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || isIP(host)===0 && /^[a-z0-9_-]+$/i.test(host);
    return privateHost && ['http:','https:'].includes(u.protocol) && !u.username && !u.password && u.pathname==='/' && !u.search && !u.hash;
  }).optional()),
  CAMERA_SYNC_TOKEN: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional()),
  LIVE_GATEWAY_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  EVENTS_TOKEN: z.preprocess((value) => value === '' ? undefined : value,
    z.string().min(32).max(256).refine((value) => !/[^A-Za-z0-9_-]/.test(value)).optional()),
  DASHBOARD_ORIGIN: z.preprocess((v) => v === '' ? undefined : v, z.string().url().refine((v) => { if (!URL.canParse(v)) return false; const u = new URL(v); return u.origin === v && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))); }).optional()),
  DASHBOARD_PASSWORD: optionalText(256).refine((v) => v === undefined || v.length >= 32),
  DASHBOARD_SESSION_KEY: z.preprocess((v) => v === '' ? undefined : v, z.string().regex(/^[a-f0-9]{64}$/).optional()),
  NOTIFICATION_IMAGE_CONTEXT_FACTOR:z.coerce.number().min(1).max(5).default(1.8),
  NOTIFICATION_MEDIA_KEY:z.preprocess(v=>v===''?undefined:v,z.string().regex(/^[a-f0-9]{64}$/).optional()),
  NOTIFICATION_MEDIA_ORIGIN:z.preprocess(v=>v===''?undefined:v,z.string().url().refine(v=>{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&u.origin===v;}).optional()),
  NOTIFICATION_DASHBOARD_ORIGIN:z.preprocess(v=>v===''?undefined:v,z.string().url().refine(v=>{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&u.origin===v;}).optional()),
  NOTIFICATION_CREDENTIAL_KEY:z.preprocess(v=>v===''?undefined:v,z.string().regex(/^[a-f0-9]{64}$/).optional()),
  NOTIFICATION_APPROVED_DESTINATIONS:z.string().max(8192).default('[]').refine(v=>{try{approvedDestinations(v);return true;}catch{return false;}}),
  DATABASE_URL: postgresUrl,
  DB_POOL_MAX: positiveInteger(5, 100),
  DB_CHECK_TIMEOUT_MS: positiveInteger(2000, 30000),
  SHUTDOWN_TIMEOUT_MS: positiveInteger(10000, 120000),
  UNIVIEW_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  HA_HISTORY_TOKEN: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional()),
  UNIVIEW_INSTALLATION_ID: z.uuid().transform((v) => v.toLowerCase()).optional(),
  UNIVIEW_NVR_IP: z.string().refine((v) => isIP(v) !== 0).optional(),
  UNIVIEW_CAMERA_MAP: z.preprocess((v) => {
    if (!v) return {};
    try { return JSON.parse(String(v)) as unknown; } catch { return null; }
  }, z.record(z.string().regex(/^[1-9][0-9]{0,9}$/), z.string().min(1).max(128).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)))),
  UNIVIEW_SAMPLING_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  UNIVIEW_USERNAME: optionalText(256),
  UNIVIEW_PASSWORD: optionalText(1024),
  UNIVIEW_SAMPLE_DELAYS_MS: z.preprocess((v) => typeof v === 'string' ? v.split(',').map(Number) : v ?? [5000, 15000],
    z.array(z.number().int().min(1000).max(60000)).length(2).refine((v) => v[0]! < v[1]!)),
  UNIVIEW_MAX_ACTIVE_WINDOWS: positiveInteger(2, 8),
  UNIVIEW_MEMORY_BYTES: positiveInteger(64000000, 256000000),
  UNIVIEW_PROCESSING_TIMEOUT_MS: positiveInteger(30000, 180000),
  UNIVIEW_SNAPSHOT_TIMEOUT_MS: positiveInteger(5000, 10000),
  UNIVIEW_MAX_BODY_BYTES: positiveInteger(32000000, 64000000),
  UNIVIEW_MAX_IMAGES: positiveInteger(64, 64),
  UNIVIEW_MAX_IMAGE_BYTES: positiveInteger(16000000, 32000000),
  UNIVIEW_MAX_PIXELS: positiveInteger(40000000, 100000000),
  UNIVIEW_MAX_CONCURRENT_UPLOADS: positiveInteger(2, 4),
  UNIVIEW_REQUEST_TIMEOUT_MS: positiveInteger(15000, 60000),
  AI_ZONE_SELECTION_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  AI_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  AI_BASE_URL: z.preprocess((v) => v === '' ? undefined : v, z.string().url().refine((v) => {
    if (!URL.canParse(v)) return false;
    const u = new URL(v), host = u.hostname;
    const privateIPv4 = isIP(host) === 4 && (/^10\./.test(host) || /^192\.168\./.test(host) || /^127\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
    const local = privateIPv4 || (isIP(host) === 0 && (/^[a-z0-9_-]+$/i.test(host) || host.endsWith('.local')));
    return local && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && ['/', ''].includes(u.pathname);
  }).optional()),
  AI_MODEL: optionalText(128),
  AI_BEARER_TOKEN: optionalText(4096).refine((v) => v === undefined || !/[\r\n]/.test(v)),
  AI_ENABLEMENT_CUTOFF: z.preprocess((v) => v === '' ? undefined : v, z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional()),
  AI_TIMEOUT_MS: positiveInteger(60000, 120000),
 }).superRefine((config, ctx) => {
  if(config.CAMERA_SYNC_OWNER_URL && !config.CAMERA_SYNC_TOKEN) ctx.addIssue({code:'custom',path:['CAMERA_SYNC_TOKEN'],message:'Owner forwarding requires a control token'});
  if(config.CAMERA_SYNC_TOKEN && [config.EVENTS_TOKEN,config.METRICS_TOKEN,config.DASHBOARD_PASSWORD].includes(config.CAMERA_SYNC_TOKEN)) ctx.addIssue({code:'custom',path:['CAMERA_SYNC_TOKEN'],message:'Control token must be separate'});
  if(config.NOTIFICATION_CREDENTIAL_KEY&&config.NOTIFICATION_CREDENTIAL_KEY===config.DASHBOARD_SESSION_KEY)ctx.addIssue({code:'custom',path:['NOTIFICATION_CREDENTIAL_KEY'],message:'Use a separate credential key'});
  const dashboard = [config.DASHBOARD_ORIGIN, config.DASHBOARD_PASSWORD, config.DASHBOARD_SESSION_KEY];
  if (dashboard.some(Boolean) && !dashboard.every(Boolean)) ctx.addIssue({ code: 'custom', path: ['DASHBOARD_ORIGIN'], message: 'All dashboard settings required' });
  if (config.DASHBOARD_PASSWORD && config.DASHBOARD_PASSWORD === config.EVENTS_TOKEN) ctx.addIssue({ code: 'custom', path: ['DASHBOARD_PASSWORD'], message: 'Must differ from service token' });
  if (config.NODE_ENV === 'production' && config.DASHBOARD_ORIGIN?.startsWith('http:')) ctx.addIssue({ code: 'custom', path: ['DASHBOARD_ORIGIN'], message: 'Production requires HTTPS' });
  if(config.AI_ZONE_SELECTION_ENABLED && (!config.AI_ENABLED || !config.UNIVIEW_ENABLED))ctx.addIssue({code:'custom',path:['AI_ZONE_SELECTION_ENABLED'],message:'Zone enforcement requires the AI receiver'});
  if (config.AI_ENABLED) {
    for (const key of ['AI_BASE_URL', 'AI_MODEL', 'AI_ENABLEMENT_CUTOFF'] as const) if (!config[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required for AI' });
    if (!config.UNIVIEW_ENABLED) ctx.addIssue({ code: 'custom', path: ['UNIVIEW_ENABLED'], message: 'AI requires receiver' });
    if (config.UNIVIEW_PROCESSING_TIMEOUT_MS < 1500 + config.AI_TIMEOUT_MS + 35000) ctx.addIssue({ code: 'custom', path: ['UNIVIEW_PROCESSING_TIMEOUT_MS'], message: 'Must bound original-push collection, queued wait, inference and persistence' });
  }
  if (config.UNIVIEW_SAMPLING_ENABLED && !config.AI_ENABLED) {
    for (const key of ['UNIVIEW_USERNAME', 'UNIVIEW_PASSWORD'] as const) if (!config[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required when sampling enabled' });
    if (config.UNIVIEW_SAMPLE_DELAYS_MS[1]! + config.UNIVIEW_SNAPSHOT_TIMEOUT_MS >= config.UNIVIEW_PROCESSING_TIMEOUT_MS) ctx.addIssue({ code: 'custom', path: ['UNIVIEW_PROCESSING_TIMEOUT_MS'], message: 'Must exceed final sample plus request timeout' });
  }
  if (config.UNIVIEW_ENABLED) {
    for (const key of ['UNIVIEW_INSTALLATION_ID', 'UNIVIEW_NVR_IP'] as const) {
      if (!config[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required when receiver enabled' });
    }
    if (config.UNIVIEW_REQUEST_TIMEOUT_MS >= config.SHUTDOWN_TIMEOUT_MS) ctx.addIssue({ code: 'custom', path: ['SHUTDOWN_TIMEOUT_MS'], message: 'Must exceed upload deadline' });
  }
  if (config.METRICS_ENABLED && !config.METRICS_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'Required when metrics are enabled' });
  }
  if (config.EVENTS_TOKEN && config.EVENTS_TOKEN === config.METRICS_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['EVENTS_TOKEN'], message: 'Must differ from metrics token' });
  }
  if (config.SHUTDOWN_TIMEOUT_MS <= config.DB_CHECK_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom', path: ['SHUTDOWN_TIMEOUT_MS'], message: 'Must exceed database check timeout' });
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const removed = ['CORRELATION_ENABLED', 'VISUAL_COMPARISON_ENABLED', 'EVIDENCE_SCORING_ENABLED'];
  const active = removed.filter((key) => env[key] !== undefined && !['', 'false'].includes(env[key]!));
  if (active.length) throw new Error(`Invalid configuration fields: ${active.join(', ')}`);
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Zod's raw issues can contain input. Expose field names only.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  return result.data;
}
