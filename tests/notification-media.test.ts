import { describe, expect, it } from 'vitest';
import { mediaLink, verifyMedia, notificationMedia, MEDIA_TTL_MS } from '../src/notifications/media.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createReceiverToolkit } from '../src/notifications/node-red-receiver.js';
import { samplePayload } from '../src/notifications/sample-payload.js';
import * as fs from 'node:fs';import * as path from 'node:path';import * as crypto from 'node:crypto';
const a='10000000-0000-4000-8000-000000000001', b='10000000-0000-4000-8000-000000000002',c='10000000-0000-4000-8000-000000000003',cfg={key:'a'.repeat(64),origin:'http://192.168.50.10:3000'},at=new Date('2026-10-21T12:00:00Z');
describe('scoped notification media',()=>{
it('binds image/event, key and expiry without general API credentials',()=>{const link=mediaLink(cfg,a,b,c,at),token=new URL(link.url).searchParams.get('token')!;expect(verifyMedia(cfg,token,a,b,at.getTime())).toBe(true);expect(verifyMedia(cfg,token,b,a,at.getTime())).toBe(false);expect(verifyMedia({...cfg,key:'b'.repeat(64)},token,a,b,at.getTime())).toBe(false);expect(verifyMedia(cfg,token,a,b,at.getTime()+MEDIA_TTL_MS)).toBe(false);expect(verifyMedia(cfg,token+'x',a,b,at.getTime())).toBe(false);expect(verifyMedia(undefined,token,a,b,at.getTime())).toBe(false);expect(link.url).not.toContain(cfg.key);});
it('rejects invalid/partial configuration',()=>{expect(notificationMedia({})).toBeUndefined();expect(()=>notificationMedia({NOTIFICATION_MEDIA_KEY:cfg.key})).toThrow();expect(()=>notificationMedia({NOTIFICATION_MEDIA_KEY:cfg.key,NOTIFICATION_MEDIA_ORIGIN:'http://user:pass@example.com'})).toThrow();});
it('retains Frigate Android formatting and exact event identity, validates the pinned media URL',()=>{const kit=createReceiverToolkit(fs,path,crypto,'unused',cfg.origin),body=samplePayload(c,a,at,'https://dashboard.example');body.sampleEventId=a;body.objects[0]!.zoneNames![0]!.name='My Driveway';body.images=[{id:b,path:`/api/events/${a}/images/${b}`,authentication:'dashboard_session_or_service_bearer',delivery:mediaLink(cfg,a,b,c,at)}];const sign=()=>{const raw=Buffer.from(JSON.stringify(body)),timestamp=String(at.getTime()/1000);return{raw,headers:{'content-type':'application/json','x-home-security-test':'true','idempotency-key':body.idempotencyKey,'x-home-security-timestamp':timestamp,'x-home-security-signature':'sha256='+crypto.createHmac('sha256','s'.repeat(32)).update(timestamp+'.'+body.idempotencyKey+'.').update(raw).digest('hex')}};};let s=sign();expect(kit.validate(s.raw,s.headers,'s'.repeat(32),a,at.getTime()).isTest).toBe(true);const n=kit.notification(body,true);expect(n.title).toContain('🚨 Front driveway');expect(n.message).toContain('13:00');expect(n.message).not.toContain(at.toISOString());expect(n.data.image).toBe(body.images[0]!.delivery!.url);expect(n.data).toMatchObject({notification_icon:'mdi:shield-alert',channel:'Home Security',importance:'high',priority:'high',ttl:0,event_id:'',sample_event_id:a});body.images[0]!.delivery!.url=body.images[0]!.delivery!.url.replace('192.168.50.10','169.254.169.254');s=sign();expect(()=>kit.validate(s.raw,s.headers,'s'.repeat(32),a,at.getTime())).toThrow();});
});

