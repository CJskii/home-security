import { notificationHistory, type DeliveryHistory } from './history.js';
import { projectNotificationEvent } from './geometry.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { cameraSnapshotSchema } from '../uniview/camera-configuration.js';
import { cameras } from '../uniview/verified-streams.js';
import type { Config } from '../config.js';
import { locationCatalog } from '../events/locations.js';
import { notificationConfiguration,notificationWindow,NotificationConflict,NotificationLimit,type NotificationConfiguration,type NotificationWindow } from './contracts.js';
import { evaluateNotifications,NOTIFICATION_ALGORITHM } from './evaluate.js';
export interface NotificationStore {
  read(installation:string):Promise<unknown>;
  history?:(installation:string,before?:string,attemptedOnly?:boolean,eventIds?:readonly string[])=>Promise<DeliveryHistory>;
  evaluation(installation:string,id:string):Promise<unknown|null>;
  preview(installation:string,window:NotificationWindow):Promise<unknown>;
  save?:(installation:string,revision:number,configuration:NotificationConfiguration)=>Promise<unknown>;
  archive?:(installation:string,window:NotificationWindow,revision:number,fingerprint:string)=>Promise<unknown>;
}
const empty:NotificationConfiguration={deliveryEnabled:false,rules:[]};
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function missing(error:unknown){return !!error&&typeof error==='object'&&'code'in error&&error.code==='P2021';}
export function createNotificationStore(prisma:PrismaClient,config:Config):NotificationStore {
  const cameraCatalog=cameras(config).map(c=>({channel:c.channel,name:c.name}));
  async function catalog(tx:Prisma.TransactionClient,installation:string){return tx.univiewZone.findMany({where:{sourceInstallationId:installation},include:{preference:true},orderBy:[{channel:'asc'},{slot:'asc'}],take:9});}
  async function validate(tx:Prisma.TransactionClient,installation:string,value:NotificationConfiguration){
    const zones=await catalog(tx,installation);
    for(const rule of value.rules){if(rule.channels.some(c=>!cameraCatalog.some(v=>v.channel===c))||rule.zoneIds.some(id=>!zones.some(z=>z.id===id&&rule.channels.includes(z.channel)))||rule.channels.some(c=>!zones.some(z=>z.channel===c&&rule.zoneIds.includes(z.id))))throw new NotificationConflict('Review camera and zone selections');}
  }
  async function read(installation:string){
    const zones=await catalog(prisma,installation);let row=null,available=true;
    try{row=await prisma.notificationConfiguration.findUnique({where:{sourceInstallationId:installation}});}catch(error){if(missing(error))available=false;else throw error;}
    const configuration=row?notificationConfiguration.parse(row.configuration):empty;
    const cameraStates=await prisma.cameraConfiguration.findMany({where:{sourceInstallationId:installation},select:{channel:true,snapshot:true},take:2});
    const names=cameraCatalog.map(c=>{const parsed=cameraSnapshotSchema.safeParse(cameraStates.find(s=>s.channel===c.channel)?.snapshot);return {...c,name:parsed.success?parsed.data.name??c.name:c.name};});
    let evaluations:unknown[]=[];if(available)evaluations=await prisma.notificationEvaluation.findMany({where:{sourceInstallationId:installation,kind:'PREVIEW'},orderBy:{createdAt:'desc'},take:5,select:{id:true,fingerprint:true,configurationRevision:true,createdAt:true}});
    return {available,deliveryAvailable:false,revision:row?.revision??0,updatedAt:row?.updatedAt.toISOString()??null,configuration,cameras:names,
      zones:zones.map(z=>({id:z.id,channel:z.channel,slot:z.slot,name:z.preference?.displayName??z.displayName})),evaluations};
  }
  async function calculate(tx:Prisma.TransactionClient,installation:string,input:NotificationWindow){
    const window=notificationWindow.parse(input);if(Date.parse(window.to)>Date.now()+60000)throw new NotificationConflict('Preview cannot include future events');
    const row=await tx.notificationConfiguration.findUnique({where:{sourceInstallationId:installation}}),configuration=row?notificationConfiguration.parse(row.configuration):empty;
    await validate(tx,installation,configuration);
    const versions=(await locationCatalog(tx,installation)).sort((a,b)=>a.channel-b.channel||a.slot-b.slot||(a.revision??0)-(b.revision??0)||a.id.localeCompare(b.id));
    // Full bounded cohort, never only a browser page. Exceeding the bound fails
    // explicitly rather than silently producing incomplete cooldown decisions.
    const rows=await tx.securityEvent.findMany({where:{sourceInstallationId:installation,firstReceivedAt:{gte:new Date(window.from),lt:new Date(window.to)}},orderBy:[{firstReceivedAt:'asc'},{id:'asc'}],take:1001,
      select:{id:true,nvrChannel:true,firstReceivedAt:true,objects:{take:129,orderBy:{id:'asc'},select:{id:true,category:true,coordinateStatus:true,sourceTimestamp:true,xMin:true,yMin:true,xMax:true,yMax:true,fullFrameSnapshotId:true,memberships:{take:17,orderBy:{zoneVersionId:'asc'},select:{zoneVersionId:true,relationship:true}}}}}});
    if(rows.length>1000)throw new NotificationLimit('More than 1,000 events; select a shorter preview window');
    if(rows.reduce((n,e)=>n+e.objects.length,0)>4096)throw new NotificationLimit('More than 4,096 source observations; select a shorter window');
    const events=rows.map(e=>projectNotificationEvent(e,versions));
    const result=evaluateNotifications(installation,configuration,events,window),revision=row?.revision??0;
    const fingerprint=createHash('sha256').update(JSON.stringify({installation,revision,configuration,events,window,algorithm:NOTIFICATION_ALGORITHM})).digest('hex');
    return {...result,revision,fingerprint,cooldownScope:'preview_window_only' as const,objects:events.map(e=>({eventId:e.id,objects:e.objects})),configuration};
  }
  return {read,history:(installation,before,attemptedOnly,eventIds)=>notificationHistory(prisma,installation,before,attemptedOnly,eventIds),evaluation:async(installation,id)=>{const row=await prisma.notificationEvaluation.findFirst({where:{id,sourceInstallationId:installation,kind:'PREVIEW'},select:{result:true}});return row?.result??null;},preview:(installation,window)=>prisma.$transaction(tx=>calculate(tx,installation,window),{isolationLevel:'RepeatableRead',timeout:10000}),
    async save(installation,revision,input){const value=notificationConfiguration.parse(input);await prisma.$transaction(async tx=>{
      await validate(tx,installation,value);const previous=await tx.notificationConfiguration.findUnique({where:{sourceInstallationId:installation}});
      if((previous?.revision??0)!==revision)throw new NotificationConflict('Settings changed; reload before saving');
      if(previous&&isDeepStrictEqual(notificationConfiguration.parse(previous.configuration),value))return;
      await tx.notificationConfiguration.upsert({where:{sourceInstallationId:installation},create:{sourceInstallationId:installation,configuration:json(value)},update:{configuration:json(value),revision:{increment:1}}});
    },{isolationLevel:'Serializable',timeout:5000});return read(installation);},
    async archive(installation,window,revision,fingerprint){return prisma.$transaction(async tx=>{
      const result=await calculate(tx,installation,window);if(result.revision!==revision||result.fingerprint!==fingerprint)throw new NotificationConflict('Preview changed; run it again before saving');
      const row=await tx.notificationEvaluation.upsert({where:{sourceInstallationId_fingerprint:{sourceInstallationId:installation,fingerprint}},create:{sourceInstallationId:installation,fingerprint,configurationRevision:revision,configuration:json(result.configuration),result:json(result)},update:{},select:{id:true,fingerprint:true,configurationRevision:true,createdAt:true}});return {...row,deliveryAvailable:false};
    },{isolationLevel:'Serializable',timeout:10000});},
  };
}
