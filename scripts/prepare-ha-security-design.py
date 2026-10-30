"""Build a local Security-only visual proposal; never writes to the HA mount."""
import os
import argparse
import copy
import datetime
import difflib
import hashlib
import json
from pathlib import Path
import yaml

BLUEPRINT = Path(__file__).resolve().parents[1] / 'integrations/home-assistant/security-design.yaml'
LIVE = Path(os.environ['HA_CONFIG_ROOT']).resolve()


def grid(cards, columns=2, mobile_columns=1):
    return {'type': 'grid', 'columns': columns, 'square': False,
            'grid_options': {'columns': 'full', 'rows': 'auto'}, 'cards': cards,
            'card_mod': {'style': ':host #root{gap:12px;grid-template-columns:repeat('+str(columns)+',minmax(0,1fr))}@media(max-width:700px){:host #root{grid-template-columns:repeat('+str(mobile_columns)+',minmax(0,1fr))}}'}}


def label(title, subtitle, link=None):
    # Values are fixed operator-defined headings, never event text.
    return {'type': 'custom:button-card', 'template': 'hs_design_base',
            'custom_fields': {'body': '[[[ return html`<div class="section-heading"><div><h2>'+title+'</h2><p>'+subtitle+'</p></div>'+('<a @click=${e=>e.stopPropagation()} href="'+link+'" target="_blank" rel="noopener">View all ↗</a>' if link else '')+'</div>`; ]]]'},
            'styles': {'card': [{'background': 'transparent'}]},
            'extra_styles': '.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 2px 2px}.section-heading h2{font-size:20px;font-weight:600;line-height:26px;margin:0}.section-heading p{font-size:14px;color:var(--secondary-text-color);margin:5px 0 0;line-height:20px}.section-heading a{font-size:13px;color:var(--secondary-text-color);white-space:nowrap}@media(max-width:600px){.section-heading h2{font-size:19px}.section-heading p{font-size:13px}}'}