it('requires an exact scoped token on the media route and delegates to verified original retrieval',async()=>{
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',EVENTS_TOKEN:'e'.repeat(32),LOG_LEVEL:'silent',NOTIFICATION_MEDIA_KEY:cfg.key,NOTIFICATION_MEDIA_ORIGIN:cfg.origin});
 let calls=0;const service=buildApp(config,{checkReady:async()=>{},disconnect:async()=>{}},undefined,{image:async()=>{calls++;return Buffer.from([0xff,0xd8,0xff]);},enrich:async()=>({}),close:async()=>{}} as unknown as import('../src/events/nvr-service.js').NvrApi);
 try{const link=mediaLink(cfg,a,b,c,new Date());expect((await service.app.inject(`/api/notification-media/${a}/${b}?token=bad`)).statusCode).toBe(401);expect(calls).toBe(0);const r=await service.app.inject(link.url.replace(cfg.origin,''));expect(r.statusCode).toBe(200);expect(r.headers['content-type']).toContain('image/jpeg');expect(r.headers['cache-control']).toBe('no-store');expect(calls).toBe(1);expect((await service.app.inject('/api/events')).statusCode).toBe(401);}finally{await service.app.close();}
});

it('signs exact annotation coordinates, renders a proportionally resized full frame and never alters the original',async()=>{
 const sharp=(await import('sharp')).default,{annotatedFrame}=await import('../src/notifications/annotated-frame.js'),{mediaBoxes}=await import('../src/notifications/media.js');
 const original=await sharp({create:{width:3840,height:2160,channels:3,background:'#111111'}}).jpeg().toBuffer(),hash=crypto.createHash('sha256').update(original).digest('hex');
 const link=mediaLink(cfg,a,b,c,at,[[2500,2500,7500,7500]]),token=new URL(link.url).searchParams.get('token')!;expect(verifyMedia(cfg,token,a,b,at.getTime())).toBe(true);expect(mediaBoxes(token)).toEqual([[2500,2500,7500,7500]]);
 const result=await annotatedFrame(original,mediaBoxes(token)!,{variant:'full'});expect(await sharp(result).metadata()).toMatchObject({width:1280,height:720});
 const pixel=await sharp(result).extract({left:320,top:300,width:1,height:1}).raw().toBuffer();expect(pixel[0]).toBeGreaterThan(180);expect(crypto.createHash('sha256').update(original).digest('hex')).toBe(hash);
 const value=JSON.parse(Buffer.from(token.split('.')[0]!,'base64url').toString());value.boxes[0][0]=0;const tampered=Buffer.from(JSON.stringify(value)).toString('base64url')+'.'+token.split('.')[1];expect(verifyMedia(cfg,tampered,a,b,at.getTime())).toBe(false);
 await expect(annotatedFrame(original,[[9000,0,1000,100]])).rejects.toThrow('invalid_annotation');
 expect(()=>mediaLink(cfg,a,b,c,at,[[9000,0,1000,100]])).toThrow();
});

