import { z } from 'zod';
import { facingDirectionSchema } from './vocabulary.js';

const word = z.string().trim().min(1).max(128);
const list = z.array(word).max(16);
const properties = z.record(z.string().max(64), z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 16);
export const attributionSchema = z.enum(['reliable', 'ambiguous', 'unknown']);
export const visibilitySchema = z.enum(['clear', 'partial', 'occluded', 'unknown']);
export const colourModeSchema = z.enum(['colour', 'monochrome', 'unknown']);
export const lightingSchema = z.enum(['adequate', 'poor', 'unknown']);
export const doorStateSchema = z.enum(['open', 'closed', 'mixed', 'unknown']);
export const motionEvidenceSchema = z.enum(['no_displacement_evidence', 'ambiguous_blur', 'unknown']);
const attributeEvidence = z.object({ basis: z.enum(['direct_visual', 'interpretation', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']), uncertainty: z.string().trim().min(1).max(256).nullable() }).strict();
const personAttributes = ['upperClothing', 'lowerClothing', 'upperColor', 'lowerColor', 'outerwear', 'headwear',
  'bags', 'accessories', 'carriedObjects', 'visibleActions', 'facingDirection', 'visibility'] as const;
const vehicleAttributes = ['vehicleType', 'color', 'make', 'model', 'doorState', 'visibleOccupantCount', 'motionEvidence', 'visibility'] as const;
export const personEvidenceSchema = z.partialRecord(z.enum(personAttributes), attributeEvidence);
export const vehicleEvidenceSchema = z.partialRecord(z.enum(vehicleAttributes), attributeEvidence);

// Explicit fields in the wire schema. The compatibility schema only supplies
// unknown defaults for older inputs; it never upgrades historical rows in place.
export const richPersonSchema = z.object({ upperClothing: word.nullable(), lowerClothing: word.nullable(),
  clothingColors: list, carriedObjects: list, supplementary: properties,
  upperColor: word.nullable(), lowerColor: word.nullable(), outerwear: word.nullable(), headwear: word.nullable(),
  bags: list, accessories: list, visibleActions: list, facingDirection: facingDirectionSchema,
  attribution: attributionSchema, visibility: visibilitySchema, limitations: list, attributeEvidence: personEvidenceSchema }).strict();
export const richVehicleSchema = z.object({ vehicleType: word.max(64).nullable(), color: word.max(64).nullable(),
  make: word.max(64).nullable(), model: word.max(64).nullable(), supplementary: properties,
  doorState: doorStateSchema, visibleOccupantCount: z.number().int().min(0).max(100).nullable(),
  motionEvidence: motionEvidenceSchema, makeModelConfidence: z.enum(['low', 'unknown']),
  attribution: attributionSchema, visibility: visibilitySchema, limitations: list, attributeEvidence: vehicleEvidenceSchema }).strict();
export const COLOURS = ['black', 'white', 'grey', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'beige', 'multicolour'] as const;
export const CLOTHING_TYPES = ['t_shirt', 'shirt', 'blouse', 'jumper', 'hoodie', 'jacket', 'coat', 'vest', 'dress', 'trousers', 'jeans', 'shorts', 'skirt', 'leggings', 'overalls', 'other'] as const;
export const HEADWEAR = ['cap', 'hat', 'beanie', 'hood', 'helmet', 'other'] as const;
export const OBJECTS = ['bag', 'backpack', 'handbag', 'shopping_bag', 'shoulder_bag', 'suitcase', 'package', 'box', 'phone', 'umbrella', 'tool', 'bottle', 'keys', 'other'] as const;
export const BAG_TYPES = ['bag', 'backpack', 'handbag', 'shopping_bag', 'shoulder_bag', 'suitcase', 'other'] as const;
export const ACCESSORIES = ['glasses', 'sunglasses', 'scarf', 'gloves', 'belt', 'other'] as const;
export const ACTIONS = ['standing', 'walking', 'running', 'cycling', 'carrying', 'sitting', 'bending', 'crouching', 'reaching', 'holding_bag', 'holding_phone', 'holding_object', 'hand_on_handle', 'standing_beside_vehicle', 'seated_in_vehicle', 'touching_vehicle'] as const;
export const VEHICLE_TYPES = ['car', 'van', 'truck', 'bus', 'motorcycle', 'bicycle', 'suv', 'other'] as const;
export const token = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 128).replace(/^_+|_+$/g, '');
const aliases: Record<string, string> = { gray: 'grey', greyish: 'grey', navy: 'blue', navy_blue: 'blue', dark_blue: 'blue', light_blue: 'blue',
  t_shirts: 't_shirt', tshirt: 't_shirt', tee: 't_shirt', sweater: 'jumper', pants: 'trousers', sneakers: 'other', baseball_cap: 'cap',
  rucksack: 'backpack', parcel: 'package', shoppingbag: 'shopping_bag', cell_phone: 'phone', mobile_phone: 'phone',
  holding_a_bag: 'holding_bag', carrying_bag: 'holding_bag', holding_a_phone: 'holding_phone', seated: 'sitting', bending_over: 'bending',
  automobile: 'car', pickup: 'truck', pickup_truck: 'truck' };
export function vocabulary(value: string | null, allowed: readonly string[], fallback: string | null = null): string | null {
  if (value === null) return null;
  const name = token(value), normal = aliases[name] ?? name;
  if (['unknown', 'unclear', 'none', 'not_visible', 'ambiguous'].includes(normal)) return null;
  return allowed.includes(normal) ? normal : fallback;
}
const normalList = (values: string[], allowed: readonly string[], fallback: string | null = null) =>
  [...new Set(values.map((value) => vocabulary(value, allowed, fallback)).filter((value): value is string => value !== null))].sort();
type Evidence = z.infer<typeof personEvidenceSchema> | z.infer<typeof vehicleEvidenceSchema>;
function supported(evidence: Evidence, attribute: string) {
  const fact = (evidence as Record<string, z.infer<typeof attributeEvidence> | undefined>)[attribute];
  return fact?.basis === 'direct_visual' && ['high', 'medium'].includes(fact.confidence);
}
function withheldEvidence<T extends Evidence>(evidence: T, before: Record<string, unknown>, after: Record<string, unknown>, safe: boolean, colour: boolean): T {
  const result = { ...evidence };
  for (const key of new Set(Object.keys(evidence).concat(Object.keys(after)))) {
    if (!(key in before) || !personAttributes.includes(key as typeof personAttributes[number]) && !vehicleAttributes.includes(key as typeof vehicleAttributes[number])) continue;
    const value = before[key], normal = after[key];
    const claimed = value !== null && value !== 'unknown' && (!Array.isArray(value) || value.length > 0);
    const empty = normal === null || normal === 'unknown' || Array.isArray(normal) && normal.length === 0;
    if (claimed && empty) {
      const uncertainty = !safe ? 'Subject attribution or visibility is insufficient.' :
        ['upperColor', 'lowerColor', 'color'].includes(key) && !colour ? 'Colour cannot be established in this image mode or lighting.' :
        'Value withheld: insufficient direct evidence or unsupported vocabulary.';
      const previous = (evidence as Record<string, z.infer<typeof attributeEvidence> | undefined>)[key];
      (result as Record<string, z.infer<typeof attributeEvidence>>)[key] = {
        basis: previous?.basis === 'interpretation' ? 'interpretation' : 'unknown', confidence: previous?.basis === 'interpretation' ? 'low' : 'unknown',
        uncertainty: previous?.uncertainty ? `${previous.uncertainty} ${uncertainty}`.slice(0, 256) : uncertainty,
      };
    }
  }
  return result;
}
export function normalisePerson(person: z.infer<typeof richPersonSchema>, colourMode: z.infer<typeof colourModeSchema>, lighting: z.infer<typeof lightingSchema>) {
  const safe = person.attribution === 'reliable' && person.visibility !== 'occluded' && person.visibility !== 'unknown';
  const fact = (key: string) => safe && supported(person.attributeEvidence, key);
  const colour = colourMode === 'colour' && lighting === 'adequate';
  const upperColor = colour && fact('upperColor') ? vocabulary(person.upperColor, COLOURS) : null;
  const lowerColor = colour && fact('lowerColor') ? vocabulary(person.lowerColor, COLOURS) : null;
  const result = { ...person, upperClothing: fact('upperClothing') ? vocabulary(person.upperClothing, CLOTHING_TYPES, 'other') : null,
    lowerClothing: fact('lowerClothing') ? vocabulary(person.lowerClothing, CLOTHING_TYPES, 'other') : null,
    upperColor, lowerColor, clothingColors: [...new Set([upperColor, lowerColor].filter((value): value is string => value !== null))].sort(),
    outerwear: fact('outerwear') ? vocabulary(person.outerwear, CLOTHING_TYPES, 'other') : null,
    headwear: fact('headwear') ? vocabulary(person.headwear, HEADWEAR, 'other') : null,
    bags: fact('bags') ? normalList(person.bags, BAG_TYPES) : [], accessories: fact('accessories') ? normalList(person.accessories, ACCESSORIES, 'other') : [],
    carriedObjects: fact('carriedObjects') ? normalList(person.carriedObjects, OBJECTS, 'other') : [],
    visibleActions: fact('visibleActions') ? normalList(person.visibleActions, ACTIONS) : [],
    facingDirection: fact('facingDirection') ? person.facingDirection : 'unknown' as const };
  return { ...result, attributeEvidence: withheldEvidence(person.attributeEvidence, person, result, safe, colour) };
}
export function normaliseVehicle(vehicle: z.infer<typeof richVehicleSchema>, colourMode: z.infer<typeof colourModeSchema>, lighting: z.infer<typeof lightingSchema>) {
  const safe = vehicle.attribution === 'reliable' && vehicle.visibility !== 'occluded' && vehicle.visibility !== 'unknown';
  const fact = (key: string) => safe && supported(vehicle.attributeEvidence, key);
  const guess = (key: 'make' | 'model') => safe && vehicle.attributeEvidence[key]?.basis === 'interpretation' &&
    vehicle.attributeEvidence[key]?.confidence === 'low' ? vehicle[key] : null;
  const make = guess('make'), model = guess('model');
  const result = { ...vehicle, vehicleType: fact('vehicleType') ? vocabulary(vehicle.vehicleType, VEHICLE_TYPES, 'other') : null,
    color: colourMode === 'colour' && lighting === 'adequate' && fact('color') ? vocabulary(vehicle.color, COLOURS) : null,
    make, model, makeModelConfidence: make || model ? 'low' as const : 'unknown' as const,
    doorState: fact('doorState') ? vehicle.doorState : 'unknown' as const,
    visibleOccupantCount: fact('visibleOccupantCount') ? vehicle.visibleOccupantCount : null,
    motionEvidence: fact('motionEvidence') ? vehicle.motionEvidence : 'unknown' as const };
  return { ...result, attributeEvidence: withheldEvidence(vehicle.attributeEvidence, vehicle, result, safe, colourMode === 'colour' && lighting === 'adequate') };
}
