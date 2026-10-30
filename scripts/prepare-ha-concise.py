"""Prepare concise Security cards offline; never write live HA files."""
import argparse,copy,difflib,json,hashlib
from pathlib import Path
import yaml
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();r=a.output.resolve();assert r.is_relative_to(Path('runtime').resolve());r.mkdir(parents=True,exist_ok=True)
s=a.source.read_text();d=yaml.safe_load(s);t=copy.deepcopy(d['button_card_templates']);t['hs_design_base']['variables']['history']=json.loads((r/'history-variable.json').read_text())
b=t['hs_design_activity']['custom_fields']['body'];start=b.index("const parts=r.title.split");end=b.index('return html',start)
b=b[:start]+"const parts=r.title.split(' · '),category=parts.shift(),zone=parts.join(' · '),display=variables.history.activityCard(category,zone,r.subtitle);\n"+b[end:]
old='<div class="item-title">${category}<span class="zone-pill">${zone}</span></div><div class="item-meta">${variables.camera_labels[r.cameraLabel]??r.cameraLabel} · ${r.time}</div><div class="description">${r.subtitle}</div>'
# YAML folds whitespace; normalize only this reviewed HTML span.
import re
pattern=r'<div class="item-title">\$\{category\}<span class="zone-pill">\$\{zone\}</span></div><div\s+class="item-meta">\$\{variables.camera_labels\[r.cameraLabel\]\?\?r.cameraLabel\} · \$\{r.time\}</div><div class="description">\$\{r.subtitle\}</div>'
b,n=re.subn(pattern,'<div class="item-title"><ha-icon icon=${display.icon}></ha-icon><span>${display.title}</span></div><div class="item-meta">${variables.history.activityTime(r.timestamp??r.time)}</div>${display.description?html`<div class="description">${display.description}</div>`:""}',b);assert n==1 or 'display.title' in b
b=b.replace('alt="Original detection crop"','alt=""').replace('}else img.hidden=true;','}else img.hidden=true;')
t['hs_design_activity']['custom_fields']['body']=b
if '.item-title>span' not in t['hs_design_activity']['extra_styles']:t['hs_design_activity']['extra_styles']+='\n.item-title { display:flex; align-items:center; justify-content:flex-start; flex-wrap:nowrap; gap:7px; font-size:15px; text-align:left; } .activity .copy .item-title ha-icon { margin:0!important; width:18px!important; height:18px!important; flex:0 0 18px!important; --mdc-icon-size:18px; color:var(--teal-color,#009688); flex-shrink:0; } .item-title>span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .activity { min-height:96px; padding:12px 14px; }'
t['hs_design_activity']['extra_styles']=t['hs_design_activity']['extra_styles'].split('/* Activity alignment */')[0].rstrip()+'\n/* Activity alignment */\n.activity { box-sizing:border-box; height:112px; min-height:112px; align-items:start; padding:12px 14px; }\n.activity .thumb { align-self:start; }\n.activity .copy { align-self:start; display:flex; flex-direction:column; gap:3px; min-width:0; text-align:left; }\n.activity .copy .item-title { height:22px; min-height:22px; line-height:22px; margin:0; align-items:center; }\n.activity .copy .item-title>span { line-height:22px; }\n.activity .copy .item-title ha-icon { display:inline-flex!important; align-items:center; justify-content:center; margin:0!important; width:18px!important; height:18px!important; flex:0 0 18px!important; vertical-align:middle; }\n.activity .copy .item-meta { margin:0; line-height:19px; }\n.activity .copy .description { margin:0; line-height:20px; min-height:20px; }\n#container { align-content:start; align-items:start; }\n'
for key in ['hs_design_notifications','hs_design_other']:
 t[key]['custom_fields']['body']=t[key]['custom_fields']['body'].replace('${r.time}','${variables.history.activityTime(r.timestamp??r.time)}')
b=t['hs_design_notifications']['custom_fields']['body']
old='${r.title.replace(/^Camera [12]/,name=>variables.camera_labels[name]??name)}'
assert old in b or 'notificationLabel(r.status)' in b
b=b.replace(old,'${(variables.camera_labels[r.title.split(" · ")[0]]??r.title.split(" · ")[0])+" · "+variables.history.notificationLabel(r.status)}')
t['hs_design_notifications']['custom_fields']['body']=b

# Secondary rows use a single description instead of category plus repeated zone/camera.
b=t['hs_design_other']['custom_fields']['body'];b=b.replace('${variables.camera_labels[r.cameraLabel]??r.cameraLabel} · ', '');t['hs_design_other']['custom_fields']['body']=b
node=yaml.compose(s)
def child(n,k):return next(v for key,v in n.value if key.value==k)
changes=[];names=['hs_design_base','hs_design_activity','hs_design_notifications','hs_design_other']
for name in names:
 n=child(child(node,'button_card_templates'),name);start=n.start_mark.index-n.start_mark.column;end=n.end_mark.index-n.end_mark.column
 text=yaml.safe_dump(t[name],sort_keys=False,width=120,allow_unicode=True);changes.append((start,end,''.join(' '*n.start_mark.column+l+'\n' for l in text.splitlines())))
new=s
for start,end,text in sorted(changes,reverse=True):new=new[:start]+text+new[end:]
parsed=yaml.safe_load(new);assert parsed['views']==d['views'];assert {k:v for k,v in parsed['button_card_templates'].items() if k not in names}=={k:v for k,v in d['button_card_templates'].items() if k not in names}
for name,text in [('master-home.original.yaml',s),('master-home.proposed.yaml',new),('dashboard.json',json.dumps(parsed)),('master-home.diff',''.join(difflib.unified_diff(s.splitlines(True),new.splitlines(True),fromfile='master-home.original.yaml',tofile='master-home.proposed.yaml'))),('source.sha256',hashlib.sha256(s.encode()).hexdigest())]:
 f=r/name;f.write_text(text);f.chmod(0o600)
print('Prepared concise cards; all 21 views, live cameras, actions and unrelated templates preserved')
