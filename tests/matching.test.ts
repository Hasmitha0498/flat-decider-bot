import { describe, expect, it } from 'vitest';
import { areaMatches, evaluateCriterion } from '../src/matching/criteria';
import { buildShortlist, evaluateListing, preferencePercent, type ListingInput, type MemberInput } from '../src/matching/rank';
import type { Importance, ListingFacts, Preference } from '../src/types';

// ---------- helpers ----------

function facts(overrides: Partial<ListingFacts> = {}): ListingFacts {
  return {
    title: null,
    rent_total: null,
    location: null,
    city: null,
    bhk: null,
    bathrooms: null,
    lift: null,
    parking: null,
    pets_allowed: null,
    food_restriction: null,
    furnishing: null,
    balcony: null,
    gated_community: null,
    metro_nearby: null,
    source_confidence: {},
    ...overrides,
  };
}

const pref = (criterion: Preference['criterion'], desired_value: unknown, importance: Importance): Preference => ({
  criterion,
  desired_value,
  importance,
});

const listing = (id: string, f: Partial<ListingFacts>): ListingInput => ({
  listingId: id,
  url: `https://example.com/${id}`,
  facts: facts(f),
  customAnswers: {},
});

const member = (name: string, preferences: Preference[]): MemberInput => ({ memberId: name.toLowerCase(), name, preferences });

// Three members with different mental models of the ideal flat.
const riya = member('Riya', [
  pref('max_rent', 25000, 'must_have'),
  pref('areas', ['Baner', 'Aundh'], 'prefer'),
  pref('balcony', true, 'prefer'),
  pref('lift', true, 'prefer'),
]);
const meera = member('Meera', [
  pref('max_rent', 22000, 'must_have'),
  pref('lift', true, 'must_have'),
  pref('bathrooms', 2, 'must_have'),
]);
const kavita = member('Kavita', [
  pref('max_rent', 25000, 'must_have'),
  pref('parking', true, 'must_have'),
  pref('pets', true, 'prefer'),
]);
const group = [riya, meera, kavita];

const goodFlat = { rent_total: 60000, location: 'Baner', lift: true, bathrooms: 2, parking: true, balcony: true, pets_allowed: true };

// ---------- the 7 required scenarios ----------

describe('hard rules', () => {
  it('Test 1: all hard rules pass -> qualified', () => {
    const result = evaluateListing(listing('a', goodFlat), group);
    expect(result.status).toBe('qualified');
    expect(result.hardFailCount).toBe(0);
    expect(result.hardUnknownCount).toBe(0);
  });

  it('Test 2: one confirmed must-have failure -> does not qualify normally', () => {
    const result = evaluateListing(listing('a', { ...goodFlat, lift: false }), group);
    expect(result.status).toBe('hard_conflict');
    const meeraEval = result.members.find((m) => m.name === 'Meera')!;
    expect(meeraEval.hardFails.map((r) => r.criterion)).toEqual(['lift']);
  });

  it('Test 3: missing hard-rule information -> needs verification, not passed', () => {
    const result = evaluateListing(listing('a', { ...goodFlat, lift: null }), group);
    expect(result.status).toBe('needs_verification');
    expect(result.hardUnknownCount).toBe(1);
    expect(result.members.find((m) => m.name === 'Meera')!.hardUnknowns[0].criterion).toBe('lift');
  });
});

describe('preference scoring', () => {
  it('Test 4: no preference does not affect the score', () => {
    const withNoPref = member('Riya', [...riya.preferences, pref('gated_community', true, 'no_preference'), pref('food', null, 'no_preference')]);
    const flat = listing('a', { ...goodFlat, gated_community: false, food_restriction: 'vegetarian_only' });
    const before = evaluateListing(flat, [riya]).members[0];
    const after = evaluateListing(flat, [withNoPref]).members[0];
    expect(after.prefPercent).toBe(before.prefPercent);
    expect(after.results.find((r) => r.criterion === 'gated_community')!.state).toBe('not_relevant');
    expect(after.results.find((r) => r.criterion === 'food')!.state).toBe('not_relevant');
  });

  it('Test 5: preference % = matched / (matched + failed); unknown is not a match', () => {
    const fivePrefs = member('Riya', [
      pref('balcony', true, 'prefer'), // match
      pref('lift', true, 'prefer'), // match
      pref('parking', true, 'prefer'), // match
      pref('gated_community', true, 'prefer'), // fail
      pref('pets', true, 'prefer'), // unknown
    ]);
    const flat = listing('a', { balcony: true, lift: true, parking: true, gated_community: false, pets_allowed: null });
    const result = evaluateListing(flat, [fivePrefs]).members[0];
    expect(result.prefMatched).toBe(3);
    expect(result.prefFailed).toBe(1);
    expect(result.prefUnknown).toBe(1);
    expect(result.prefPercent).toBe(75); // 3 / 4, not 4 / 5
  });

  it('percent is null when nothing could be confirmed', () => {
    expect(preferencePercent(0, 0)).toBeNull();
  });
});

