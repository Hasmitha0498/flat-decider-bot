// Deterministic evaluation of ONE person's preference against ONE flat.
// Rule of thumb everywhere: if the listing doesn't say, the answer is 'unknown' - never yes, never no.
import type { AdditionalWish, CommuteWish, Criterion, CustomAnswer, Furnishing, Importance, ListingFacts, MatchState, Preference } from '../types';
import { bhkLabel, describeDesired, formatRupees } from './describe';

export interface CriterionResult {
  criterion: Criterion;
  importance: Importance;
  state: MatchState;
  label: string; // short line shown next to ✅ ❌ ⚠️
  wanted: string; // what the person asked for, for the detail view
}

export interface EvaluationContext {
  groupSize: number; // rent is split equally between members
  customAnswer?: CustomAnswer; // Gemini's evidence-backed answer to this member's free-text requirement
}

type Outcome = { state: MatchState; label: string };

/** Loose text match for areas: "Baner Road, Pune" matches "baner". */
export function areaMatches(location: string, area: string): boolean {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const loc = clean(location);
  const wanted = clean(area);
  if (!loc || !wanted) return false;
  return loc.includes(wanted) || wanted.includes(loc);
}

export function rentShare(rentTotal: number, groupSize: number): number {
  return Math.round(rentTotal / Math.max(1, groupSize));
}

function booleanOutcome(desired: boolean, actual: boolean | null, texts: { yes: string; no: string; unknown: string }): Outcome {
  if (actual === null) return { state: 'unknown', label: texts.unknown };
  const label = actual ? texts.yes : texts.no;
  return { state: actual === desired ? 'match' : 'fail', label };
}

function evaluateValue(pref: Preference, facts: ListingFacts, ctx: EvaluationContext): Outcome {
  const desired = pref.desired_value;

  switch (pref.criterion) {
    case 'max_rent': {
      if (facts.rent_total === null) return { state: 'unknown', label: 'Rent not listed' };
      const share = rentShare(facts.rent_total, ctx.groupSize);
      return share <= (desired as number)
        ? { state: 'match', label: `Within budget (${formatRupees(share)} share)` }
        : { state: 'fail', label: `Over budget (${formatRupees(share)} share vs ${formatRupees(desired as number)} max)` };
    }

    case 'areas': {
      if (!facts.location) return { state: 'unknown', label: 'Area not listed' };
      const hit = (desired as string[]).find((area) => areaMatches(facts.location!, area));
      return hit
        ? { state: 'match', label: `Preferred area (${hit})` }
        : { state: 'fail', label: `Not in preferred areas (${facts.location})` };
    }

    case 'excluded_areas': {
      if (!facts.location) return { state: 'unknown', label: 'Area not listed' };
      const hit = (desired as string[]).find((area) => areaMatches(facts.location!, area));
      return hit
        ? { state: 'fail', label: `In an area ruled out (${hit})` }
        : { state: 'match', label: 'Not in an excluded area' };
    }

    case 'commute': {
      // No maps API in this MVP: we only confirm a commute when the flat is in the destination area itself.
      // Everything else must be checked by the group - we never guess travel times.
      const commute = desired as CommuteWish;
      if (facts.location && areaMatches(facts.location, commute.destination)) {
        return { state: 'match', label: `Same area as ${commute.destination}` };
      }
      return { state: 'unknown', label: `Commute to ${commute.destination} needs verification` };
    }

    case 'bhk': {
      if (facts.bhk === null) return { state: 'unknown', label: 'Flat size not listed' };
      const wanted = desired as number;
      const ok = wanted >= 4 ? facts.bhk >= 4 : facts.bhk === wanted;
      return { state: ok ? 'match' : 'fail', label: ok ? bhkLabel(facts.bhk) : `${bhkLabel(facts.bhk)} (wanted ${bhkLabel(wanted)})` };
    }

    case 'bathrooms': {
      if (facts.bathrooms === null) return { state: 'unknown', label: 'Bathrooms not listed' };
      const ok = facts.bathrooms >= (desired as number);
      const noun = facts.bathrooms === 1 ? 'bathroom' : 'bathrooms';
      return { state: ok ? 'match' : 'fail', label: ok ? `${facts.bathrooms} ${noun}` : `Only ${facts.bathrooms} ${noun} (wanted ${desired}+)` };
    }

    case 'lift':
      return booleanOutcome(desired as boolean, facts.lift, { yes: 'Lift', no: 'No lift', unknown: 'Lift not mentioned' });
    case 'parking':
      return booleanOutcome(desired as boolean, facts.parking, { yes: 'Parking', no: 'No parking', unknown: 'Parking not mentioned' });
    case 'pets':
      return booleanOutcome(desired as boolean, facts.pets_allowed, { yes: 'Pets allowed', no: 'No pets allowed', unknown: 'Pet policy not mentioned' });
    case 'balcony':
      return booleanOutcome(desired as boolean, facts.balcony, { yes: 'Balcony', no: 'No balcony', unknown: 'Balcony not mentioned' });
    case 'gated_community':
      return booleanOutcome(desired as boolean, facts.gated_community, { yes: 'Gated community', no: 'Not gated', unknown: 'Gated status not mentioned' });
    case 'metro':
      return booleanOutcome(desired as boolean, facts.metro_nearby, { yes: 'Metro / transport nearby', no: 'No metro nearby', unknown: 'Metro access not mentioned' });

    case 'furnishing': {
      if (facts.furnishing === null) return { state: 'unknown', label: 'Furnishing not mentioned' };
      const names: Record<Furnishing, string> = { fully_furnished: 'Fully furnished', semi_furnished: 'Semi-furnished', unfurnished: 'Unfurnished' };
      return { state: facts.furnishing === desired ? 'match' : 'fail', label: names[facts.furnishing] };
    }

    case 'food': {
      if (desired !== 'non_veg_allowed') return { state: 'not_relevant', label: '' };
      if (facts.food_restriction === null) return { state: 'unknown', label: 'Food rules not mentioned' };
      return facts.food_restriction === 'vegetarian_only'
        ? { state: 'fail', label: 'Vegetarian-only property' }
        : { state: 'match', label: 'Non-veg allowed' };
    }

    case 'additional': {
      const wish = desired as AdditionalWish;
      if (ctx.customAnswer === 'yes') return { state: 'match', label: wish.text };
      if (ctx.customAnswer === 'no') return { state: 'fail', label: wish.text };
      return { state: 'unknown', label: `"${wish.text}" needs verification` };
    }

    case 'city':
      return { state: 'not_relevant', label: '' }; // search context, not a score
  }
}

export function evaluateCriterion(pref: Preference, facts: ListingFacts, ctx: EvaluationContext): CriterionResult {
  const base = { criterion: pref.criterion, importance: pref.importance, wanted: describeDesired(pref) };
  const doesNotMatter = pref.importance === 'no_preference' || pref.desired_value === null || pref.desired_value === undefined;
  if (doesNotMatter) return { ...base, state: 'not_relevant', label: '' };
  return { ...base, ...evaluateValue(pref, facts, ctx) };
}
