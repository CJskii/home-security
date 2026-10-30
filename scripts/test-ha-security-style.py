"""Offline synthetic regressions for the focused HA Security styling patch."""
import copy
import importlib.util
import unittest
from pathlib import Path
import jinja2
import yaml


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


style = load('security_style', 'prepare-ha-security-style.py')
legacy = load('security_design_fixture', 'test-ha-security-design.py')


def fixture():
    _, data = legacy.module.proposal(legacy.fixture())
    cards = data['views'][0]['sections'][0]['cards']
    household = cards[-1]['cards'][1]['cards']
    motion = household[1]['cards'][0]
    household[1]['cards'] = [{**copy.deepcopy(motion), 'entity': 'binary_sensor.motion_test_'+str(i)} for i in range(4)]
    person = household[3]['cards'][0]
    household[3]['cards'] = [{**copy.deepcopy(person), 'entity': 'person.test_'+str(i), 'picture': "{{ state_attr(entity,'entity_picture') or '' }}"} for i in range(2)]
    return yaml.safe_dump(data, sort_keys=False, width=120)


class StyleTests(unittest.TestCase):
    def setUp(self):
        self.source = fixture()
        self.original = yaml.safe_load(self.source)
        self.candidate, self.data = style.proposal(self.source)
        self.cards = self.data['views'][0]['sections'][0]['cards']
        self.old_cards = self.original['views'][0]['sections'][0]['cards']
        self.bp = yaml.safe_load(style.BLUEPRINT.read_text())

    def test_other_views_and_working_grids_unchanged(self):
        self.assertEqual(self.data['views'][1:], self.original['views'][1:])
        for i in [3, 4, 5]:
            self.assertEqual(self.cards[i], self.old_cards[i])
        self.assertEqual(self.cards[-1]['cards'][0], self.old_cards[-1]['cards'][0])

    def test_camera_display_names_only(self):
        for i, name in enumerate(['Driveway', 'Side Walkway']):
            before, after = self.old_cards[1]['cards'][i], self.cards[1]['cards'][i]
            self.assertEqual(after['cards'][0]['variables']['camera_name'], name)
            self.assertEqual(before['cards'][0]['entity'], after['cards'][0]['entity'])
            self.assertEqual(before['cards'][1:], after['cards'][1:])

    def test_neutral_overview_theme_tokens(self):
        templates = self.data['button_card_templates']
        self.assertNotIn('styles', templates['hs_design_zone'])
        rules = {k: v for item in templates['hs_design_base']['styles']['card'] for k, v in item.items()}
        self.assertEqual(rules['border-radius'], 'var(--ha-card-border-radius, 12px)')
        self.assertIn('var(--ha-card-border-color', rules['border'])
        self.assertIn('var(--card-background-color)', rules['background'])

    def test_motion_two_by_two_and_presence_photo_actions_preserved(self):
        panels = self.cards[-1]['cards'][1]['cards']
        self.assertEqual([p['cards'][0]['heading'] for p in panels], ['Indoor motion', 'Presence'])
        for index, count in [(0, 4), (1, 2)]:
            self.assertEqual(panels[index]['cards'][1]['columns'], 2)
            tiles = panels[index]['cards'][1]['cards']
            self.assertEqual(len(tiles), count)
            before = self.old_cards[-1]['cards'][1]['cards'][index*2+1]['cards']
            for old, new in zip(before, tiles):
                for key in ['entity', 'primary', 'secondary', 'tap_action', 'hold_action', 'double_tap_action', 'picture']:
                    self.assertEqual(old.get(key), new.get(key), key)

    def test_motion_active_accent_and_clear_neutral(self):
        tpl = jinja2.Template(self.bp['status_styles']['motion'])
        render = lambda state: tpl.render(config={'entity': 'binary_sensor.test'}, is_state=lambda entity, wanted: state == wanted)
        self.assertIn('var(--state-active-color', render('on'))
        for state in ['off', 'unknown', 'unavailable']:
            self.assertIn('2px solid transparent', render(state))

    def test_presence_home_away_subtle_accent(self):
        tpl = jinja2.Template(self.bp['status_styles']['presence'])
        render = lambda state: tpl.render(config={'entity': 'person.test'}, is_state=lambda entity, wanted: state == wanted)
        self.assertIn('var(--success-color', render('home'))
        self.assertIn('2px solid var(--divider-color)', render('not_home'))
        self.assertNotIn('var(--success-color', render('unavailable'))

    def test_no_media_or_disclosure_logic_changed(self):
        templates = self.data['button_card_templates']
        body = templates['hs_design_activity']['custom_fields']['body']
        self.assertIn('src=${r.thumbnail}', body)
        self.assertIn('${r.subtitle}', body)
        self.assertIn('url_path', templates['hs_design_activity']['tap_action'])
        other = templates['hs_design_other']['custom_fields']['body']
        self.assertIn('this._hsOtherOpen??false', other)
        self.assertIn('@keydown=', other)
        self.assertIn('e.stopPropagation()', other)
        self.assertNotIn('r.status', body)

    def test_style_anchors_scoped_no_service_actions(self):
        self.assertIn('&hs_status_style_', self.candidate)
        self.assertNotIn('call-service', self.candidate)
        self.assertEqual(set(self.data['button_card_templates']), set(self.original['button_card_templates']))

if __name__ == '__main__':
    unittest.main()
