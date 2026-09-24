// Human-readable text for criteria and preference values (pure functions).
import type { AdditionalWish, CommuteWish, Criterion, Importance, Preference } from '../types';

export const CRITERION_NAMES: Record<Criterion, string> = {
  city: 'City',
  max_rent: 'Max rent',
  areas: 'Preferred areas',
  excluded_areas: 'Excluded areas',
  commute: 'Commute',
  bhk: 'Apartment type',
  bathrooms: 'Bathrooms',
  lift: 'Lift',
  parking: 'Parking',
  furnishing: 'Furnishing',
  pets: 'Pets',
  food: 'Food restrictions',
  balcony: 'Balcony',
  gated_community: 'Gated community',
  metro: 'Metro / public transport',
  additional: 'Anything else',
};

export const IMPORTANCE_NAMES: Record<Importance, string> = {
  must_have: 'MUST HAVE',
  prefer: 'PREFER',
  no_preference: 'NO PREFERENCE',
};

export function formatRupees(amount: number): string {
  return '₹' + Math.round(amount).toLocaleString('en-IN');
}

export function bhkLabel(bhk: number): string {
  return bhk >= 4 ? '4BHK+' : `${bhk}BHK`;
}

const yesNo = (value: unknown) => (value === true ? 'Yes' : 'No');

/** "What does this person want?" in plain words. */
export function describeDesired(pref: Preference): string {
  const value = pref.desired_value;
  if (value === null || value === undefined) return "Doesn't matter";

  switch (pref.criterion) {
    case 'city':
      return String(value);
    case 'max_rent':
      return `${formatRupees(value as number)} per person`;
    case 'areas':
    case 'excluded_areas':
      return (value as string[]).join(', ');
    case 'commute': {
      const commute = value as CommuteWish;
      return `${commute.destination}, under ${commute.max_minutes} min`;
    }
    case 'bhk':
      return bhkLabel(value as number);
    case 'bathrooms':
      return `At least ${value}`;
    case 'furnishing':
      return ({ fully_furnished: 'Fully furnished', semi_furnished: 'Semi-furnished', unfurnished: 'Unfurnished' } as Record<string, string>)[value as string] ?? String(value);
    case 'pets':
      return value === true ? 'Must allow pets' : 'Pets not needed';
    case 'food':
      return value === 'non_veg_allowed' ? 'Must allow non-veg' : 'Vegetarian-only is okay';
    case 'parking':
      return value === true ? 'Required' : 'Not required';
    case 'metro':
      return value === true ? 'Metro / transport nearby' : 'Not needed';
    case 'additional':
      return (value as AdditionalWish).text;
    default:
      return yesNo(value);
  }
}
