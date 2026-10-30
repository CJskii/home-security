"""Offline preservation and stable-slot checks for the Other Activity cards."""
import copy,importlib.util,unittest
from pathlib import Path
import yaml
spec=importlib.util.spec_from_file_location('other_zones',Path(__file__).with_name('prepare-ha-other-zone-cards.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def fixture():
 heading={'type':'custom:button-card','template':'hs_design_base','custom_fields':{'body':'<h2>My Property</h2>Latest verified activity in your driveway and walkway location=interested'}}
 return {'button_card_templates':{'hs_design_base':{'variables':{'history':'original helper'}},'hs_design_zone':{'custom_fields':{'body':'<ha-icon icon="mdi:shield-home-outline"></ha-icon>'},'tap_action':{'action':'javascript','javascript':'openZoneHistory(channel,slot)'}},'unrelated':{'unchanged':True}},'views':[{'path':'security','sections':[{'cards':[{'camera':'preserved'},heading,{'property':'preserved'},{'type':'custom:button-card','template':'hs_design_other'},{'notifications':'preserved'}]}]},*({'path':'view-'+str(i),'cards':[{'preserved':True}]} for i in range(20))]}
class OtherZoneCards(unittest.TestCase):
 def test_exact_stable_slots_and_dialog_template(self):
  before=fixture();_,after=module.proposal(yaml.safe_dump(before,sort_keys=False));cards=after['views'][0]['sections'][0]['cards'];grid=cards[4]
  self.assertEqual([(c['variables']['channel'],c['variables']['slot']) for c in grid['cards']],[(1,3),(1,1),(1,2),(2,1)])
  self.assertTrue(all(c['template']=='hs_design_zone' for c in grid['cards']))
  self.assertEqual(after['button_card_templates']['hs_design_zone']['tap_action'],before['button_card_templates']['hs_design_zone']['tap_action'])
 def test_unrelated_views_cameras_and_primary_cards_preserved(self):
  before=fixture();snapshot=copy.deepcopy(before);_,after=module.proposal(yaml.safe_dump(before,sort_keys=False));self.assertEqual(before,snapshot)
  self.assertEqual(after['views'][1:],before['views'][1:]);self.assertEqual(after['views'][0]['sections'][0]['cards'][:3],before['views'][0]['sections'][0]['cards'][:3]);self.assertEqual(after['views'][0]['sections'][0]['cards'][-1],before['views'][0]['sections'][0]['cards'][-1]);self.assertEqual(after['button_card_templates']['unrelated'],before['button_card_templates']['unrelated'])
 def test_exposes_cards_without_old_collapsed_panel_and_keeps_primary_icon_default(self):
  _,after=module.proposal(yaml.safe_dump(fixture(),sort_keys=False));cards=after['views'][0]['sections'][0]['cards'];self.assertFalse(any(c.get('template')=='hs_design_other' for c in cards));self.assertIn('Other Camera Activity',cards[3]['custom_fields']['body']);self.assertIn('location=other',cards[3]['custom_fields']['body']);self.assertIn("??'mdi:shield-home-outline'",after['button_card_templates']['hs_design_zone']['custom_fields']['body']);self.assertEqual(cards[4]['columns'],4);self.assertIn('repeat(2',cards[4]['card_mod']['style'])
 def test_compact_variant_preserves_identity_action_and_primary_cards(self):
  _,before=module.proposal(yaml.safe_dump(fixture(),sort_keys=False));_,after=module.compact_proposal(yaml.safe_dump(before,sort_keys=False),'new helper')
  original=before['views'][0]['sections'][0]['cards'];cards=after['views'][0]['sections'][0]['cards'];self.assertEqual(cards[:4],original[:4]);self.assertEqual(cards[5:],original[5:]);self.assertEqual(after['views'][1:],before['views'][1:])
  self.assertEqual(after['button_card_templates']['hs_design_zone'],before['button_card_templates']['hs_design_zone']);self.assertEqual(after['button_card_templates']['hs_design_zone_compact']['template'],'hs_design_zone')
  for old,new in zip(original[4]['cards'],cards[4]['cards']):self.assertEqual(old['variables'],new['variables']);self.assertEqual(new['template'],'hs_design_zone_compact')
  self.assertEqual(after['button_card_templates']['hs_design_zone_compact']['styles']['card'][0],{'height':'76px'})
  self.assertIn('relativeZoneTime',after['button_card_templates']['hs_design_zone_compact']['custom_fields']['body']);self.assertNotIn('Last verified activity',after['button_card_templates']['hs_design_zone_compact']['custom_fields']['body'])
if __name__=='__main__':unittest.main()
