import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaLoader } from "./media";
import { ImageQueue, api } from "./api";
import { z } from "zod";
const path = (image: number, event = 1) => `/api/events/${event.toString(16).padStart(8,"0")}-cc3d-4db5-9bdd-f7d89e8149bb/images/${image.toString(16).padStart(8,"0")}-cc3d-4db5-9bdd-f7d89e8149bb`;
const response = () => new Response(new Uint8Array([255,216,255,217]), {headers:{"content-type":"image/jpeg"}});
const revoke = vi.fn();
const loaders: MediaLoader[] = [];
function loader(bytes = 48, entries = 8, queue = new ImageQueue(2)) { const value = new MediaLoader(bytes,entries,queue);loaders.push(value);return value; }
beforeEach(()=>{
  let sequence=0;
  vi.stubGlobal("URL",class extends URL {static createObjectURL=vi.fn(()=>`blob:synthetic-${++sequence}`);static revokeObjectURL=revoke;});
  revoke.mockClear();
});
afterEach(()=>{loaders.forEach(value=>value.clear());loaders.length=0;vi.unstubAllGlobals();vi.restoreAllMocks();});
it("keeps session-owned URLs across time/navigation, with exact event/image keys and LRU entry/byte bounds",async()=>{
  const fetcher=vi.fn(async()=>response());vi.stubGlobal("fetch",fetcher);
  const cache=loader(8,2),signal=new AbortController().signal;
  const first=await cache.load(path(1),signal);await cache.load(path(2),signal);
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+600_000);
  expect(await cache.load(path(1),signal)).toBe(first);
  await cache.load(path(3),signal);
  expect(cache.getCached(path(2))).toBeUndefined();expect(cache.getCached(path(1))).toBe(first);
  expect(revoke).toHaveBeenCalledTimes(1);expect(cache.usage()).toMatchObject({bytes:8,entries:2});
  await cache.load(path(1,2),signal);expect(fetcher).toHaveBeenCalledTimes(4);
  expect(cache.getCached(path(1,2))).not.toBe(first);
  cache.clear();expect(cache.usage()).toEqual({bytes:0,entries:0,active:0,queued:0});
  expect(revoke).toHaveBeenCalledTimes(4);
});
it("shares a request and finishes started transport into RAM after viewers detach",async()=>{
  let finish!:()=>void;let transport:AbortSignal|undefined;
  const fetcher=vi.fn((_path:string,options:RequestInit)=>{transport=options.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=()=>resolve(response());});});vi.stubGlobal("fetch",fetcher);
  const cache=loader(),a=new AbortController(),b=new AbortController();
  const first=cache.load(path(1),a.signal),firstResult=expect(first).rejects.toThrow();
  const second=cache.load(path(1),b.signal),secondResult=expect(second).rejects.toThrow();
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());a.abort();b.abort();await Promise.all([firstResult,secondResult]);
  expect(transport?.aborted).toBe(false);finish();await vi.waitFor(()=>expect(cache.getCached(path(1))).toBeTruthy());
  expect(await cache.load(path(1),new AbortController().signal)).toBe(cache.getCached(path(1)));
  expect(fetcher).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();
});
it("discards abandoned queued work but lets a same-turn remount reattach",async()=>{
  const finish:(()=>void)[]=[];const fetcher=vi.fn<typeof fetch>(()=>new Promise<Response>(resolve=>finish.push(()=>resolve(response()))));vi.stubGlobal("fetch",fetcher);
  const cache=loader(48,8,new ImageQueue(1)),first=cache.load(path(1),new AbortController().signal);
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  const a=new AbortController(),abandoned=cache.load(path(2),a.signal),outcome=expect(abandoned).rejects.toThrow();a.abort();await outcome;
  const b=new AbortController(),old=cache.load(path(3),b.signal),oldResult=expect(old).rejects.toThrow();b.abort();const remount=cache.load(path(3),new AbortController().signal);await oldResult;
  finish[0]!();await first;await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));finish[1]!();await remount;
  expect(fetcher.mock.calls.map(call=>call[0])).toEqual([path(1),path(3)]);
});
it("prioritizes currently visible queued work while retaining the two-request limit",async()=>{
  const queue=new ImageQueue(2),finish:(()=>void)[]=[],order:string[]=[];
  const operation=(name:string)=>()=>{order.push(name);return new Promise<void>(resolve=>finish.push(resolve));};
  const a=queue.run(operation('a'),new AbortController().signal),b=queue.run(operation('b'),new AbortController().signal);
  const prefetch=queue.run(operation('prefetch'),new AbortController().signal,()=>0);
  let visible=false;const important=queue.run(operation('visible'),new AbortController().signal,()=>visible?1:0);
  await vi.waitFor(()=>expect(order).toEqual(['a','b']));visible=true;finish[0]!();await a;
  await vi.waitFor(()=>expect(order).toEqual(['a','b','visible']));finish[1]!();finish[2]!();await Promise.all([b,important]);await vi.waitFor(()=>expect(order).toContain('prefetch'));finish[3]!();await prefetch;
});
it("does not retain failed, oversized or invalid image requests and allows explicit retry",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response('{}',{status:503})).mockImplementation(async()=>response());vi.stubGlobal('fetch',fetcher);
  const cache=loader(),signal=new AbortController().signal;
  await expect(cache.load(path(1),signal)).rejects.toThrow('NVR busy');expect(cache.getCached(path(1))).toBeUndefined();
  await cache.load(path(1),signal);expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(loader(2).load(path(2),signal)).rejects.toThrow('memory limit');
  await expect(cache.load('https://untrusted/image',signal)).rejects.toThrow('Invalid media reference');expect(fetcher).toHaveBeenCalledTimes(3);
});
it("revokes cached URLs and blocks late responses from repopulating a cleared session",async()=>{
  let finish!:()=>void;vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response()).mockImplementation(()=>new Promise<Response>(resolve=>{finish=()=>resolve(response());})));
  const cache=loader(),signal=new AbortController().signal;await cache.load(path(1),signal);
  const pending=cache.load(path(2),signal),result=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  cache.clear();finish();await result;expect(cache.usage()).toEqual({bytes:0,entries:0,active:0,queued:0});expect(revoke).toHaveBeenCalledOnce();
});
it("notifies mounted viewers when entries are evicted or session URLs are revoked",async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response()));const cache=loader(4,1),signal=new AbortController().signal,notify=vi.fn();
  const unsubscribe=cache.subscribe(path(1),notify);await cache.load(path(1),signal);await cache.load(path(2),signal);
  expect(notify).toHaveBeenCalledTimes(2);expect(cache.getCached(path(1))).toBeUndefined();unsubscribe();cache.clear();
});
it("purges shared sensitive media when any authenticated metadata endpoint returns 401",async()=>{
  const {mediaLoader}=await import('./media');vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('{}',{status:401})));
  await mediaLoader.load(path(1),new AbortController().signal);await expect(api('/api/events',z.object({}))).rejects.toThrow('session has ended');
  expect(mediaLoader.usage().entries).toBe(0);expect(revoke).toHaveBeenCalledOnce();
});
it("evicts by JPEG byte budget independently of the entry limit",async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response()));const cache=loader(8,100),signal=new AbortController().signal;
  await cache.load(path(1),signal);await cache.load(path(2),signal);await cache.load(path(3),signal);
  expect(cache.usage()).toMatchObject({bytes:8,entries:2});expect(cache.getCached(path(1))).toBeUndefined();expect(revoke).toHaveBeenCalledOnce();
});
it("clears images immediately when media authentication expires",async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('{}',{status:401})));
  const cache=loader(),signal=new AbortController().signal;await cache.load(path(1),signal);
  await expect(cache.load(path(2),signal)).rejects.toThrow('Sign in again');expect(cache.usage().entries).toBe(0);expect(revoke).toHaveBeenCalledOnce();
});
