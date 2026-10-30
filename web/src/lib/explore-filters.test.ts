import {expect,it} from 'vitest';
import {exploreRange,exploreParams,londonCandidates,londonInstant,londonInput} from './explore-filters';
it('converts London dates independently of the browser timezone and rejects nonexistent or ambiguous local times',()=>{
 expect(londonInput('2026-07-01T12:00:00Z')).toBe('2026-07-01T13:00');
 expect(londonCandidates('2026-03-29T01:30')).toEqual([]);expect(()=>londonInstant('2026-03-29T01:30')).toThrow('does not exist');
 expect(londonCandidates('2026-10-25T01:30')).toEqual([Date.parse('2026-10-25T00:30:00Z'),Date.parse('2026-10-25T01:30:00Z')]);expect(()=>londonInstant('2026-10-25T01:30')).toThrow('occurs twice');
 expect(londonInstant('2026-10-25T01:30','earlier')).toBe(Date.parse('2026-10-25T00:30:00Z'));expect(londonInstant('2026-10-25T01:30','later')).toBe(Date.parse('2026-10-25T01:30:00Z'));expect(londonCandidates('2026-02-30T12:00')).toEqual([]);
});
it.each([['2026-03-30T12:00:00Z','2026-03-29T00:00:00.000Z','2026-03-29T22:59:59.999Z',23],['2026-10-26T12:00:00Z','2026-10-24T23:00:00.000Z','2026-10-25T23:59:59.999Z',25]])('uses London calendar days for Yesterday at %s',(now,start,end,hours)=>{
 const r=exploreRange(new URLSearchParams('time=yesterday'),Date.parse(now));expect(r.after).toBe(start);expect(r.before).toBe(end);expect(Date.parse(r.before!)-Date.parse(r.after!)+1).toBe(hours*3600000);
});
it('bounds Today at local midnight, retains fixed anchors and clears time without dropping other filters',()=>{
 const now=Date.parse('2026-07-01T12:00:00Z');expect(exploreRange(new URLSearchParams('time=today'),now).after).toBe('2026-06-30T23:00:00.000Z');
 const p=exploreParams(new URLSearchParams('time=hour&at=2026-10-25T01:30:00Z&sort=oldest&aiOutcome=capacity&location=interested'),'camera_2',now);expect(p.get('occurredAfter')).toBe('2026-10-25T00:30:00.000Z');expect(p.get('sort')).toBe('oldest');expect(p.get('aiOutcome')).toBe('capacity');expect(p.get('interestedZonesOnly')).toBe('true');
 const any=exploreParams(new URLSearchParams('time=all&notificationOutcome=accepted'),'all',now);expect(any.has('occurredAfter')).toBe(false);expect(any.has('occurredBefore')).toBe(false);expect(any.get('notificationOutcome')).toBe('accepted');
});
it('preserves exact custom UTC bounds and rejects reversed or incomplete bookmarked ranges',()=>{
 const s=new URLSearchParams('time=custom&from=2026-10-25T00:30:00Z&to=2026-10-25T01:30:59.999Z');expect(exploreRange(s,0)).toMatchObject({after:'2026-10-25T00:30:00.000Z',before:'2026-10-25T01:30:59.999Z'});s.set('from','2026-10-26T01:00:00Z');expect(exploreRange(s,0).error).toBeTruthy();s.delete('to');expect(exploreRange(s,0).error).toBeTruthy();
});
