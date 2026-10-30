"""Prepare an exact local-only dashboard candidate; never write to the HA mount."""
import os
import argparse
import datetime
import difflib
import hashlib
import json
from pathlib import Path
import yaml

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
out = args.output.resolve()
live = Path(os.environ['HA_CONFIG_ROOT']).resolve()
if out == live or live in out.parents or out == source.parent or source in out.parents:
    raise SystemExit('Output must be outside the live HA mirror')
out.mkdir(parents=True, exist_ok=False, mode=0o700)
original = source.read_text()
parsed = yaml.safe_load(original)
start = original.index('    title: "Security"')
end = original.index('  - title: Front / right side', start)
section = original[start:end]
for title, attribute, label in [('Alert-zone activity', 'detectionsMarkdown', 'Recent Home Security detections'), ('Other camera activity history', 'notificationsMarkdown', 'Notification delivery history')]:
    begin = section.index('          - type: logbook\n            title: ' + title)
    finish = section.index('            card_mod:', begin)
    # Keep the original card_mod anchor/reference, including its CSS body.
    section = section[:begin] + f'''          - type: markdown
            title: {label}
            entity_id:
              - sensor.home_security_history
            content: >-
              {{% set updated = as_timestamp(states('sensor.home_security_history'), 0) %}}
              {{% if not updated or as_timestamp(now()) - updated > 90 %}}
              Home Security history is unavailable or stale. Last successful update:
              {{{{ states('sensor.home_security_history') }}}}.
              {{% else %}}
              {{{{ state_attr('sensor.home_security_history', '{attribute}') or 'No history available.' }}}}
              {{% endif %}}
            grid_options:
              columns: full
              rows: auto
''' + section[finish:]
candidate = original[:start] + section + original[end:]
changed = yaml.safe_load(candidate)
assert len(parsed['views']) == len(changed['views'])
for before, after in zip(parsed['views'], changed['views']):
    if before.get('path') != 'security':
        assert before == after, 'An unrelated view or shared alias changed'
    else:
        old_panels = [c for s in before['sections'] for c in s.get('cards', []) if c.get('type') == 'logbook']
        new_panels = [c for s in after['sections'] for c in s.get('cards', []) if c.get('type') == 'markdown']
        assert len(old_panels) == len(new_panels) == 2
        for panel in new_panels:
            assert panel['entity_id'] == ['sensor.home_security_history']
        # Compare every other structure, preserving controls, anchors and styling.
        for view in (before, after):
            for s in view['sections']:
                s['cards'] = [c for c in s.get('cards', []) if c.get('type') not in ('logbook', 'markdown')]
        assert before == after, 'Non-history Security cards changed'
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = out / f'master-home.original.{stamp}.yaml'
backup.write_text(original)
(out / 'master-home.proposed.yaml').write_text(candidate)
(out / 'master-home.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), candidate.splitlines(True), fromfile='master-home.original.yaml', tofile='master-home.proposed.yaml')))
(out / 'validation.json').write_text(json.dumps({'source': str(source), 'sha256': hashlib.sha256(original.encode()).hexdigest(), 'views': len(changed['views']), 'changedView': 'security', 'replacedPanels': 2, 'unrelatedViewsUnchanged': True}, indent=2) + '\n')
for p in out.iterdir():
    p.chmod(0o600)
print('Prepared and validated:', out)
