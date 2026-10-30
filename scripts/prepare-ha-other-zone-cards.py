"""Expose existing other-zone history cards; prepare only, never write live HA."""
import argparse,copy,difflib,json,hashlib
from pathlib import Path
import yaml

def child(n,k):return next(v for key,v in n.value if key.value==k)
def proposal(source):
 d=yaml.safe_load(source);tree=yaml.compose(source);after=copy.deepcopy(d)
 vi=next(i for i,v in enumerate(d['views']) if v.get('path')=='security');cards=after['views'][vi]['sections'][0]['cards']
 oi=next(i for i,c in enumerate(cards) if c.get('template')=='hs_design_other')
 heading=copy.deepcopy(next(c for c in cards if '<h2>My Property</h2>' in c.get('custom_fields',{}).get('body','')))
 heading['custom_fields']['body']=heading['custom_fields']['body'].replace('My Property','Other Camera Activity').replace('Latest verified activity in your driveway and walkway','Latest verified activity · tap a zone for its history').replace('location=interested','location=other')
 specs=[('Road',1,3,'mdi:road-variant'),('Neighbour A',1,1,'mdi:home-outline'),('Neighbour B · Driveway',1,2,'mdi:home-outline'),('Neighbour B · Walkway',2,1,'mdi:walk')]
 grid={'type':'grid','columns':4,'square':False,'grid_options':{'columns':'full','rows':'auto'},'cards':[{'type':'custom:button-card','template':'hs_design_zone','variables':{'zone_name':name,'channel':channel,'slot':slot,'zone_icon':icon}} for name,channel,slot,icon in specs], 'card_mod':{'style':':host #root { gap:12px; grid-template-columns:repeat(4,minmax(0,1fr)); } @media(max-width:700px) { :host #root { grid-template-columns:repeat(2,minmax(0,1fr)); } }'}}
 cards[oi:oi+1]=[heading,grid]
 template=after['button_card_templates']['hs_design_zone'];old='icon="mdi:shield-home-outline"';assert old in template['custom_fields']['body'];template['custom_fields']['body']=template['custom_fields']['body'].replace(old,"icon=${variables.zone_icon??'mdi:shield-home-outline'}")
 # Keep the two existing primary zone cards and all unrelated controls byte-equivalent as data.
 vn=child(tree,'views').value[vi];cn=child(child(vn,'sections').value[0],'cards').value[oi];tn=child(child(tree,'button_card_templates'),'hs_design_zone')
 def render(n,value,items=False):
  start=n.start_mark.index-n.start_mark.column;end=n.end_mark.index-n.end_mark.column;indent=n.start_mark.column-(2 if items else 0)
  text=yaml.safe_dump(value,sort_keys=False,width=120,allow_unicode=True)
  return start,end,''.join(' '*indent+l+'\n' for l in text.splitlines())
 patches=[render(cn,[heading,grid],True),render(tn,template)]
 result=source
 for start,end,text in sorted(patches,reverse=True):result=result[:start]+text+result[end:]
 parsed=yaml.safe_load(result);assert parsed==after
 assert [v for i,v in enumerate(parsed['views']) if i!=vi]==[v for i,v in enumerate(d['views']) if i!=vi]
 actual=parsed['views'][vi]['sections'][0]['cards'];original=d['views'][vi]['sections'][0]['cards'];assert actual[:oi]==original[:oi];assert actual[oi+2:]==original[oi+1:]
 assert {k:v for k,v in parsed['button_card_templates'].items() if k!='hs_design_zone'}=={k:v for k,v in d['button_card_templates'].items() if k!='hs_design_zone'}
 return result,parsed
def compact_proposal(source,history_variable):
 d=yaml.safe_load(source);tree=yaml.compose(source);after=copy.deepcopy(d)
 vi=next(i for i,v in enumerate(d['views']) if v.get('path')=='security');cards=after['views'][vi]['sections'][0]['cards']
 expected=[(1,3),(1,1),(1,2),(2,1)]
 gi=next(i for i,c in enumerate(cards) if [(x.get('variables',{}).get('channel'),x.get('variables',{}).get('slot')) for x in c.get('cards',[])]==expected)
 for card in cards[gi]['cards']:assert card['template']=='hs_design_zone';card['template']='hs_design_zone_compact'
 template=yaml.safe_load((Path(__file__).resolve().parents[1]/'integrations/home-assistant/security-compact-other-zones.yaml').read_text())
 assert 'hs_design_zone_compact' not in d['button_card_templates']
 after['button_card_templates']['hs_design_zone_compact']=template
 base=after['button_card_templates']['hs_design_base'];base['variables']['history']=history_variable
 def render(n,value,item=False):
  start=n.start_mark.index-n.start_mark.column;end=n.end_mark.index-n.end_mark.column;indent=n.start_mark.column-(2 if item else 0)
  text=yaml.safe_dump([value] if item else value,sort_keys=False,width=120,allow_unicode=True)
  return start,end,''.join(' '*indent+l+'\n' for l in text.splitlines())
 vn=child(tree,'views').value[vi];gn=child(child(vn,'sections').value[0],'cards').value[gi];bn=child(child(tree,'button_card_templates'),'hs_design_base')
 start,end,text=render(bn,base);new_template='  hs_design_zone_compact:\n'+''.join('    '+l+'\n' for l in yaml.safe_dump(template,sort_keys=False,width=120,allow_unicode=True).splitlines())
 patches=[(start,end,text+new_template),render(gn,cards[gi],True)];result=source
 for start,end,text in sorted(patches,reverse=True):result=result[:start]+text+result[end:]
 parsed=yaml.safe_load(result);assert parsed==after
 assert [v for i,v in enumerate(parsed['views']) if i!=vi]==[v for i,v in enumerate(d['views']) if i!=vi]
 assert cards[:gi]==d['views'][vi]['sections'][0]['cards'][:gi];assert cards[gi+1:]==d['views'][vi]['sections'][0]['cards'][gi+1:]
 for old,new in zip(d['views'][vi]['sections'][0]['cards'][gi]['cards'],cards[gi]['cards']):assert {k:v for k,v in old.items() if k!='template'}=={k:v for k,v in new.items() if k!='template'}
 assert {k:v for k,v in parsed['button_card_templates'].items() if k not in ['hs_design_base','hs_design_zone_compact']}=={k:v for k,v in d['button_card_templates'].items() if k!='hs_design_base'}
 return result,parsed

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--compact',action='store_true');p.add_argument('--history-variable',type=Path);a=p.parse_args();r=a.output.resolve();assert r.is_relative_to(Path('runtime').resolve());r.mkdir(parents=True,exist_ok=True,mode=0o700);source=a.source.read_text();out,data=compact_proposal(source,json.loads(a.history_variable.read_text())) if a.compact else proposal(source)
 for name,text in [('master-home.original.yaml',source),('master-home.proposed.yaml',out),('dashboard.json',json.dumps(data)),('master-home.diff',''.join(difflib.unified_diff(source.splitlines(True),out.splitlines(True),fromfile='master-home.original.yaml',tofile='master-home.proposed.yaml'))),('source.sha256',hashlib.sha256(source.encode()).hexdigest())]:
  f=r/name;f.write_text(text);f.chmod(0o600)
 print('Prepared four standalone other-zone cards; other 20 views and existing controls preserved')