def proposal(original):
    before = yaml.safe_load(original)
    old = next(v for v in before['views'] if v.get('path') == 'security')
    bp = yaml.safe_load(BLUEPRINT.read_text())
    templates = bp['button_card_templates']
    cameras = []
    for i, sec in enumerate(old['sections'][:2]):
        active, unavailable = copy.deepcopy(sec['cards'][1:3])
        image = active['card']
        assert image['type'] == 'picture-entity' and image['camera_view'] == 'auto'
        image.update(show_name=False, aspect_ratio='16:9', card_mod={'style': 'ha-card{border:none;box-shadow:none;border-radius:0;overflow:hidden}'})
        active.pop('grid_options', None)
        unavailable.pop('grid_options', None)
        cameras.append({'type': 'custom:vertical-stack-in-card', 'cards': [
            {'type': 'custom:button-card', 'template': 'hs_design_camera', 'entity': image['entity'], 'variables': {'camera_name': 'Camera '+str(i+1)}}, active, unavailable],
            'card_mod': {'style': 'ha-card{border:none;border-radius:16px;overflow:hidden;box-shadow:none;background:var(--ha-card-background,var(--card-background-color));--vertical-stack-card-gap:0px}'}})
    zones = []
    for name, ch, entity, nav in [('My Driveway', 1, 'input_button.security_front_right', 'security-front-right'), ('My Walkway', 2, 'input_button.security_back_walkway', 'security-back-walkway')]:
        zones.append({'type': 'custom:button-card', 'template': 'hs_design_zone', 'entity': entity,
                      'variables': {'zone_name': name, 'channel': ch, 'slot': 0, 'navigation': '/master-home/'+nav}})
    motion, presence = copy.deepcopy(old['sections'][-2:])
    household = []
    for sec in [motion, presence]:
        heading = sec['cards'][0]
        heading['card_mod'] = {'style': 'ha-card{border:none;background:none;padding:4px 4px 8px}:host{--ha-heading-card-title-font-size:16px;--ha-heading-card-title-font-weight:600}'}
        children = sec['cards'][1]['cards']
        for card in children:
            card['card_mod'] = {'style': 'ha-card{border:none;box-shadow:none;background:transparent;--mush-spacing:10px;--mush-icon-size:32px;--mush-card-primary-font-size:14px;--mush-card-secondary-font-size:13px}'}
        g = grid(children)
        # Two short status chips remain side-by-side even on a phone.
        g['card_mod'] = {'style': ':host #root{gap:4px;grid-template-columns:repeat(2,minmax(0,1fr))}'}
        household.extend([heading, g])
    household_panel = {'type': 'custom:vertical-stack-in-card', 'cards': household,
                       'card_mod': {'style': 'ha-card{border:none;border-radius:16px;box-shadow:none;padding:14px;background:var(--ha-card-background,var(--card-background-color))}'}}
    title = label('Security', 'Live cameras & verified activity', 'https://security.example.com')
    title['extra_styles'] += '.section-heading{padding-top:4px;padding-bottom:6px}.section-heading h2{font-size:25px;line-height:32px;letter-spacing:-.4px}'
    cards = [title, grid(cameras), label('My Property', 'Latest verified activity in your driveway and walkway', 'https://security.example.com/explore?location=interested'), grid(zones, mobile_columns=2),
             grid([{'type': 'custom:button-card', 'template': 'hs_design_activity', 'variables': {'index': i}} for i in range(4)]),
             {'type': 'custom:button-card', 'template': 'hs_design_other'},
             grid([{'type': 'custom:button-card', 'template': 'hs_design_notifications'}, household_panel])]
    for c in cards:
        c['grid_options'] = {'columns': 'full', 'rows': 'auto'}
    changes = {'max_columns': 3, 'sections': [{'type': 'grid', 'column_span': 3, 'cards': cards}]}
    # Keep the original shared anchors byte-for-byte for unchanged legacy subviews.
    # Replace only the rendered section override; do not reindent the old view.
    start = original.index('    <<: &hs_original_security\n')
    end = original.index('  - title: Front / right side', start)
    render_start = original.index('\n    sections:', start) + 1
    assert render_start < end
    rendered = yaml.safe_dump(changes, sort_keys=False, allow_unicode=True, width=120)
    candidate = original[:render_start] + ''.join('    '+line+'\n' for line in rendered.splitlines()) + original[end:]
    additions = yaml.safe_dump({'button_card_templates': templates}, sort_keys=False, allow_unicode=True, width=120)
    assert not before.get('button_card_templates'), 'Review existing template names before adding'
    candidate = candidate.replace('views:\n', additions+'views:\n', 1)
    after = yaml.safe_load(candidate)
    assert len(before['views']) == len(after['views']) == 21
    for a, b in zip(before['views'], after['views']):
        if a.get('path') != 'security':
            assert a == b, 'Unrelated view modified'
    for i in range(2):
        assert cameras[i]['cards'][1]['card']['entity'] == old['sections'][i]['cards'][1]['card']['entity']
        assert cameras[i]['cards'][1]['card']['tap_action'] == old['sections'][i]['cards'][1]['card']['tap_action']
    return candidate, after


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    out = args.output.resolve()
    if out == LIVE or LIVE in out.parents:
        raise SystemExit('Refusing to write to live HA mirror')
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    source = args.source.read_text()
    candidate, parsed = proposal(source)
    (out/'master-home.proposed.yaml').write_text(candidate)
    (out/'master-home.original.yaml').write_text(source)
    (out/'master-home.diff').write_text(''.join(difflib.unified_diff(source.splitlines(True), candidate.splitlines(True), fromfile='master-home.original.yaml', tofile='master-home.proposed.yaml')))
    (out/'dashboard.json').write_text(json.dumps(parsed))
    (out/'validation.json').write_text(json.dumps({'sourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'otherViewsUnchanged': 20, 'liveFilesWritten': False, 'apiChanges': False, 'newDependencies': False}, indent=2))
    for f in out.iterdir():
        f.chmod(0o600)
    print('Prepared outside live HA:', out)

if __name__ == '__main__':
    main()
