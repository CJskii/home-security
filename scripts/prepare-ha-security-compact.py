"""Local-only property-focused Security proposal. Never write to the HA mirror."""
import os
import argparse,datetime,difflib,hashlib,json,re
from pathlib import Path
import yaml
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
out=a.output.resolve();live=Path(os.environ['HA_CONFIG_ROOT']).resolve()
if out==live or live in out.parents:raise SystemExit('Output must be outside live HA')
out.mkdir(mode=0o700,parents=True,exist_ok=False)
original=a.source.read_text();before=yaml.safe_load(original);old=next(v for v in before['views'] if v.get('path')=='security')
start=original.index('    title: "Security"');end=original.index('  - title: Front / right side',start)
source=original[start:end]
# Keep all original shared anchors intact for unchanged legacy subviews.
blocks=list(re.finditer(r'^      -(?=\s|$)',source,re.M))
for i in reversed(range(len(blocks))):
 b=blocks[i].start();line_end=source.index('\n',b);line=source[b:line_end];rest=line[len('      -'):].strip()
 source=source[:b]+'      - &hs_original_section_'+str(i)+'\n'+('        '+rest+'\n' if rest else '')+source[line_end+1:]
esc="const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;',\"'\":'&#39;'}[c]));"
def row(kind,index=0):
 return {'type':'custom:button-card','entity':'sensor.home_security_history','triggers_update':['sensor.home_security_history'],
 'variables':{'kind':kind,'index':index,'row':"[[[ return states['sensor.home_security_history']?.attributes?.[variables.kind]?.[variables.index] ?? null; ]]]"},
 'show_icon':False,'show_label':True,'show_state':False,
 'name':'[[[ '+esc+' return esc(variables.row?.title); ]]]',
 'label':"[[[ const r=variables.row;return html`<div class=\"row-meta\"><span>${r?.cameraLabel?r.cameraLabel+' · ':''}${r?.time??''}</span><span>${r?.subtitle??''}</span></div>`; ]]]",
 'tap_action':{'action':"[[[ return variables.row?'url':'none'; ]]]",'url_path':"[[[ return variables.row?.url; ]]]"},'hold_action':{'action':'none'},
 'custom_fields':{'media':'''[[[ const r=variables.row;
   const image=variables.kind==='propertyDetections'?r?.thumbnail:null;
   return html`<div class="thumb"><ha-icon icon=${r?.icon??'mdi:cctv'} style=${'color:'+({teal:'var(--teal-color,#009688)',amber:'var(--amber-color,#ffc107)',red:'var(--red-color,#f44336)',grey:'var(--secondary-text-color)'})[r?.tone??'grey']}></ha-icon>${image?html`<img src=${image} alt="Original detection crop" loading="lazy" @error=${e=>{const img=e.currentTarget;const n=Number(img.dataset.retry??0);if(n<2){img.dataset.retry=String(n+1);setTimeout(()=>{if(img.isConnected)img.src=image;},2200*(n+1));}else img.hidden=true;}} />`:''}</div>`; ]]]'''},
 'extra_styles':'.thumb{position:relative;width:56px;height:56px;border-radius:10px;background:var(--secondary-background-color);display:grid;place-items:center;overflow:hidden}.thumb ha-icon{width:24px;color:var(--secondary-text-color)}.thumb img{position:absolute;inset:0;width:56px;height:56px;object-fit:contain;background:var(--secondary-background-color)}.thumb img[hidden]{display:none}.row-meta{width:100%;text-align:left;line-height:18px}.row-meta span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
 'styles':{'card':[{'display':"[[[ const s=states['sensor.home_security_history'];return variables.row&&Date.now()-Date.parse(s?.state)<90000?'block':'none'; ]]]"},{'height':'80px'},{'padding':'10px 12px'},{'border-radius':'16px'},{'border':'1px solid var(--divider-color)'},{'box-shadow':'none'},{'background':'var(--ha-card-background, var(--card-background-color))'}],
 'grid':[{'grid-template-areas':'"media n" "media l"'},{'grid-template-columns':'56px minmax(0,1fr)'},{'grid-template-rows':'20px 36px'},{'column-gap':'10px'}],
 'name':[{'justify-self':'start'},{'text-align':'left'},{'max-width':'100%'},{'font-size':'14px'},{'font-weight':'600'},{'white-space':'nowrap'},{'overflow':'hidden'},{'text-overflow':'ellipsis'}],
 'label':[{'width':'100%'},{'max-width':'100%'},{'align-self':'start'},{'justify-self':'stretch'},{'text-align':'left'},{'font-size':'12px'},{'line-height':'18px'},{'white-space':'normal'},{'color':'var(--secondary-text-color)'},{'overflow':'hidden'},{'display':'block'},{'-webkit-line-clamp':'2'},{'-webkit-box-orient':'vertical'}]}}
