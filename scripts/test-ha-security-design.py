"""Offline structural checks for the presentation-only HA Security proposal."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path
import yaml

spec = importlib.util.spec_from_file_location('security_design', Path(__file__).with_name('prepare-ha-security-design.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture():
    def camera(i):
        return {'type': 'grid', 'cards': [
            {'type': 'heading', 'heading': 'Camera '+str(i)},
            {'type': 'conditional', 'conditions': [{'entity': 'camera.test_'+str(i), 'state_not': 'unavailable'}],
             'card': {'type': 'picture-entity', 'entity': 'camera.test_'+str(i), 'camera_view': 'auto', 'tap_action': {'action': 'more-info'}}},
            {'type': 'conditional', 'conditions': [{'entity': 'camera.test_'+str(i), 'state': 'unavailable'}], 'card': {'type': 'markdown', 'content': 'Unavailable'}}]}
    def sensors(name, entity):
        return {'type': 'grid', 'cards': [{'type': 'heading', 'heading': name}, {'type': 'grid', 'cards': [{'type': 'custom:mushroom-template-card', 'entity': entity, 'primary': name, 'tap_action': {'action': 'more-info'}}]}]}
    view = {'title': 'Security', 'path': 'security', 'type': 'sections', 'sections': [camera(1), camera(2), {'type': 'grid', 'cards': [{'primary': 'Front intrusion', 'entity': 'input_button.old'}]}, sensors('Indoor motion', 'binary_sensor.motion_test'), sensors('Presence', 'person.test')]}
    # Match the real anchor boundary, without any actual household data.
    body = yaml.safe_dump(view, sort_keys=False).replace("sections:\n", "sections: &test_sections\n", 1)
    return 'title: Test\nviews:\n  -\n    <<: &hs_original_security\n'+''.join('      '+l+'\n' for l in body.splitlines())+'    sections: *test_sections\n  - title: Front / right side\n    path: security-front-right\n    cards: []\n'+''.join('  - title: Untouched '+str(i)+'\n    path: untouched-'+str(i)+'\n    cards: []\n' for i in range(19))


class DesignTests(unittest.TestCase):
    def setUp(self):
        self.original = fixture()
        self.candidate, self.parsed = module.proposal(self.original)
        self.view = next(v for v in self.parsed['views'] if v['path'] == 'security')
        self.cards = self.view['sections'][0]['cards']

    def test_other_twenty_views_equal(self):
        before = yaml.safe_load(self.original)
        self.assertEqual(before['views'][1:], self.parsed['views'][1:])
        self.assertTrue(self.candidate.endswith(self.original[self.original.index('  - title: Front / right side'):]))

    def test_camera_identity_playback_and_action_preserved(self):
        for i, card in enumerate(self.cards[1]['cards'], 1):
            source = card['cards'][1]['card']
            self.assertEqual(source['entity'], 'camera.test_'+str(i))
            self.assertEqual(source['camera_view'], 'auto')
            self.assertEqual(source['tap_action'], {'action': 'more-info'})
            self.assertEqual(source['aspect_ratio'], '16:9')
            self.assertFalse(source['show_name'])

    def test_four_property_items_and_original_zone_bindings(self):
        self.assertEqual([c['variables']['index'] for c in self.cards[4]['cards']], [0, 1, 2, 3])
        self.assertEqual([c['entity'] for c in self.cards[3]['cards']], ['input_button.security_front_right', 'input_button.security_back_walkway'])
        self.assertEqual([c['variables']['channel'] for c in self.cards[3]['cards']], [1, 2])
        self.assertTrue(all(c['variables']['slot'] == 0 for c in self.cards[3]['cards']))

    def test_legacy_not_rendered_but_original_source_retained(self):
        self.assertNotIn('Front intrusion', json.dumps(self.view['sections']))
        self.assertIn('Front intrusion', self.candidate)

    def test_motion_presence_entities_and_actions_preserved(self):
        household = self.cards[-1]['cards'][1]['cards']
        actual = [household[i]['cards'][0] for i in [1, 3]]
        self.assertEqual([c['entity'] for c in actual], ['binary_sensor.motion_test', 'person.test'])
        self.assertTrue(all(c['tap_action']['action'] == 'more-info' for c in actual))

    def test_templates_local_and_no_service_actions(self):
        templates = self.parsed['button_card_templates']
        self.assertTrue(all(k.startswith('hs_design_') for k in templates))
        self.assertNotIn('call-service', yaml.safe_dump(self.view))
        self.assertNotIn('perform-action', yaml.safe_dump(templates))
        self.assertEqual(templates['hs_design_other']['tap_action'] if 'tap_action' in templates['hs_design_other'] else templates['hs_design_base']['tap_action'], {'action': 'none'})

    def test_signed_images_and_descriptions_are_existing_server_values(self):
        activity = self.parsed['button_card_templates']['hs_design_activity']
        body = activity['custom_fields']['body']
        self.assertIn('src=${r.thumbnail}', body)
        self.assertIn('${r.subtitle}', body)
        self.assertNotIn('r.status', body)
        self.assertIn('img.isConnected', body)
        self.assertIn('n<2', body)
        self.assertIn('propertyDetections', activity['variables']['row'])

    def test_disclosure_and_stale_data_guards(self):
        templates = self.parsed['button_card_templates']
        self.assertIn('this._hsOtherOpen??false', templates['hs_design_other']['custom_fields']['body'])
        self.assertIn('Europe/London', templates['hs_design_zone']['custom_fields']['body'])
        self.assertIn('90000', templates['hs_design_other']['custom_fields']['body'])
        self.assertIn('Webhook acceptance does not confirm phone display', templates['hs_design_notifications']['custom_fields']['body'])

if __name__ == '__main__':
    unittest.main()