describe('shortlist', () => {
  it('Test 6: only two flats qualify -> third is a labelled near match showing the broken rule', () => {
    const flats = [
      listing('ok1', goodFlat),
      listing('ok2', { ...goodFlat, location: 'Aundh' }),
      listing('noLift', { ...goodFlat, lift: false }),
      listing('overBudget', { ...goodFlat, rent_total: 90000, lift: false }),
    ];
    const shortlist = buildShortlist(flats, group);
    expect(shortlist.withoutConflictCount).toBe(2);
    expect(shortlist.options.map((o) => o.listingId)).toEqual(['ok1', 'ok2', 'noLift']);

    const third = shortlist.options[2];
    expect(third.status).toBe('hard_conflict');
    const violation = third.members.flatMap((m) => m.hardFails.map((f) => ({ name: m.name, ...f })));
    expect(violation).toEqual([expect.objectContaining({ name: 'Meera', criterion: 'lift', state: 'fail', label: 'No lift' })]);
  });

  it('never ranks a conflict above a flat that needs verification', () => {
    const shortlist = buildShortlist([listing('conflict', { ...goodFlat, lift: false }), listing('unknownLift', { ...goodFlat, lift: null })], group);
    expect(shortlist.options[0].listingId).toBe('unknownLift');
  });

  it('Test 7: fairness - a balanced flat beats one that is great for two and terrible for one', () => {
    // Everyone passes hard rules; only preferences differ.
    const prefs = (name: string) =>
      member(name, [
        pref('balcony', true, 'prefer'),
        pref('lift', true, 'prefer'),
        pref('parking', true, 'prefer'),
        pref('gated_community', true, 'prefer'),
        pref('metro', true, 'prefer'),
      ]);
    const a = prefs('A');
    const b = prefs('B');
    // C wants the opposite of what the "lopsided" flat offers.
    const c = member('C', [
      pref('balcony', false, 'prefer'),
      pref('lift', false, 'prefer'),
      pref('parking', false, 'prefer'),
      pref('gated_community', false, 'prefer'),
      pref('furnishing', 'unfurnished', 'prefer'),
    ]);

    const lopsided = listing('lopsided', { balcony: true, lift: true, parking: true, gated_community: true, metro_nearby: true, furnishing: 'unfurnished' });
    const balanced = listing('balanced', { balcony: true, lift: false, parking: true, gated_community: false, metro_nearby: true, furnishing: 'unfurnished' });

    const lopsidedEval = evaluateListing(lopsided, [a, b, c]);
    const balancedEval = evaluateListing(balanced, [a, b, c]);
    expect(lopsidedEval.members.map((m) => m.prefPercent)).toEqual([100, 100, 20]);
    expect(balancedEval.members.map((m) => m.prefPercent)).toEqual([60, 60, 60]);
    // A plain average would pick "lopsided" (73 vs 60); the balanced score does not.
    expect(lopsidedEval.averagePercent).toBeGreaterThan(balancedEval.averagePercent);

    const shortlist = buildShortlist([lopsided, balanced], [a, b, c]);
    expect(shortlist.options[0].listingId).toBe('balanced');
  });
});

// ---------- individual criteria ----------

describe('criteria', () => {
  it('splits rent equally across the group for the budget check', () => {
    const budget = pref('max_rent', 22000, 'must_have');
    expect(evaluateCriterion(budget, facts({ rent_total: 66000 }), { groupSize: 3 }).state).toBe('match');
    expect(evaluateCriterion(budget, facts({ rent_total: 69000 }), { groupSize: 3 }).state).toBe('fail');
    expect(evaluateCriterion(budget, facts(), { groupSize: 3 }).state).toBe('unknown');
  });

  it('treats a listed "no" as fail but a missing value as unknown', () => {
    const lift = pref('lift', true, 'must_have');
    expect(evaluateCriterion(lift, facts({ lift: false }), { groupSize: 3 }).state).toBe('fail');
    expect(evaluateCriterion(lift, facts({ lift: null }), { groupSize: 3 }).state).toBe('unknown');
  });

  it('excluded areas fail only when the flat is in one of them', () => {
    const excluded = pref('excluded_areas', ['Hadapsar'], 'must_have');
    expect(evaluateCriterion(excluded, facts({ location: 'Hadapsar, Pune' }), { groupSize: 3 }).state).toBe('fail');
    expect(evaluateCriterion(excluded, facts({ location: 'Baner' }), { groupSize: 3 }).state).toBe('match');
    expect(evaluateCriterion(excluded, facts(), { groupSize: 3 }).state).toBe('unknown');
  });

  it('never invents commute times', () => {
    const commute = pref('commute', { destination: 'Hinjewadi', max_minutes: 30 }, 'must_have');
    expect(evaluateCriterion(commute, facts({ location: 'Baner' }), { groupSize: 3 }).state).toBe('unknown');
    expect(evaluateCriterion(commute, facts({ location: 'Hinjewadi Phase 1' }), { groupSize: 3 }).state).toBe('match');
  });

  it('uses the evidence-backed custom answer for free-text requirements', () => {
    const extra = pref('additional', { text: 'Near my parents in Aundh', check: 'Is it in Aundh?' }, 'prefer');
    expect(evaluateCriterion(extra, facts(), { groupSize: 3, customAnswer: 'yes' }).state).toBe('match');
    expect(evaluateCriterion(extra, facts(), { groupSize: 3, customAnswer: 'no' }).state).toBe('fail');
    expect(evaluateCriterion(extra, facts(), { groupSize: 3 }).state).toBe('unknown');
  });

  it('matches areas loosely but not wrongly', () => {
    expect(areaMatches('Baner Road, Pune', 'baner')).toBe(true);
    expect(areaMatches('Aundh', 'Baner')).toBe(false);
  });
});