def heading(title,icon):return {'type':'heading','heading':title,'icon':icon,'heading_style':'title','card_mod':old['sections'][3]['cards'][0]['card_mod']}
def link(title,url,subtitle):return {'type':'custom:mushroom-template-card','entity':'sensor.home_security_history','primary':title,'secondary':subtitle,'icon':'mdi:arrow-top-right','multiline_secondary':True,'tap_action':{'action':'url','url_path':url},'card_mod':{'style':'ha-card{border:none;box-shadow:none;background:transparent;--mush-spacing:8px}'}}
def zone(name,ch,slot,anchor=None,entity=None,nav=None):
 z="{% set z=(state_attr('sensor.home_security_history','zoneActivity') or [])|selectattr('channel','eq',"+str(ch)+")|selectattr('slot','eq',"+str(slot)+")|list %}"
 secondary=z+"{% set t=as_timestamp(states('sensor.home_security_history'),0) %}{% if not t or as_timestamp(now())-t>90 %}Activity unavailable{% elif not z %}Zone configuration unavailable{% elif z[0].stale %}Sync stale · last verified only{% elif not z[0].enabled %}Rule disabled{% elif z[0].lastActivityAt %}{{ as_timestamp(z[0].lastActivityAt)|timestamp_custom('%d %b %H:%M',true) }} · {{ relative_time(as_datetime(z[0].lastActivityAt)) }} ago{% else %}No verified activity for current polygon{% endif %}"
 color=z+"{{ 'teal' if z and z[0].lastActivityAt and not z[0].stale else 'grey' }}"
 card={'type':'custom:mushroom-template-card','entity':entity or 'sensor.home_security_history','primary':name,'secondary':secondary,'multiline_secondary':True,'icon':'mdi:shield-home-outline' if slot==0 else 'mdi:cctv','icon_color':color,'tap_action':{'action':'url','url_path':'https://security.example.com/explore?location='+'interested' if slot==0 else 'https://security.example.com/explore?location=other'},'card_mod':{'style':'ha-card{border-radius:16px;box-shadow:none;--mush-spacing:8px;--mush-icon-size:28px;--mush-card-primary-font-size:14px;--mush-card-secondary-font-size:12px;min-height:80px}'}}
 if nav:card['tap_action']={'action':'navigate','navigation_path':nav}
 if anchor:card={'<<':'__ALIAS_'+anchor,**card}
 return card
def grid(cards,columns=2):return {'type':'grid','columns':columns,'square':False,'cards':cards,'grid_options':{'columns':'full','rows':'auto'},'card_mod':{'style':'#root{gap:8px}@media(max-width:700px){#root{grid-template-columns:minmax(0,1fr)}}'}}
def section(cards):return {'type':'grid','column_span':2,'cards':cards}
property_cards=[zone('My Driveway',1,0,'security_zone_front_right','input_button.security_front_right','/master-home/security-front-right'),zone('My Walkway',2,0,'security_zone_back_walkway','input_button.security_back_walkway','/master-home/security-back-walkway')]
other_cards=[zone('Road',1,3,'security_zone_road','input_button.security_road','/master-home/security-road'),zone('Neighbour A · C1',1,1),zone('Neighbour B · C1',1,2),zone('Neighbour B · C2',2,1)]
legacy=[]
for anchor,entity,title,nav in [('security_zone_front_intrusion','input_button.security_front_intrusion','Front intrusion','/master-home/security-front-intrusion'),('security_zone_back_intrusion','input_button.security_back_intrusion','Back intrusion','/master-home/security-back-intrusion')]:
 legacy.append({'<<':'__ALIAS_'+anchor,'entity':entity,'primary':title,'secondary':"Unmapped legacy source · last report {{ as_timestamp(states(entity),0)|timestamp_custom('%d %b %H:%M',true) if as_timestamp(states(entity),0) else 'unknown' }}",'icon_color':'grey','tap_action':{'action':'navigate','navigation_path':nav}})
