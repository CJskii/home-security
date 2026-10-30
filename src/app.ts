import { homeAssistantEvent, haEventQuery, homeAssistantZoneHistory, haZoneQuery, HaZoneNotFound } from './dashboard/ha-zone-history.js';
import { homeAssistantHistory } from './dashboard/home-assistant.js';
import { annotatedFrame } from './notifications/annotated-frame.js';
import { notificationMedia, verifyMedia, mediaBoxes, mediaFrameOptions } from './notifications/media.js';
import {deliverySave,testSend,DeliveryConfigurationError} from './notifications/destination-contract.js';
import { notificationSave, notificationWindow, notificationArchive, NotificationConflict, NotificationLimit } from './notifications/contracts.js';
import { processingProposalInput } from './ai/processing-proposal.js';
import { installDashboardSession } from './dashboard/session.js';
import { statisticsSchema } from './dashboard/statistics.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './database.js';
import { loggerOptions, requestCorrelationId } from './logging.js';
import { createMetrics } from './metrics.js';
import { createReadiness } from './readiness.js';
import { bearerAuthorization } from './auth.js';
import { presentEvent, presentImage, presentZoneVersion } from './events/presentation.js';
import { createNvrApi, MediaFailure, type NvrApi } from './events/nvr-service.js';
import { cameras, createStreamDiscovery, streamProfiles, type StreamDiscovery } from './uniview/verified-streams.js';
import { ConfigurationRefreshBusy, type ZoneSynchronizer } from './uniview/zone-sync.js';
import { createConfigurationOwnerClient } from './uniview/configuration-owner.js';
import { cameraSnapshotSchema, configurationStatus } from './uniview/camera-configuration.js';
import { zoneNameSchema } from './uniview/zones.js';
import { zonePreferenceInput, ZonePreferenceConflict } from './uniview/zone-preferences.js';
import { historySchema } from './events/queries.js';
export function buildHttpApp(config: Config, database: Database, logger?: FastifyBaseLogger, bodyLimit = 16 * 1024) {
  const app = Fastify({ ...(logger ? { loggerInstance: logger } : { logger: loggerOptions(config) }),
    requestIdHeader: false, genReqId: () => randomUUID(), bodyLimit,
    requestTimeout: config.UNIVIEW_ENABLED ? config.UNIVIEW_REQUEST_TIMEOUT_MS : 10000,
    connectionTimeout: config.UNIVIEW_ENABLED ? config.UNIVIEW_REQUEST_TIMEOUT_MS : 10000,
    forceCloseConnections: 'idle', exposeHeadRoutes: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  const metrics = config.METRICS_ENABLED ? createMetrics(config) : undefined;
  const readiness = createReadiness(database, config.DB_CHECK_TIMEOUT_MS, (ready, time) => metrics?.recordReadiness(ready, time));
  app.setChildLoggerFactory((log, bindings, options, req) => log.child({ ...bindings,
    correlationId: requestCorrelationId(req.headers['x-correlation-id'], String(bindings.reqId)) }, options));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store'); reply.header('x-request-id', request.id);
    reply.header('x-correlation-id', requestCorrelationId(request.headers['x-correlation-id'], request.id));
  });
  app.addHook('onResponse', async (request, reply) => {
    metrics?.recordRequest(request.method, request.routeOptions.url, reply.statusCode, reply.elapsedTime);
    if (request.routeOptions.url?.startsWith('/LAPI/')) metrics?.recordIngestionResponse(reply.statusCode, reply.elapsedTime);
  });
  app.addHook('preClose', async () => { readiness.stop(); });
  app.addHook('onClose', async () => { await database.disconnect(); metrics?.registry.clear(); });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.validation ? 400 : error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    request.log[status >= 500 ? 'error' : 'warn']({ errorCode: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_VALIDATION_FAILED' }, 'Request failed');
    return reply.code(status).send({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));
  const empty = z.object({}).strict();
  app.get('/health', { schema: { querystring: empty } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { querystring: empty } }, async (request, reply) => {
    const ready = await readiness.check();
    if (!ready) request.log.warn({ errorCode: 'DATABASE_NOT_READY' }, 'Database readiness check failed'); return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  if (metrics) {
    const authorized = bearerAuthorization(config.METRICS_TOKEN!);
    app.get('/metrics', { onRequest: async (req, reply) => {
      if (!authorized(req.headers.authorization)) return reply.header('www-authenticate', 'Bearer realm="metrics"').code(401).send({ error: 'Unauthorized' });
    }, schema: { querystring: empty } }, async (req, reply) => {
      if (!await readiness.check()) req.log.warn({ errorCode: 'DATABASE_NOT_READY' }, 'Database readiness check failed'); return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
    });
  }
  return { app, metrics, markStopping: () => readiness.stop() };
}
export function buildApp(config: Config, database: Database, logger?: FastifyBaseLogger, suppliedNvr?: NvrApi, suppliedStreams?: StreamDiscovery, suppliedZones?: Pick<ZoneSynchronizer,'refresh'|'close'>) {
  const service = buildHttpApp(config, database, logger);
  const { app } = service;
  const nvr = suppliedNvr ?? createNvrApi(config,database);
  const streams = suppliedStreams ?? createStreamDiscovery(config);
  const zoneRefresh = suppliedZones ?? createConfigurationOwnerClient(config);
  app.addHook('preClose', async () => { await Promise.all([nvr?.close(),streams.close(),zoneRefresh?.close()]); });
  const dashboardAuthorized = installDashboardSession(app, config);
  const authorized = config.EVENTS_TOKEN ? bearerAuthorization(config.EVENTS_TOKEN) : () => false;
  const authenticate = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!authorized(req.headers.authorization) && !(req.method === 'GET' && dashboardAuthorized(req))) return reply.header('www-authenticate', 'Bearer realm="events"').code(401).send({ error: 'Unauthorized' });
  };
  const params = z.object({ id: z.uuid().transform((v) => v.toLowerCase()) }).strict();
  const empty = z.object({}).strict();
  const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });
  const haAuthorized = config.HA_HISTORY_TOKEN ? bearerAuthorization(config.HA_HISTORY_TOKEN) : () => false;
  app.get('/api/dashboard/home-assistant', { onRequest: async (req, reply) => {
    if (!haAuthorized(req.headers.authorization) && !authorized(req.headers.authorization) && !dashboardAuthorized(req)) return reply.code(401).send({ error: 'Unauthorized' });
  }, schema: { querystring: empty } }, async (_req, reply) => {
    if (!config.UNIVIEW_INSTALLATION_ID) return reply.code(503).send({ error: 'History unavailable' });
    try { return reply.header('cache-control', 'no-store').send(await homeAssistantHistory(database, config.UNIVIEW_INSTALLATION_ID, config.NOTIFICATION_DASHBOARD_ORIGIN ?? config.DASHBOARD_ORIGIN ?? 'http://localhost:5173', notificationMedia(config))); }
    catch { return reply.code(503).send({ error: 'History unavailable' }); }
  });
  app.get('/api/dashboard/home-assistant/zone-history', { onRequest: async (req, reply) => {
    if (!haAuthorized(req.headers.authorization) && !authorized(req.headers.authorization) && !dashboardAuthorized(req)) return reply.code(401).send({ error:'Unauthorized' });
  }, schema:{querystring:haZoneQuery} }, async(req,reply)=>{
    if(!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'History unavailable'});
    try{return await homeAssistantZoneHistory(database,config.UNIVIEW_INSTALLATION_ID,req.query,notificationMedia(config));}
    catch(error){return reply.code(error instanceof HaZoneNotFound?404:error instanceof RangeError?400:503).send({error:error instanceof RangeError?'Refresh the history window':'History unavailable'});}
  });
  app.get('/api/dashboard/home-assistant/event', { onRequest: async(req,reply)=>{
    if(!haAuthorized(req.headers.authorization)&&!authorized(req.headers.authorization)&&!dashboardAuthorized(req))return reply.code(401).send({error:'Unauthorized'});
  },schema:{querystring:haEventQuery}},async(req,reply)=>{
    if(!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'History unavailable'});
    try{return reply.header('cache-control','no-store').send(await homeAssistantEvent(database,config.UNIVIEW_INSTALLATION_ID,req.query.eventId,notificationMedia(config)));}
    catch(error){return reply.code(error instanceof HaZoneNotFound?404:503).send({error:'Event unavailable'});}
  });
  app.get('/api/dashboard/statistics', { onRequest: authenticate, schema: { querystring: statisticsSchema } }, async (req, reply) => {
    if (!database.statistics) return reply.code(503).send({ error: 'Persistence unavailable' });
    try { return await database.statistics(req.query); }
    catch { return reply.code(503).send({ error: 'Persistence unavailable' }); }
  });
  app.get('/api/events', { onRequest: authenticate, schema: { querystring: historySchema } }, async (req, reply) => {
    if (!database.events) return reply.code(503).send({ error: 'Persistence unavailable' });
    try {
      const rows = await database.events.history(req.query), events = rows.slice(0, req.query.limit), last = events.at(-1);
      return { events: events.map(presentEvent),
        nextCursor: rows.length > req.query.limit && last ? Buffer.from(JSON.stringify({ eventTime: last.eventTime, id: last.id, ...(req.query.sort==='oldest'?{sort:'oldest'}:{}) })).toString('base64url') : null };
    } catch { return reply.code(503).send({ error: 'Persistence unavailable' }); }
  });
  app.get('/api/events/:id', { onRequest: authenticate, schema: { params, querystring: empty } }, async (req, reply) => {
    if (!database.events) return reply.code(503).send({ error: 'Persistence unavailable' });
    try { const event = await database.events.get(req.params.id); return event ? presentEvent(event) : reply.code(404).send({ error: 'Not found' }); }
    catch { return reply.code(503).send({ error: 'Persistence unavailable' }); }
  });
  app.get('/api/events/:id/notifications', { onRequest: authenticate, schema: { params, querystring: page.extend({
    beforeTime: z.iso.datetime().transform((v) => new Date(v)).optional(), beforeId: z.uuid().optional(),
  }).strict().refine((q) => Boolean(q.beforeTime) === Boolean(q.beforeId)) } }, async (req, reply) => {
    if (!database.events) return reply.code(503).send({ error: 'Persistence unavailable' });
    try {
      const q = req.query, rows = await database.events.notifications(req.params.id, q.limit, q.beforeTime && q.beforeId ? { receivedAt: q.beforeTime, id: q.beforeId } : undefined);
      const notifications = rows.slice(0, q.limit), last = notifications.at(-1);
      return { notifications, nextCursor: rows.length > q.limit && last ? { beforeTime: last.receivedAt, beforeId: last.id } : null };
    } catch { return reply.code(503).send({ error: 'Persistence unavailable' }); }
  });
  app.get('/api/events/:id/snapshots', { onRequest: authenticate, schema: { params, querystring: page.extend({ after: z.uuid().optional() }).strict() } }, async (req, reply) => {
    if (!database.events) return reply.code(503).send({ error: 'Persistence unavailable' });
    try {
      const rows = await database.events.snapshots(req.params.id, req.query.limit, req.query.after), snapshots = rows.slice(0, req.query.limit);
      return { snapshots: snapshots.map(presentImage), nextAfter: rows.length > req.query.limit ? snapshots.at(-1)?.id : null };
    } catch { return reply.code(503).send({ error: 'Persistence unavailable' }); }
  });
  function disconnected(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
    req.raw.once('aborted',abort); reply.raw.once('close',abort); reply.raw.setTimeout(65000,() => controller.abort());
    return { signal:controller.signal, done:() => { req.raw.off('aborted',abort); reply.raw.off('close',abort); } };
  }
  function mediaError(error: unknown, reply: import('fastify').FastifyReply) {
    const failure = error instanceof MediaFailure ? error : new MediaFailure(503,'NVR_UNAVAILABLE','TEMPORARILY_UNAVAILABLE');
    if (failure.status === 503) reply.header('retry-after','2');
    return reply.code(failure.status).send({ error:'Requested NVR operation unavailable', code:failure.code,
      availability:{state:failure.availability,permanentExpiryConfirmed:false} });
  }
  app.get('/api/notification-media/:id/:imageId', {schema:{params:params.extend({imageId:z.uuid()}).strict(),querystring:z.object({token:z.string().max(1024)}).strict()}}, async(req,reply)=>{
    if(!verifyMedia(notificationMedia(config),req.query.token,req.params.id,req.params.imageId))return reply.code(401).send({error:'Unauthorized'});
    if(!nvr)return reply.code(503).send({error:'Media unavailable'});
    const operation=disconnected(req,reply);
    try { const original=await nvr.image(req.params.id,req.params.imageId,operation.signal); const boxes=mediaBoxes(req.query.token); const bytes=boxes?await annotatedFrame(original,boxes,mediaFrameOptions(req.query.token)):original; return reply.header('x-content-type-options','nosniff').header('referrer-policy','no-referrer').type('image/jpeg').send(bytes); }
    catch(error){return mediaError(error,reply);}finally{operation.done();}
  });
  app.get('/api/events/:id/images/:imageId', { onRequest:authenticate, schema:{params:params.extend({imageId:z.uuid().transform((v)=>v.toLowerCase())}).strict(),querystring:empty} }, async (req,reply) => {
    if (!nvr) return mediaError(new MediaFailure(503,'NVR_NOT_CONFIGURED','UNRESOLVED'),reply);
    const operation = disconnected(req,reply);
    try {
      const bytes = await nvr.image(req.params.id,req.params.imageId,operation.signal);
      return reply.header('x-content-type-options','nosniff').header('content-disposition',`inline; filename="${req.params.id}-${req.params.imageId}.jpg"`).type('image/jpeg').send(bytes);
    } catch(error) { return mediaError(error,reply); } finally { operation.done(); }
  });
  app.post('/api/events/:id/enrich', { onRequest:authenticate,schema:{params,querystring:empty,body:empty.nullish()} }, async (req,reply) => {
    if (!nvr) return mediaError(new MediaFailure(503,'NVR_NOT_CONFIGURED','UNRESOLVED'),reply);
    const operation = disconnected(req,reply);
    try { return await nvr.enrich(req.params.id,operation.signal); }
    catch(error) { return mediaError(error,reply); } finally { operation.done(); }
  });
  const cameraParams=z.object({id:z.string().min(1).max(128)}).strict();
  app.get('/api/cameras',{onRequest:authenticate,schema:{querystring:empty}},async()=>({refreshAvailable:Boolean(config.CAMERA_SYNC_OWNER_URL && config.CAMERA_SYNC_TOKEN),cameras:await Promise.all(cameras(config).map(async camera=>{
    const state=database.cameraConfiguration && config.UNIVIEW_INSTALLATION_ID ? await database.cameraConfiguration.get(config.UNIVIEW_INSTALLATION_ID,camera.channel):null;
    const snapshot=cameraSnapshotSchema.safeParse(state?.snapshot);
    return {...camera,name:snapshot.success ? snapshot.data.name??camera.name : camera.name,synchronization:configurationStatus(state)};
  }))}));
  app.get('/api/cameras/:id/streams',{onRequest:authenticate,schema:{params:cameraParams,querystring:empty}},async(req,reply)=>{
    const camera=cameras(config).find((c)=>c.id===req.params.id);
    if(!camera)return reply.code(404).send({error:'Not found'});
    if(database.cameraConfiguration && config.UNIVIEW_INSTALLATION_ID){
      const state=await database.cameraConfiguration.get(config.UNIVIEW_INSTALLATION_ID,camera.channel),snapshot=cameraSnapshotSchema.safeParse(state?.snapshot),status=configurationStatus(state);
      return {cameraId:camera.id,channel:camera.channel,profiles:snapshot.success?streamProfiles(config,camera.channel,snapshot.data.streams,[null,null,null],status.lastSuccessfulAt!):[],health:'unmonitored',
        discovery:{state:status.state,stale:status.state==='stale',refreshedAt:status.lastSuccessfulAt,ttlSeconds:600,reason:status.error}};
    }
    return {cameraId:camera.id,channel:camera.channel,...await streams.get(camera.channel)};
  });
  const refreshAuthentication = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if(authorized(req.headers.authorization))return;
    if(!dashboardAuthorized(req))return reply.code(401).send({error:'Unauthorized'});
    if(req.headers.origin!==config.DASHBOARD_ORIGIN || req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:'Forbidden'});
  };
  app.get('/api/ai/processing', {onRequest:authenticate,schema:{querystring:empty}},async(_req,reply)=>{
    if(!database.processingProposal||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'AI proposal unavailable'});
    const data=await database.processingProposal.read(config.UNIVIEW_INSTALLATION_ID);
    return {...data as Record<string,unknown>,writable:Boolean(database.processingProposal.save)};
  });
  app.put('/api/ai/processing', {onRequest:refreshAuthentication,schema:{querystring:empty,body:processingProposalInput}},async(req,reply)=>{
    if(!database.processingProposal?.save||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'AI proposal unavailable'});
    try{return {...await database.processingProposal.save(config.UNIVIEW_INSTALLATION_ID,req.body) as Record<string,unknown>,writable:true};}
    catch{return reply.code(409).send({error:'Proposal not saved. Refresh the zone catalog and retry.'});}
  });
  const deliveryFailure=(error:unknown,reply:import('fastify').FastifyReply)=>reply.code(error instanceof DeliveryConfigurationError?error.status:503).send({error:error instanceof DeliveryConfigurationError?error.code:'delivery_configuration_unavailable'});
  app.get('/api/notifications/delivery/settings',{onRequest:authenticate,schema:{querystring:empty}},async(_req,reply)=>{
    if(!database.notificationDelivery||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'delivery_configuration_unavailable'});
    try{return await database.notificationDelivery.read(config.UNIVIEW_INSTALLATION_ID);}catch(error){return deliveryFailure(error,reply);}
  });
  app.put('/api/notifications/delivery/settings',{onRequest:refreshAuthentication,schema:{querystring:empty,body:deliverySave}},async(req,reply)=>{
    if(!database.notificationDelivery||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'delivery_configuration_unavailable'});
    try{return await database.notificationDelivery.save(config.UNIVIEW_INSTALLATION_ID,req.body);}catch(error){return deliveryFailure(error,reply);}
  });
  app.post('/api/notifications/delivery/preview',{onRequest:refreshAuthentication,schema:{querystring:empty,body:z.object({sampleEventId:z.uuid().optional(),updateTestId:z.uuid().optional()}).strict()}},async(req,reply)=>{
    if(!database.notificationDelivery||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'delivery_configuration_unavailable'});
    try{return await database.notificationDelivery.preview(config.UNIVIEW_INSTALLATION_ID,req.body.sampleEventId,req.body.updateTestId);}catch(error){return deliveryFailure(error,reply);}
  });
  app.post('/api/notifications/delivery/test',{onRequest:refreshAuthentication,schema:{querystring:empty,body:testSend}},async(req,reply)=>{
    if(!database.notificationDelivery||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'delivery_configuration_unavailable'});
    reply.raw.setTimeout(25000,()=>reply.raw.destroy());const controller=new AbortController(),abort=()=>controller.abort();reply.raw.once('close',abort);
    try{return await database.notificationDelivery.test(config.UNIVIEW_INSTALLATION_ID,req.body.confirmation,controller.signal);}catch(error){return deliveryFailure(error,reply);}finally{reply.raw.off('close',abort);}
  });
  app.get('/api/notifications/history',{onRequest:authenticate,schema:{querystring:z.object({before:z.uuid().optional(),attempted:z.enum(['true','false']).optional()}).strict()}},async(req,reply)=>{
    if(!database.notifications?.history||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'Notification history unavailable'});
    try{return req.query.attempted==='true' ? await database.notifications.history(config.UNIVIEW_INSTALLATION_ID,req.query.before,true) : await database.notifications.history(config.UNIVIEW_INSTALLATION_ID,req.query.before);}
    catch{return reply.code(503).send({error:'Notification history unavailable'});}
  });
  app.get('/api/notifications/settings',{onRequest:authenticate,schema:{querystring:empty}},async(_req,reply)=>{
    if(!database.notifications||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'Notification settings unavailable'});
    try{return {...await database.notifications.read(config.UNIVIEW_INSTALLATION_ID) as Record<string,unknown>,writable:Boolean(database.notifications.save),archivable:Boolean(database.notifications.archive)};}
    catch{return reply.code(503).send({error:'Notification settings unavailable'});}
  });
  app.put('/api/notifications/settings',{onRequest:refreshAuthentication,schema:{querystring:empty,body:notificationSave}},async(req,reply)=>{
    if(!database.notifications?.save||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'Notification settings unavailable'});
    try{return {...await database.notifications.save(config.UNIVIEW_INSTALLATION_ID,req.body.expectedRevision,req.body.configuration) as Record<string,unknown>,writable:true,archivable:Boolean(database.notifications.archive)};}
    catch(error){return reply.code(error instanceof NotificationConflict?409:503).send({error:error instanceof NotificationConflict?error.message:'Notification settings not saved'});}
  });
  app.get('/api/notifications/evaluations/:id',{onRequest:authenticate,schema:{params,querystring:empty}},async(req,reply)=>{
    if(!database.notifications||!config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'Notification evaluations unavailable'});
    try{const result=await database.notifications.evaluation(config.UNIVIEW_INSTALLATION_ID,req.params.id);return result??reply.code(404).send({error:'Not found'});}
    catch{return reply.code(503).send({error:'Notification evaluations unavailable'});}
  });
  let notificationPreviewBusy=false;
  for(const archive of [false,true])app.post(archive?'/api/notifications/evaluations':'/api/notifications/preview',{onRequest:refreshAuthentication,schema:{querystring:empty,body:archive?notificationArchive:notificationWindow}},async(req,reply)=>{
    if(!database.notifications||!config.UNIVIEW_INSTALLATION_ID||(archive&&!database.notifications.archive))return reply.code(503).send({error:'Notification evaluation unavailable'});
    if(notificationPreviewBusy)return reply.code(409).send({error:'Notification evaluation already running'});
    notificationPreviewBusy=true;
    try{const window=notificationWindow.parse({from:req.body.from,to:req.body.to});
      // Parse the strict window subset separately for the archival envelope.
      if(archive){const input=notificationArchive.parse(req.body);return await database.notifications.archive!(config.UNIVIEW_INSTALLATION_ID,{from:input.from,to:input.to},input.expectedRevision,input.fingerprint);}
      return await database.notifications.preview(config.UNIVIEW_INSTALLATION_ID,window);
    }catch(error){return reply.code(error instanceof NotificationLimit?413:error instanceof NotificationConflict?409:503).send({error:error instanceof NotificationLimit||error instanceof NotificationConflict?error.message:'Notification evaluation unavailable'});}
    finally{notificationPreviewBusy=false;}
  });
  let configurationRefreshing=false;
  for(const url of ['/api/cameras/configuration/refresh','/api/cameras/zones/refresh']) app.post(url,{onRequest:refreshAuthentication,schema:{querystring:empty,body:z.object({cameraId:z.string().min(1).max(128).optional()}).strict().nullish()}},async(req,reply)=>{
    const selected=req.body?.cameraId;
    const camera=selected===undefined?undefined:cameras(config).find(c=>c.id===selected);
    if(selected!==undefined && !camera)return reply.code(404).send({error:'Camera not found'});
    if(configurationRefreshing)return reply.code(409).send({error:'Camera configuration refresh already in progress'});
    configurationRefreshing=true;
    reply.raw.setTimeout(60000,()=>reply.raw.destroy());
    try {
      const channels=await zoneRefresh.refresh(camera?.channel,true);
      return reply.code(channels.length===(camera?1:2) && channels.every(c=>c.status==='SYNCED')?200:503).send({channels});
    } catch(error) { return reply.code(error instanceof ConfigurationRefreshBusy?409:503).send({error:error instanceof ConfigurationRefreshBusy?error.message:'Configuration refresh unavailable'}); }
    finally { configurationRefreshing=false; }
  });
  app.patch('/api/cameras/:id/zones/:zoneId/preferences', {onRequest:refreshAuthentication,schema:{
    params:cameraParams.extend({zoneId:z.uuid().transform(v=>v.toLowerCase())}).strict(), querystring:empty, body:zonePreferenceInput,
  }},async(req,reply)=>{
    const camera=cameras(config).find(c=>c.id===req.params.id);
    if(!camera)return reply.code(404).send({error:'Not found'});
    if(!database.zonePreferences?.save || !config.UNIVIEW_INSTALLATION_ID)return reply.code(503).send({error:'Zone preferences unavailable'});
    try {
      const preference=await database.zonePreferences.save(config.UNIVIEW_INSTALLATION_ID,camera.channel,req.params.zoneId,req.body);
      return preference ? {preference} : reply.code(404).send({error:'Not found'});
    } catch(error) { return reply.code(error instanceof ZonePreferenceConflict?409:503).send({error:error instanceof ZonePreferenceConflict?'Zone configuration changed. Review it before saving.':'Zone preferences unavailable'}); }
  });
  app.patch('/api/cameras/:id/zones/:zoneId',{onRequest:authenticate,schema:{params:cameraParams.extend({zoneId:z.uuid().transform((v)=>v.toLowerCase())}).strict(),
    querystring:empty,body:z.object({name:zoneNameSchema}).strict()}},async(req,reply)=>{
    const camera=cameras(config).find((c)=>c.id===req.params.id);
    if (!camera) return reply.code(404).send({error:'Not found'});
    if (!database.zones || !config.UNIVIEW_INSTALLATION_ID) return reply.code(503).send({error:'Persistence unavailable'});
    try {
      const zones=await database.zones.list(config.UNIVIEW_INSTALLATION_ID,camera.channel),zone=zones.find((v)=>v.id===req.params.zoneId);
      if (!zone) return reply.code(404).send({error:'Not found'});
      const renamed=await database.zones.rename(config.UNIVIEW_INSTALLATION_ID,camera.channel,zone.slot,req.body.name);
      return renamed ? {id:renamed.id,slot:renamed.slot,name:renamed.displayName,configurationChanged:false} : reply.code(404).send({error:'Not found'});
    } catch { return reply.code(503).send({error:'Persistence unavailable'}); }
  });
  app.get('/api/cameras/:id/zones',{onRequest:authenticate,schema:{params:cameraParams,querystring:empty}},async(req,reply)=>{
    const camera=cameras(config).find((c)=>c.id===req.params.id);
    if (!camera) return reply.code(404).send({error:'Not found'});
    if (!database.zones || !config.UNIVIEW_INSTALLATION_ID) return reply.code(503).send({error:'Persistence unavailable'});
    try {
      const zones=await database.zones.list(config.UNIVIEW_INSTALLATION_ID,camera.channel);
      const preferences=await database.zonePreferences?.list(config.UNIVIEW_INSTALLATION_ID,camera.channel) ?? null;
      return {cameraId:camera.id,channel:camera.channel,preferencesAvailable:preferences!==null && Boolean(database.zonePreferences?.save),zones:zones.map((zone)=>({id:zone.id,slot:zone.slot,name:zone.displayName,
        preference:preferences?.find(p=>p.zoneId===zone.id)??null,
        current:zone.versions[0] ? presentZoneVersion({...zone.versions[0],zone}) : null,
        versions:zone.versions.map((v)=>presentZoneVersion({...v,zone})),historyLimit:32,historyMayBeTruncated:zone.versions.length===32}))};
    } catch { return reply.code(503).send({error:'Persistence unavailable'}); }
  });
  return service;
}
