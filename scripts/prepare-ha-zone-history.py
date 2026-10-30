"""Add the native history action to a local Security styling proposal, never HA."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import yaml
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--review',type=Path,required=True);p.add_argument('--configuration',type=Path,required=True);a=p.parse_args()
r=a.review.resolve();assert r.is_relative_to(Path('runtime').resolve())
proposed=r/'master-home.proposed.yaml';source=proposed.read_text();data=yaml.safe_load(source);action=json.loads((r/'dialog-action.json').read_text())
old=data['button_card_templates']['hs_design_zone']['tap_action'];node=yaml.compose(source)
def child(n,k):return next(v for key,v in n.value if key.value==k)
target=child(child(child(node,'button_card_templates'),'hs_design_zone'),'tap_action')
# Replace just the existing action; preserve styles, source anchors and other views.
text=yaml.safe_dump(action,sort_keys=False,width=120,allow_unicode=True);start=target.start_mark.index-target.start_mark.column;end=target.end_mark.index-target.end_mark.column
new=source[:start]+''.join((' '*target.start_mark.column+line if line else '')+'\n' for line in text.splitlines())+source[end:]
parsed=yaml.safe_load(new);assert parsed['views']==data['views'];assert old['action']=='navigate';proposed.write_text(new)
(r/'dashboard.json').write_text(json.dumps(parsed));original=(r/'master-home.original.yaml').read_text();(r/'master-home.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),new.splitlines(True),fromfile='master-home.original.yaml',tofile='master-home.proposed.yaml')))
config=a.configuration.read_text();assert '\nrest_command:' not in config
append=Path('integrations/home-assistant/zone-history-rest-command.yaml').read_text();candidate=config.rstrip()+'\n\n'+append
(r/'configuration.original.yaml').write_text(config);(r/'configuration.proposed.yaml').write_text(candidate);(r/'configuration.diff').write_text(''.join(difflib.unified_diff(config.splitlines(True),candidate.splitlines(True),fromfile='configuration.original.yaml',tofile='configuration.proposed.yaml')))
(r/'configuration.sha256').write_text(hashlib.sha256(config.encode()).hexdigest())
for f in r.iterdir():f.chmod(0o600)
print('Prepared dialog and server-side HA read command; live HA unchanged')
