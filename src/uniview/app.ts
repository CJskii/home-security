import { createZoneEligibilityGate } from '../ai/zone-eligibility-gate.js';
import type { Config } from '../config.js';
import type { Database } from '../database.js';
import { buildHttpApp } from '../app.js';
import { createEvidenceCoordinator, type EvidenceCoordinator } from './evidence.js';
import { ConfigurationRefreshBusy, createZoneSynchronizer, type ZoneSynchronizer } from './zone-sync.js';
import { createUniviewClient, createSnapshotClient } from './snapshot-client.js';
import { ingestNotification, InvalidNotification } from './ingest.js';
import { notificationPaths, parseNotificationJson } from './schemas.js';
import { eventContextLogger, requestCorrelationId } from '../logging.js';
import { bearerAuthorization } from '../auth.js';
import { createEventAnalyser } from '../ai/analysis.js';
import { createVisionClient } from '../ai/client.js';
export function buildReceiver(config: Config, database: Database, injectedEvidence?: EvidenceCoordinator, injectedZones?: ZoneSynchronizer) {
  if (!config.UNIVIEW_ENABLED || !database.uniview) throw new Error('Receiver requires explicit enablement and persistence');
  const client = createUniviewClient(config);
  const analysis = config.AI_ENABLED && database.analysis ? createEventAnalyser(config, database.analysis,
    createVisionClient(config.AI_BASE_URL!, config.AI_MODEL!, config.AI_BEARER_TOKEN), (eventId,telemetry)=>{eventContextLogger(service.app.log,{eventId,correlationId:eventId}).info({inference:telemetry},'AI inference telemetry');}) : undefined;
  const eligibility=config.AI_ZONE_SELECTION_ENABLED ? createZoneEligibilityGate(config.UNIVIEW_INSTALLATION_ID!,database.zoneEligibility??{read:async()=>null},client,
    (eventId,reason)=>{eventContextLogger(service.app.log,{eventId,correlationId:eventId}).info({zoneEligibility:reason},'AI zone eligibility decision');}) : undefined;
  const evidence = injectedEvidence ?? (database.evidence ? createEvidenceCoordinator(config, database.evidence, createSnapshotClient(config), () => { service.app.log.error({ errorCode: 'EVIDENCE_STATUS_UNAVAILABLE' }, 'Evidence status update failed'); }, analysis, (eventId,outcome)=>{eventContextLogger(service.app.log,{eventId,correlationId:eventId}).info({aiStatus:outcome.status,reason:outcome.reason,...(outcome.validationFailure?{validationFailure:outcome.validationFailure}:{}),...(outcome.capacity?{capacity:outcome.capacity}:{})},'AI enrichment finished');},eligibility) : undefined);
  const service = buildHttpApp(config, database, undefined, config.UNIVIEW_MAX_BODY_BYTES);
  const { app, metrics } = service;
  const zones = injectedZones ?? (database.zones ? createZoneSynchronizer(database.zones, client, config.UNIVIEW_INSTALLATION_ID!, [1, 2],
    () => { app.log.warn({ errorCode: 'ZONE_SYNC_UNAVAILABLE' }, 'Optional zone synchronization failed'); }, undefined, database.cameraConfiguration ? {store:database.cameraConfiguration,client} : undefined) : undefined);
  let active = 0, stopping = false;
  const slots = new WeakMap<import('fastify').FastifyRequest, { processing: boolean; release(): void }>();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.UNIVIEW_MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
  // This receiver is the sole scheduled/manual configuration owner. The API
  // forwards only this fixed operation using a separate server-side token.
  const syncAuthorized=config.CAMERA_SYNC_TOKEN ? bearerAuthorization(config.CAMERA_SYNC_TOKEN) : () => false;
  for(const channel of [undefined,1,2]) app.post('/internal/cameras/configuration/refresh'+(channel===undefined?'':`/${channel}`),{onRequest:async(req,reply)=>{
    if(!syncAuthorized(req.headers.authorization)) return reply.code(401).send({error:'Unauthorized'});
    if(Object.keys(req.query as object).length || Number(req.headers['content-length']??0)>0 || req.headers['transfer-encoding']) return reply.code(400).send({error:'Empty request required'});
  }},async(_req,reply)=>{
    reply.raw.setTimeout(55000,()=>reply.raw.destroy());
    if(!zones || !database.cameraConfiguration) return reply.code(503).send({error:'Configuration synchronization unavailable'});
    try {
      const channels=await zones.refresh(channel,true);
      return reply.code(channels.length===(channel===undefined?2:1) && channels.every(c=>c.status==='SYNCED')?200:503).send({channels});
    } catch(error) { if(error instanceof ConfigurationRefreshBusy)return reply.code(409).send({error:error.message});throw error; }
  });
  app.addHook('onReady', async () => { await evidence?.ready(); zones?.start(); });
  app.addHook('preClose', async () => { stopping = true;
    const results = await Promise.allSettled([zones?.close(), evidence?.close()]);
    if (results.some((r) => r.status === 'rejected')) throw new Error('Receiver shutdown failed'); });
  for (const kind of ['ALARM', 'STRUCTURE'] as const) {
    app.post(notificationPaths[kind], { onRequest: async (req, reply) => {
      const peer = req.raw.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (peer !== config.UNIVIEW_NVR_IP) return reply.code(403).send({ error: 'Source not allowed' });
      if (stopping || active >= config.UNIVIEW_MAX_CONCURRENT_UPLOADS) return reply.code(503).send({ error: 'Receiver unavailable' });
      const lengths: string[] = [];
      for (let i = 0; i < req.raw.rawHeaders.length; i += 2) if (req.raw.rawHeaders[i]?.toLowerCase() === 'content-length') lengths.push(req.raw.rawHeaders[i + 1]!);
      if (req.headers['transfer-encoding'] || lengths.length !== 1 || !/^[0-9]{1,12}$/.test(lengths[0]!)) return reply.code(400).send({ error: 'One Content-Length required' });
      const length = Number(lengths[0]);
      if (length <= 0 || length > config.UNIVIEW_MAX_BODY_BYTES) return reply.code(413).send({ error: 'Body outside limit' });
      if (req.headers['content-type'] && req.headers['content-type'].split(';')[0]?.trim().toLowerCase() !== 'application/json') return reply.code(415).send({ error: 'JSON required' });
      active++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      const slot = { processing: false, release }; slots.set(req, slot);
      const disconnected = () => { if (!slot.processing) release(); };
      req.raw.once('aborted', disconnected); reply.raw.once('finish', disconnected); reply.raw.once('close', disconnected);
    } }, async (req, reply) => {
      const slot = slots.get(req)!; slot.processing = true;
      try {
      let raw: unknown;
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length !== Number(req.headers['content-length'])) throw new Error('Incomplete body');
        raw = parseNotificationJson(req.body);
      } catch { return reply.code(400).send({ error: 'Invalid notification' }); }
      try {
        const result = await ingestNotification(config, database.uniview!, raw, kind);
        evidence?.accept(result.eventId, result.nvrChannel, result.frames, result.receivedAt.getTime(), result.newNotification);
        metrics?.recordEvent(result.newNotification ? 'accepted' : 'deduplicated');
        eventContextLogger(req.log, { eventId: result.eventId, correlationId: requestCorrelationId(req.headers['x-correlation-id'], req.id) }).info({ outcome: result.newNotification ? 'accepted' : 'deduplicated' }, 'Notification committed');
        return { accepted: true, eventId: result.eventId, newNotification: result.newNotification };
      } catch (error) {
        if (error instanceof InvalidNotification) return reply.code(400).send({ error: 'Invalid notification' });
        metrics?.recordWriteFailure(); req.log.error({ errorCode: 'UNIVIEW_STORAGE_UNAVAILABLE' }, 'Notification not committed');
        return reply.code(503).send({ error: 'Notification not committed; retry required' });
      }
      } finally { slot.release(); }
    });
  }
  return { ...service, zones, markStopping: () => { stopping = true; service.markStopping(); } };
}
