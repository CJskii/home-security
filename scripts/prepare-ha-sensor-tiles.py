"""Prepare individual Security sensor tiles offline, preserving live data/actions."""
import argparse,copy,difflib,json,hashlib
from pathlib import Path
import yaml
STYLES=Path(__file__).resolve().parents[1]/'integrations/home-assistant/security-sensor-tiles.yaml'
def child(n,key):return next(v for k,v in n.value if k.value==key)
def proposal(source):
 d=yaml.safe_load(source);tree=yaml.compose(source);s=yaml.safe_load(STYLES.read_text());view=next(v for v in d['views'] if v.get('path')=='security');index=d['views'].index(view);cards=view['sections'][0]['cards'];group=copy.deepcopy(cards[-1]['cards'][1]);assert group['type']=='vertical-stack' and len(group['cards'])==2
 group['card_mod']={'style':':host { --vertical-stack-card-gap:20px; }'}
 for kind,panel in zip(['motion','presence'],group['cards']):
  assert panel['type']=='custom:vertical-stack-in-card';panel['type']='vertical-stack';panel.pop('card_mod',None)
  panel['cards'][0]['card_mod']={'style':s['heading']}
  grid=panel['cards'][1];assert grid['columns']==2;grid['card_mod']={'style':':host #root { gap:12px; grid-template-columns:repeat(2,minmax(0,1fr)); }'}
  for tile in grid['cards']:tile['card_mod']={'style':s['common']+'\n'+s[kind]}
 other=copy.deepcopy(d['button_card_templates']['hs_design_other']);other['extra_styles']+='\n'+s['other']
 old='rel="noopener"><strong>${name}</strong>';new='rel="noopener"><ha-icon icon=${channel===2?"mdi:walk":slot===3?"mdi:road-variant":"mdi:home-outline"}></ha-icon><strong>${name}</strong>'
 assert old in other['custom_fields']['body'];other['custom_fields']['body']=other['custom_fields']['body'].replace(old,new)
 vn=child(tree,'views').value[index];cn=child(child(vn,'sections').value[0],'cards').value;gn=child(cn[-1],'cards').value[1];tn=child(child(tree,'button_card_templates'),'hs_design_other')
 def render(n,value,item=False):
  start=n.start_mark.index-n.start_mark.column;end=n.end_mark.index-n.end_mark.column;indent=n.start_mark.column-(2 if item else 0)
  text=yaml.safe_dump([value] if item else value,sort_keys=False,width=120,allow_unicode=True)
  return start,end,''.join(' '*indent+line+'\n' for line in text.splitlines())
 result=source
 for start,end,text in sorted([render(gn,group,True),render(tn,other)],reverse=True):result=result[:start]+text+result[end:]
 after=yaml.safe_load(result);newview=after['views'][index];assert [v for v in after['views'] if v.get('path')!='security']==[v for v in d['views'] if v.get('path')!='security']
 assert newview['sections'][0]['cards'][:-1]==cards[:-1];assert newview['sections'][0]['cards'][-1]['cards'][0]==cards[-1]['cards'][0]
 assert {k:v for k,v in after['button_card_templates'].items() if k!='hs_design_other'}=={k:v for k,v in d['button_card_templates'].items() if k!='hs_design_other'}
 for a,b in zip(cards[-1]['cards'][1]['cards'],group['cards']):
  for oldtile,newtile in zip(a['cards'][1]['cards'],b['cards'][1]['cards']):assert {k:v for k,v in oldtile.items() if k!='card_mod'}=={k:v for k,v in newtile.items() if k!='card_mod'}
 return result,after
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();r=a.output.resolve();assert r.is_relative_to(Path('runtime').resolve());r.mkdir(parents=True,exist_ok=False,mode=0o700);source=a.source.read_text();result,data=proposal(source)
 for name,text in [('master-home.original.yaml',source),('master-home.proposed.yaml',result),('dashboard.json',json.dumps(data)),('master-home.diff',''.join(difflib.unified_diff(source.splitlines(True),result.splitlines(True),fromfile='master-home.original.yaml',tofile='master-home.proposed.yaml'))),('source.sha256',hashlib.sha256(source.encode()).hexdigest())]:
  f=r/name;f.write_text(text);f.chmod(0o600)
 print('Prepared individual tiles; live HA untouched')
