// Group-level qualification, preference scoring and ranking. Pure functions - fully unit tested.
//
// RANKING (documented in README too). Flats are sorted by, in order:
//   1. Status tier: QUALIFIED  >  NEEDS VERIFICATION  >  HARD-RULE CONFLICT
//   2. Fewer confirmed hard-rule failures          (only differs inside the conflict tier)
//   3. Fewer unknown hard rules
//   4. Balanced score  = 0.6 × (lowest member's preference %) + 0.4 × (average member preference %)
//   5. Average member preference %                 (tie-break)
//   6. Fewer preferences still needing verification (tie-break)
//
// Weighting the LOWEST member's % keeps one person from being sacrificed for the others:
//   A: 100 / 100 / 20  → 0.6×20 + 0.4×73.3 = 41.3
//   B:  80 /  85 / 80  → 0.6×80 + 0.4×81.7 = 80.7   → B ranks above A.
import type { CustomAnswers, ListingFacts, Preference } from '../types';
import { evaluateCriterion, type CriterionResult } from './criteria';

export const LOWEST_MEMBER_WEIGHT = 0.6;
export const AVERAGE_WEIGHT = 0.4;

export type ListingStatusLabel = 'qualified' | 'needs_verification' | 'hard_conflict';

export interface MemberInput {
  memberId: string;
  name: string;
  preferences: Preference[];
}

export interface ListingInput {
  listingId: string;
  url: string;
  facts: ListingFacts;
  customAnswers: CustomAnswers;
}

export interface MemberEvaluation {
  memberId: string;
  name: string;
  results: CriterionResult[];
  hardFails: CriterionResult[];
  hardUnknowns: CriterionResult[];
  prefMatched: number;
  prefFailed: number;
  prefUnknown: number;
  /** matched / (matched + failed) × 100. null when no preference could be confirmed either way. */
  prefPercent: number | null;
}

export interface ListingEvaluation {
  listingId: string;
  url: string;
  facts: ListingFacts;
  members: MemberEvaluation[];
  status: ListingStatusLabel;
  hardFailCount: number;
  hardUnknownCount: number;
  prefUnknownCount: number;
  balancedScore: number;
  averagePercent: number;
}

export interface Shortlist {
  options: ListingEvaluation[];
  /** Flats with no confirmed hard-rule failure (qualified + needs verification). */
  withoutConflictCount: number;
  qualifiedCount: number;
  evaluatedCount: number;
}

/** preference % = confirmed preferred criteria satisfied / preferred criteria that could be evaluated. */
export function preferencePercent(matched: number, failed: number): number | null {
  const evaluable = matched + failed;
  return evaluable === 0 ? null : Math.round((matched / evaluable) * 100);
}

export function evaluateMember(member: MemberInput, listing: ListingInput, groupSize: number): MemberEvaluation {
  const results = member.preferences.map((pref) =>
    evaluateCriterion(pref, listing.facts, { groupSize, customAnswer: listing.customAnswers[member.memberId] }),
  );
  const must = results.filter((r) => r.importance === 'must_have' && r.state !== 'not_relevant');
  const preferred = results.filter((r) => r.importance === 'prefer' && r.state !== 'not_relevant');

  const prefMatched = preferred.filter((r) => r.state === 'match').length;
  const prefFailed = preferred.filter((r) => r.state === 'fail').length;

  return {
    memberId: member.memberId,
    name: member.name,
    results,
    hardFails: must.filter((r) => r.state === 'fail'),
    hardUnknowns: must.filter((r) => r.state === 'unknown'),
    prefMatched,
    prefFailed,
    prefUnknown: preferred.filter((r) => r.state === 'unknown').length,
    prefPercent: preferencePercent(prefMatched, prefFailed),
  };
}

/** Balanced score over members who have at least one confirmed preference. */
export function balancedScore(percents: (number | null)[]): { balanced: number; average: number } {
  const known = percents.filter((p): p is number => p !== null);
  if (known.length === 0) return { balanced: 0, average: 0 };
  const lowest = Math.min(...known);
  const average = known.reduce((sum, p) => sum + p, 0) / known.length;
  return { balanced: LOWEST_MEMBER_WEIGHT * lowest + AVERAGE_WEIGHT * average, average };
}

export function evaluateListing(listing: ListingInput, members: MemberInput[]): ListingEvaluation {
  const memberEvals = members.map((m) => evaluateMember(m, listing, members.length));
  const hardFailCount = memberEvals.reduce((n, m) => n + m.hardFails.length, 0);
  const hardUnknownCount = memberEvals.reduce((n, m) => n + m.hardUnknowns.length, 0);
  const status: ListingStatusLabel = hardFailCount > 0 ? 'hard_conflict' : hardUnknownCount > 0 ? 'needs_verification' : 'qualified';
  const { balanced, average } = balancedScore(memberEvals.map((m) => m.prefPercent));

  return {
    listingId: listing.listingId,
    url: listing.url,
    facts: listing.facts,
    members: memberEvals,
    status,
    hardFailCount,
    hardUnknownCount,
    prefUnknownCount: memberEvals.reduce((n, m) => n + m.prefUnknown, 0),
    balancedScore: balanced,
    averagePercent: average,
  };
}

const TIER: Record<ListingStatusLabel, number> = { qualified: 0, needs_verification: 1, hard_conflict: 2 };

export function compareListings(a: ListingEvaluation, b: ListingEvaluation): number {
  return (
    TIER[a.status] - TIER[b.status] ||
    a.hardFailCount - b.hardFailCount ||
    a.hardUnknownCount - b.hardUnknownCount ||
    b.balancedScore - a.balancedScore ||
    b.averagePercent - a.averagePercent ||
    a.prefUnknownCount - b.prefUnknownCount
  );
}

/**
 * Top N flats. Hard rules are never weakened: if fewer than N flats avoid a confirmed hard-rule failure,
 * the remaining slots are filled with the closest conflicting flats, which keep status 'hard_conflict'
 * so the output can label them loudly.
 */
export function buildShortlist(listings: ListingInput[], members: MemberInput[], size = 3): Shortlist {
  const evaluations = listings.map((l) => evaluateListing(l, members)).sort(compareListings);
  return {
    options: evaluations.slice(0, size),
    withoutConflictCount: evaluations.filter((e) => e.status !== 'hard_conflict').length,
    qualifiedCount: evaluations.filter((e) => e.status === 'qualified').length,
    evaluatedCount: evaluations.length,
  };
}
