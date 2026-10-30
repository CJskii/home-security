"""Prepare fixed icon/text columns for existing Security zone summaries offline."""
import argparse,copy,difflib,json
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
def child(n,k):return next(v for key,v in n.value if key.value==k)
def proposal(source):
 d=yaml.safe_load(source);tree=yaml.compose(source);after=copy.deepcopy(d);patches=[]
 for name,file in [('hs_design_zone','security-zone-icon-layout.yaml'),('hs_design_zone_compact','security-compact-other-zones.yaml')]:
  design=yaml.safe_load((ROOT/'integrations/home-assistant'/file).read_text());target=after['button_card_templates'][name]
  target['custom_fields']['body']=design['custom_fields']['body'];target['extra_styles']=design['extra_styles']
  n=child(child(tree,'button_card_templates'),name);start=n.start_mark.index-n.start_mark.column;end=n.end_mark.index-n.end_mark.column
  value=yaml.safe_dump(target,sort_keys=False,width=120,allow_unicode=True);patches.append((start,end,''.join(' '*n.start_mark.column+l+'\n' for l in value.splitlines())))
 out=source
 for start,end,value in sorted(patches,reverse=True):out=out[:start]+value+out[end:]
 parsed=yaml.safe_load(out);assert parsed==after;assert parsed['views']==d['views']
 for name in ['hs_design_zone','hs_design_zone_compact']:
  old=copy.deepcopy(d['button_card_templates'][name]);new=copy.deepcopy(parsed['button_card_templates'][name])
  for item in [old,new]:item['custom_fields'].pop('body');item.pop('extra_styles')
  assert old==new
 assert {k:v for k,v in parsed['button_card_templates'].items() if k not in ['hs_design_zone','hs_design_zone_compact']}=={k:v for k,v in d['button_card_templates'].items() if k not in ['hs_design_zone','hs_design_zone_compact']}
 return out,parsed
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();r=a.output.resolve();assert r.is_relative_to(Path('runtime').resolve());r.mkdir(parents=True,exist_ok=True,mode=0o700);source=a.source.read_text();out,data=proposal(source)
 for name,text in [('master-home.original.yaml',source),('master-home.proposed.yaml',out),('dashboard.json',json.dumps(data)),('master-home.diff',''.join(difflib.unified_diff(source.splitlines(True),out.splitlines(True),fromfile='master-home.original.yaml',tofile='master-home.proposed.yaml')))]:
  f=r/name;f.write_text(text);f.chmod(0o600)
 print('Prepared fixed icon column; all views, zone variables/actions and unrelated templates preserved')
