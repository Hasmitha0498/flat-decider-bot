// DEMO ONLY. Not used by production logic. Enabled with DEMO_MODE=true (/demo) or `npm run demo:seed`.
// Remove all demo data with supabase/remove_demo_data.sql.
//
// Listings use pasted "manual" descriptions so the demo does not depend on live property websites.
// One listing is URL-only on purpose, to show the "Could not read listing details" fallback.
import type { Preference } from '../types';

const p = (criterion: Preference['criterion'], desired_value: unknown, importance: Preference['importance']): Preference => ({ criterion, desired_value, importance });

export interface DemoMember {
  name: string;
  preferences: Preference[];
}

export const DEMO_MEMBERS: DemoMember[] = [
  {
    name: 'Riya', // commute-focused, wants to be near family
    preferences: [
      p('city', 'Pune', 'no_preference'),
      p('max_rent', 25000, 'must_have'),
      p('areas', ['Baner', 'Aundh', 'Balewadi'], 'prefer'),
      p('excluded_areas', null, 'no_preference'),
      p('commute', { destination: 'Baner', max_minutes: 30 }, 'prefer'),
      p('bhk', 3, 'must_have'),
      p('bathrooms', 2, 'prefer'),
      p('lift', null, 'no_preference'),
      p('parking', null, 'no_preference'),
      p('furnishing', 'semi_furnished', 'prefer'),
      p('pets', null, 'no_preference'),
      p('food', null, 'no_preference'),
      p('balcony', true, 'prefer'),
      p('gated_community', null, 'no_preference'),
      p('metro', true, 'prefer'),
      p('additional', { text: 'Close to my parents in Aundh', check: 'Is the flat located in Aundh?' }, 'prefer'),
    ],
  },
  {
    name: 'Meera', // needs a lift, tight budget
    preferences: [
      p('city', 'Pune', 'no_preference'),
      p('max_rent', 22000, 'must_have'),
      p('areas', null, 'no_preference'),
      p('excluded_areas', ['Hadapsar'], 'must_have'),
      p('commute', { destination: 'Shivajinagar', max_minutes: 45 }, 'prefer'),
      p('bhk', 3, 'must_have'),
      p('bathrooms', 2, 'must_have'),
      p('lift', true, 'must_have'),
      p('parking', null, 'no_preference'),
      p('furnishing', 'fully_furnished', 'prefer'),
      p('pets', null, 'no_preference'),
      p('food', null, 'no_preference'),
      p('balcony', null, 'no_preference'),
      p('gated_community', true, 'prefer'),
      p('metro', null, 'no_preference'),
      p('additional', null, 'no_preference'),
    ],
  },
  {
    name: 'Kavita', // has a scooter and a cat
    preferences: [
      p('city', 'Pune', 'no_preference'),
      p('max_rent', 25000, 'must_have'),
      p('areas', ['Baner', 'Balewadi', 'Pashan'], 'prefer'),
      p('excluded_areas', null, 'no_preference'),
      p('commute', { destination: 'Hinjewadi', max_minutes: 40 }, 'prefer'),
      p('bhk', 3, 'must_have'),
      p('bathrooms', 2, 'prefer'),
      p('lift', null, 'no_preference'),
      p('parking', true, 'must_have'),
      p('furnishing', null, 'no_preference'),
      p('pets', true, 'prefer'),
      p('food', null, 'no_preference'),
      p('balcony', true, 'prefer'),
      p('gated_community', null, 'no_preference'),
      p('metro', null, 'no_preference'),
      p('additional', null, 'no_preference'),
    ],
  },
];

export interface DemoListing {
  submittedBy: number; // index into DEMO_MEMBERS
  url: string;
  manualText: string | null;
}

const demoUrl = (slug: string) => `https://example.com/flat-decider-demo/${slug}`;

export const DEMO_LISTINGS: DemoListing[] = [
  {
    submittedBy: 0,
    url: demoUrl('baner-3bhk-sunrise-towers'),
    manualText: `3 BHK apartment for rent in Sunrise Towers, Baner, Pune.
Rent: ₹63,000 per month. Deposit: 2 lakh.
3 bedrooms, 2 bathrooms, semi-furnished (wardrobes, modular kitchen, geysers).
7th floor with lift. 2 covered car parking slots. Two balconies facing the hills.
Gated society with 24x7 security, clubhouse and gym. Pet friendly society.
Family or working professionals welcome.`,
  },
  {
    submittedBy: 1,
    url: demoUrl('baner-3bhk-palm-grove'),
    manualText: `Spacious 3BHK in Palm Grove, Baner. Rent ₹62,000/month, maintenance included.
3 bedrooms with 2 attached bathrooms. Fully furnished: beds, sofa, fridge, washing machine, TV.
Covered parking for one car. Large balcony. Gated complex with security.
Located on the 4th floor. Available immediately.`,
  },
  {
    submittedBy: 2,
    url: demoUrl('kothrud-3bhk-walkup'),
    manualText: `3 BHK flat, Kothrud. Rent: ₹54,000 per month.
3 bedrooms, 3 bathrooms. Fully furnished. 4th floor walk-up - no lift in the building.
Bike and car parking available. Balcony with garden view. Gated society.
Pets allowed. Close to Vanaz metro station.`,
  },
  {
    submittedBy: 0,
    url: demoUrl('aundh-3bhk-single-bath'),
    manualText: `3BHK for rent in Aundh near ITI Road. Rent ₹57,000 per month.
3 bedrooms, 1 common bathroom. Semi-furnished. Building has a lift.
One car parking. Balcony. Gated society. Pets allowed.
5 minutes walk to the bus stop.`,
  },
  {
    submittedBy: 1,
    url: demoUrl('hadapsar-3bhk-magarpatta'),
    manualText: `3 BHK, Hadapsar (near Magarpatta). Rent ₹48,000 per month.
3 bedrooms, 2 bathrooms, fully furnished, lift, covered parking, balcony, gated community.`,
  },
  {
    submittedBy: 2,
    url: demoUrl('balewadi-3bhk-high-street'),
    manualText: `Premium 3BHK near Balewadi High Street. Rent: ₹69,000 per month.
3 bedrooms, 3 bathrooms, semi-furnished, lift, 2 car parks, 2 balconies, gated society, pets welcome.
Metro station under construction nearby.`,
  },
  {
    submittedBy: 0,
    url: demoUrl('baner-2bhk-compact'),
    manualText: `2 BHK apartment in Baner. Rent ₹45,000 per month.
2 bedrooms, 2 bathrooms, semi-furnished, lift, one car parking, balcony. Gated society.`,
  },
  {
    submittedBy: 1,
    url: demoUrl('aundh-3bhk-no-parking'),
    manualText: `3BHK in Aundh, near Westend Mall. Rent ₹64,000/month.
3 bedrooms, 2 bathrooms. Fully furnished. Lift available. Gated community.
Note: no parking available in this building. Balcony. Vegetarians only.`,
  },
  {
    submittedBy: 2,
    url: 'https://example.com/flat-decider-demo/listing-that-needs-login',
    manualText: null, // intentionally unreadable - demonstrates the manual-details fallback
  },
];
