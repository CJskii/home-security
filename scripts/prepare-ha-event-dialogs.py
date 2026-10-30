"""Prepare exact event-dialog HA patches in runtime; never write the live mirror."""
import argparse,copy,difflib,json
from pathlib import Path
import yaml
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--review',type=Path,required=True);p.add_argument('--source',type=Path,required=True);p.add_argument('--configuration',type=Path,required=True);a=p.parse_args();r=a.review.resolve();assert r.is_relative_to(Path('runtime').resolve());r.mkdir(parents=True,exist_ok=True,mode=0o700)
s=a.source.read_text();d=yaml.safe_load(s);t=copy.deepcopy(d['button_card_templates']);t['hs_design_base']['variables']['history']=json.loads((r/'history-variable.json').read_text())
t['hs_design_zone']['tap_action']={'action':'javascript','javascript':'[[[ void variables.history.openZoneHistory(hass,variables.channel,variables.slot); ]]]'}
t['hs_design_activity']['tap_action']={'action':'javascript','javascript':'[[[ if(variables.row)void variables.history.openEventDetails(hass,variables.row.eventId); ]]]'}
t['hs_design_activity']['custom_fields']['body']=t['hs_design_activity']['custom_fields']['body'].replace('mdi:arrow-top-right','mdi:chevron-right')
for name,marker in [('hs_design_notifications','class="notice"'),('hs_design_other','class="other-row"')]:
 b=t[name]['custom_fields']['body'];old='@click=${e=>e.stopPropagation()} '+marker
 new='@click=${e=>{e.preventDefault();e.stopPropagation();void variables.history.openEventDetails(hass,r.eventId);}} '+marker
 assert old in b;b=b.replace(old,new)
 if name=='hs_design_other':
  old='@click=${e=>e.stopPropagation()} href=${\'https://security.example.com/explore?location=\'+(z?.zoneId??\'other\')}'
  new='@click=${e=>{e.preventDefault();e.stopPropagation();if(z)void variables.history.openZoneHistory(hass,channel,slot);}} href=${\'https://security.example.com/explore?location=\'+(z?.zoneId??\'other\')}'
  assert old in b;b=b.replace(old,new)
 t[name]['custom_fields']['body']=b
node=yaml.compose(s)
def child(n,k):return next(v for key,v in n.value if key.value==k)
changes=[]
for name in ['hs_design_base','hs_design_zone','hs_design_activity','hs_design_notifications','hs_design_other']:
 n=child(child(node,'button_card_templates'),name);start=n.start_mark.index-n.start_mark.column;end=n.end_mark.index-n.end_mark.column
 value=yaml.safe_dump(t[name],sort_keys=False,width=120,allow_unicode=True);changes.append((start,end,''.join(' '*n.start_mark.column+line+'\n' for line in value.splitlines())))
new=s
for start,end,value in sorted(changes,reverse=True):new=new[:start]+value+new[end:]
parsed=yaml.safe_load(new);assert parsed['views']==d['views']
assert {k:v for k,v in parsed['button_card_templates'].items() if k not in t or t[k]==d['button_card_templates'][k]}=={k:v for k,v in d['button_card_templates'].items() if k not in t or t[k]==d['button_card_templates'][k]}
(r/'master-home.original.yaml').write_text(s);(r/'master-home.proposed.yaml').write_text(new);(r/'dashboard.json').write_text(json.dumps(parsed))
config=a.configuration.read_text();assert 'home_security_event:' not in config;assert '\nrest_command:\n' in config
n=child(yaml.compose(config),'rest_command');pos=n.end_mark.index-n.end_mark.column
addition='''  home_security_event:
    url: !secret home_security_event_url_template
    method: GET
    timeout: 10
    headers:
      Authorization: !secret home_security_history_authorization
'''
confignew=config[:pos]+addition+config[pos:];(r/'configuration.original.yaml').write_text(config);(r/'configuration.proposed.yaml').write_text(confignew)
for name,old,new in [('master-home',s,new),('configuration',config,confignew)]:
 (r/(name+'.diff')).write_text(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile=name+'.original.yaml',tofile=name+'.proposed.yaml')))
for f in r.iterdir():f.chmod(0o600)
print('Prepared event dialogs; all views and unrelated templates preserved')