sections=['__ALIAS_hs_original_section_1','__ALIAS_hs_original_section_2',section([heading('My Property','mdi:shield-home-outline'),{**grid(property_cards),'card_mod':{'style':'#root{gap:8px}'}},link('Recent property detections','https://security.example.com/explore?location=interested','Verified zone matches · View all'),grid([row('propertyDetections',i) for i in range(4)],1)]),section([heading('Other Camera Activity','mdi:map-marker-outline'),{**grid(other_cards),'card_mod':{'style':'#root{gap:8px}'}},link('Other zones','https://security.example.com/explore?location=other','Road, Neighbour B and Neighbour A · View all'),grid([row('otherDetections',i) for i in range(2)],1),grid(legacy)]),section([heading('Notifications','mdi:bell-outline'),link('Notification history','https://security.example.com/settings','Webhook acceptance is not handset confirmation · View all'),grid([row('notificationRows',i) for i in range(4)],1)]),'__ALIAS_hs_original_section_5','__ALIAS_hs_original_section_6']
# Reuse the row style by YAML aliases; keep actual layout mobile single-column.
common=sections[2]['cards'][3]['cards'][0]
for sec in sections:
 if isinstance(sec,dict):
  for c in sec['cards']:
   for r in c.get('cards',[]):
    if r.get('type')=='custom:button-card':r['styles']=common['styles'];r['extra_styles']=common['extra_styles'];r['custom_fields']=common['custom_fields']
dump=yaml.safe_dump({'sections':sections},sort_keys=False,allow_unicode=True,width=1500)
dump=re.sub(r"'<<': __ALIAS_(\w+)",r'<<: *\1',dump);dump=re.sub(r'__ALIAS_(\w+)',r'*\1',dump)
candidate=original[:start]+'    <<: &hs_original_security\n'+''.join('  '+line+'\n' for line in source.splitlines())+''.join('    '+line+'\n' for line in dump.splitlines())+original[end:]
after=yaml.safe_load(candidate);view=next(v for v in after['views'] if v.get('path')=='security')
for b,c in zip(before['views'],after['views']):
 if b.get('path')!='security':assert b==c,'Unrelated view changed'
assert len(after['views'])==21 and view['sections'][:2]==old['sections'][1:3]
assert view['sections'][-2:]==old['sections'][-2:]
for card in [*view['sections'][2]['cards'][1]['cards'],view['sections'][3]['cards'][1]['cards'][0],*view['sections'][3]['cards'][-1]['cards']]:assert card['entity'].startswith('input_button.security_')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
(out/'master-home.proposed.yaml').write_text(candidate);(out/f'master-home.original.{stamp}.yaml').write_text(original);(out/'dashboard.json').write_text(json.dumps(after));(out/'master-home.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),candidate.splitlines(True),fromfile='master-home.original.yaml',tofile='master-home.proposed.yaml')))
config=(a.source.parent.parent/'configuration.yaml').read_text();assert config.count('          - eventCount\n')==1;new=config.replace('          - eventCount\n','          - eventCount\n'+''.join('          - '+k+'\n' for k in ['detections','notificationRows','zoneActivity','dashboardUrl','propertyDetections','otherDetections']))
assert new!=config
(out/'configuration.proposed.yaml').write_text(new);(out/f'configuration.original.{stamp}.yaml').write_text(config);(out/'configuration.diff').write_text(''.join(difflib.unified_diff(config.splitlines(True),new.splitlines(True),fromfile='configuration.original.yaml',tofile='configuration.proposed.yaml')))
(out/'validation.json').write_text(json.dumps({'sourceSha256':hashlib.sha256(original.encode()).hexdigest(),'otherViewsUnchanged':20,'cameraMotionPresenceUnchanged':True,'originalActivityEntityIdsRetained':5,'primaryRows':4,'secondaryRows':2,'notificationRows':4,'rowHeight':80},indent=2))
for f in out.iterdir():f.chmod(0o600)
print('Prepared:',out)