it('renders only through an authenticated signed derivative, leaving ordinary original retrieval untouched',async()=>{
 const sharp=(await import('sharp')).default, original=await sharp({create:{width:640,height:360,channels:3,background:'#111111'}}).jpeg().toBuffer();
 const config=loadConfig({DATABASE_URL:'postgresql://test:secret@invalid/security',EVENTS_TOKEN:'e'.repeat(32),LOG_LEVEL:'silent',NOTIFICATION_MEDIA_KEY:cfg.key,NOTIFICATION_MEDIA_ORIGIN:cfg.origin});
 const service=buildApp(config,{checkReady:async()=>{},disconnect:async()=>{}},undefined,{image:async(event:string,image:string)=>{expect([event,image]).toEqual([a,b]);return original;},enrich:async()=>({}),close:async()=>{}} as unknown as import('../src/events/nvr-service.js').NvrApi);
 try{const link=mediaLink(cfg,a,b,c,new Date(),[[2500,2500,7500,7500]]);const r=await service.app.inject(link.url.replace(cfg.origin,''));expect(r.statusCode).toBe(200);expect(r.rawPayload.equals(original)).toBe(false);const native=await service.app.inject({url:`/api/events/${a}/images/${b}`,headers:{authorization:'Bearer '+'e'.repeat(32)}});expect(native.rawPayload.equals(original)).toBe(true);expect((await service.app.inject(link.url.replace(cfg.origin,'')+'&boxes=0,0,10000,10000')).statusCode).toBe(400);}finally{await service.app.close();}
});
it('focuses with 1.8x context, thick red aligned boxes, edge clamping and a union of qualifying subjects',async()=>{
 const {frameLayout,annotatedFrame}=await import('../src/notifications/annotated-frame.js'),sharp=(await import('sharp')).default;
 const boxes=[[5000,2000,5500,4000]],layout=frameLayout(3840,2160,boxes);expect(layout.width).toBeLessThan(3840);expect(layout.targetWidth).toBe(1280);expect(layout.targetHeight).toBeGreaterThanOrEqual(719);expect(layout.targetHeight).toBeLessThanOrEqual(721);expect(layout.rectangles[0]!.height/layout.targetHeight).toBeCloseTo(1/1.8,2);
 const image=await sharp({create:{width:3840,height:2160,channels:3,background:'#111111'}}).jpeg().toBuffer(),rendered=await annotatedFrame(image,boxes),r=layout.rectangles[0]!;
 const red=await sharp(rendered).extract({left:Math.round(r.x),top:Math.round(r.y+r.height/2),width:1,height:1}).raw().toBuffer();expect(red[0]).toBeGreaterThan(180);expect(red[1]).toBeLessThan(90);
 const thick=await sharp(rendered).extract({left:Math.round(r.x+2),top:Math.round(r.y+r.height/2),width:1,height:1}).raw().toBuffer();expect(thick[0]).toBeGreaterThan(150);
 for(const b of [[[0,0,100,200]],[[9800,9800,10000,10000]],[[0,1000,2000,9000],[8000,1000,10000,9000]]]){const l=frameLayout(3840,2160,b);expect(l.left).toBeGreaterThanOrEqual(0);expect(l.top).toBeGreaterThanOrEqual(0);expect(l.left+l.width).toBeLessThanOrEqual(3840);expect(l.top+l.height).toBeLessThanOrEqual(2160);for(const rect of l.rectangles){expect(rect.x).toBeGreaterThanOrEqual(-0.01);expect(rect.y).toBeGreaterThanOrEqual(-0.01);expect(rect.x+rect.width).toBeLessThanOrEqual(l.targetWidth+0.01);expect(rect.y+rect.height).toBeLessThanOrEqual(l.targetHeight+0.01);}}
 expect(()=>frameLayout(3840,2160,boxes,{contextFactor:0})).toThrow();expect(frameLayout(3840,2160,boxes,{variant:'full'}).width).toBe(3840);
 const {mediaFrameOptions}=await import('../src/notifications/media.js');const link=mediaLink({...cfg,contextFactor:2.2},a,b,c,at,boxes);expect(mediaFrameOptions(new URL(link.url).searchParams.get('token')!)).toEqual({variant:'focused',contextFactor:2.2});
});

it('keeps initial and enriched phone text concise, with the same quiet tag and local time',()=>{
 const kit=createReceiverToolkit(fs,path,crypto,'unused',cfg.origin);
 const body=samplePayload(c,a,at,'https://dashboard.example');body.sampleEventId=a;body.timestamps.occurredAt=at.toISOString();
 body.objects[0]!.zoneNames![0]!.name='My Driveway';
 const initial=kit.notification(body,true);
 expect(initial.message).toContain('Someone detected\n13:00');
 expect(initial.message).not.toContain('(My Driveway)');
 const update=kit.notification({...body,action:'update',ai:{status:'completed',revision:1,summary:'A person appears to be walking.'}},true);
 expect(update.message).toContain('Someone appears to be walking.\n13:00');
 expect(update.message).not.toContain('My Driveway');
 expect(update.data.tag).toBe(initial.data.tag);expect(update.data.alert_once).toBe(true);
 body.objects[0]!.zoneNames![0]!.name='My Walkway';
 expect(kit.notification(body,true).message).toContain('Someone detected\n13:00');
 expect(kit.notification(body,true).message).not.toContain('(My Walkway)');
});
