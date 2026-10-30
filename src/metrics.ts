import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Config } from './config.js';

// Process collectors own process-lifetime observers. Initialize once, not once
// per app/test registry, and never touch the library's global default registry.
let processRegistry: Registry | undefined;
function getProcessMetrics(): Registry {
  if (!processRegistry) {
    processRegistry = new Registry();
    collectDefaultMetrics({ register: processRegistry, prefix: 'security_' });
  }
  return processRegistry;
}

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const routes = new Set(['/health', '/ready', '/metrics', '/api/events', '/api/events/:id', '/api/events/:id/notifications', '/api/events/:id/snapshots', '/api/events/:id/images/:imageId', '/api/events/:id/enrich', '/api/cameras', '/api/cameras/:id/zones', '/api/cameras/:id/zones/:zoneId', '/api/cameras/zones/refresh', '/api/cameras/:id/streams', '/LAPI/V1.0/System/Event/Notification/Alarm', '/LAPI/V1.0/System/Event/Notification/Structure']);
const labelNames = ['method', 'route', 'status_code'] as const;

export function createMetrics(config: Config) {
  const registry = new Registry();
  const requests = new Counter({
    name: 'security_http_requests_total',
    help: 'Completed HTTP responses, including probes, scrapes and rejected requests',
    labelNames, registers: [registry],
  });
  const duration = new Histogram({
    name: 'security_http_request_duration_seconds',
    help: 'Time from HTTP request receipt to completed response in seconds',
    labelNames, registers: [registry],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });
  const accepted = new Counter({ name: 'security_events_accepted_total', help: 'Ingestion requests committing new or changed event rows', registers: [registry] });
  const deduplicated = new Counter({ name: 'security_events_deduplicated_total', help: 'Ingestion requests requiring no write (duplicate or stale)', registers: [registry] });
  const rejected = new Counter({ name: 'security_events_rejected_total', help: 'Rejected ingestion requests', labelNames: ['reason'], registers: [registry] });
  const writeFailures = new Counter({ name: 'security_event_database_write_failures_total', help: 'Ingestion requests failing persistence after retries', registers: [registry] });
  const ingestionDuration = new Histogram({ name: 'security_event_ingestion_duration_seconds', help: 'Uniview notification response durations including rejected requests', registers: [registry], buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10] });
  const databaseReady = new Gauge({
    name: 'security_database_ready',
    help: '1 if the latest bounded database/table readiness check succeeded and service is not stopping; 0 otherwise',
    registers: [registry],
  });
  const lastCheck = new Gauge({
    name: 'security_database_readiness_last_check_timestamp_seconds',
    help: 'Unix time of the latest completed readiness attempt; 0 before the first check',
    registers: [registry],
  });
  databaseReady.set(0);
  lastCheck.set(0);

  const expositionRegistry = Registry.merge([getProcessMetrics(), registry]);
  expositionRegistry.setDefaultLabels({ service: config.SERVICE_NAME, environment: config.NODE_ENV });

  return {
    registry: expositionRegistry,
    recordEvent(outcome: 'accepted' | 'deduplicated') {
      if (outcome === 'accepted') accepted.inc();
      else if (outcome === 'deduplicated') deduplicated.inc();
    },
    recordWriteFailure() { writeFailures.inc(); },
    recordIngestionResponse(status: number, elapsedMs: number) {
      ingestionDuration.observe(elapsedMs / 1000);
      if (status >= 400) rejected.inc({ reason: status === 401 ? 'authentication' :
        status < 500 ? 'invalid_request' : 'unavailable' });
    },
    recordRequest(method: string, route: string | undefined, status: number, elapsedMs: number) {
      const labels = {
        method: methods.has(method) ? method : 'OTHER',
        route: route === undefined ? 'unmatched' : routes.has(route) ? route : 'other',
        status_code: Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'other',
      };
      requests.inc(labels);
      duration.observe(labels, elapsedMs / 1000);
    },
    recordReadiness(ready: boolean, checkedAt?: number) {
      databaseReady.set(ready ? 1 : 0);
      if (checkedAt !== undefined) lastCheck.set(checkedAt / 1000);
    },
  };
}
