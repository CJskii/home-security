"""Focused local-only styling patch for the deployed Security view (21ce187)."""
import os
import argparse
import copy
import difflib
import hashlib
import json
from pathlib import Path
import yaml

BLUEPRINT = Path(__file__).resolve().parents[1] / 'integrations/home-assistant/security-design.yaml'
LIVE = Path(os.environ['HA_CONFIG_ROOT']).resolve()


class ScopedDumper(yaml.SafeDumper):
    def generate_anchor(self, node):
        self.last_anchor_id += 1
        return 'hs_status_style_%02d' % self.last_anchor_id


def child(node, key):
    return next(v for k, v in node.value if k.value == key)


def proposal(source):
    data = yaml.safe_load(source)
    tree = yaml.compose(source)
    old = next(v for v in data['views'] if v.get('path') == 'security')
    view_node = child(tree, 'views').value[data['views'].index(old)]
    cards = old['sections'][0]['cards']
    nodes = child(child(view_node, 'sections').value[0], 'cards').value
    assert len(cards) == 7 and cards[5]['template'] == 'hs_design_other'
    bp = yaml.safe_load(BLUEPRINT.read_text())
    styles = bp['status_styles']
    replacements = []

    def scalar(node, value):
        replacements.append((node.start_mark.index, node.end_mark.index, json.dumps(value, ensure_ascii=False)))

    def block(node, value, sequence_item=False):
        start = node.start_mark.index - node.start_mark.column
        end = node.end_mark.index - node.end_mark.column
        indent = node.start_mark.column - (2 if sequence_item else 0)
        rendered = yaml.dump([value] if sequence_item else value, Dumper=ScopedDumper, sort_keys=False, allow_unicode=True, width=120)
        replacements.append((start, end, ''.join((' '*indent+l if l else '')+'\n' for l in rendered.splitlines())))

    # Replace only the existing namespaced template block, keeping all view text.
    templates = child(tree, 'button_card_templates')
    assert set(data['button_card_templates']) == set(bp['button_card_templates'])
    block(templates, bp['button_card_templates'])
    for i, camera_node in enumerate(child(nodes[1], 'cards').value):
        header = child(camera_node, 'cards').value[0]
        scalar(child(child(header, 'variables'), 'camera_name'), ['Driveway', 'Side Walkway'][i])
        scalar(child(child(camera_node, 'card_mod'), 'style'),
               styles['surface'].replace('padding:12px;', 'padding:0; overflow:hidden; --vertical-stack-card-gap:0px;'))

    # Existing transparent section headings stay borderless; match Overview weight.
    for index in [0, 2]:
        heading = copy.deepcopy(cards[index]['styles'])
        heading['card'].extend([{'border': 'none'}, {'border-radius': '0px'}])
        block(child(nodes[index], 'styles'), heading)
        css = cards[index]['extra_styles'].replace('font-weight:600', 'font-weight:400')
        css = css.replace('font-size:25px', 'font-size:24px').replace('letter-spacing:-.4px', 'letter-spacing:normal')
        scalar(child(nodes[index], 'extra_styles'), css)

    # Same column/position, just two clearly separated surfaces within the stack.
    old_household = cards[-1]['cards'][1]
    assert old_household['type'] == 'custom:vertical-stack-in-card' and len(old_household['cards']) == 4
    motion_heading, motion, presence_heading, presence = copy.deepcopy(old_household['cards'])
    motion_style = {'style': styles['common']+'\n'+styles['motion']}
    presence_style = {'style': styles['common']+'\n'+styles['presence']}
    surface = {'style': styles['surface']}
    for tile in motion['cards']:
        tile['card_mod'] = motion_style
        tile['icon_color'] = "{{ 'amber' if is_state(entity, 'on') else 'grey' }}"
    for tile in presence['cards']:
        tile['card_mod'] = presence_style
        assert tile.get('picture'), 'Keep the existing person-photo expression'
    for heading in [motion_heading, presence_heading]:
        heading['card_mod'] = {'style': styles['heading']}
    for grid in [motion, presence]:
        assert grid['columns'] == 2
        grid['card_mod'] = {'style': ':host #root{gap:8px;grid-template-columns:repeat(2,minmax(0,1fr))}'}
    household = {'type': 'vertical-stack', 'cards': [
        {'type': 'custom:vertical-stack-in-card', 'cards': [motion_heading, motion], 'card_mod': surface},
        {'type': 'custom:vertical-stack-in-card', 'cards': [presence_heading, presence], 'card_mod': surface}]}
    block(child(nodes[-1], 'cards').value[1], household, sequence_item=True)
    result = source
    prior_start = len(source) + 1
    for start, end, value in sorted(replacements, reverse=True):
        assert end <= prior_start, 'Overlapping YAML patches'
        result = result[:start]+value+result[end:]
        prior_start = start
    after = yaml.safe_load(result)
    assert [v for v in data['views'] if v['path'] != 'security'] == [v for v in after['views'] if v['path'] != 'security']
    assert len(after['views']) == 21
    new_cards = next(v for v in after['views'] if v['path'] == 'security')['sections'][0]['cards']
    # All working activity, secondary-panel and notification card configurations stay.
    for i in [3, 4, 5]:
        assert new_cards[i] == cards[i]
    assert new_cards[-1]['cards'][0] == cards[-1]['cards'][0]
    for a, b in zip(cards[1]['cards'], new_cards[1]['cards']):
        assert a['cards'][1:] == b['cards'][1:], 'Camera feed/action changed'
        assert a['cards'][0]['entity'] == b['cards'][0]['entity']
    return result, after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    if out == LIVE or LIVE in out.parents:
        raise SystemExit('Refusing to write to live HA')
    out.mkdir(mode=0o700, exist_ok=False, parents=True)
    original = args.source.read_text()
    candidate, data = proposal(original)
    (out/'master-home.original.yaml').write_text(original)
    (out/'master-home.proposed.yaml').write_text(candidate)
    (out/'master-home.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), candidate.splitlines(True), fromfile='master-home.original.yaml', tofile='master-home.proposed.yaml')))
    (out/'dashboard.json').write_text(json.dumps(data))
    (out/'validation.json').write_text(json.dumps({'sourceSha256': hashlib.sha256(original.encode()).hexdigest(), 'otherViewsUnchanged': 20, 'apiChanges': False, 'liveFilesWritten': False}, indent=2))
    for file in out.iterdir():
        file.chmod(0o600)
    print('Prepared focused styling proposal:', out)

if __name__ == '__main__':
    main()
