// Turns data into Telegram messages (HTML). Pure functions - no network, no database.
import { CRITERION_NAMES, IMPORTANCE_NAMES, bhkLabel, describeDesired, formatRupees } from '../matching/describe';
import { rentShare, type CriterionResult } from '../matching/criteria';
import type { ListingEvaluation, MemberEvaluation } from '../matching/rank';
import type { Criterion, Importance, MatchState, Preference } from '../types';
import { QUESTIONS } from './questions';
import { escapeHtml as esc } from './telegram';

export const DIVIDER = '━━━━━━━━━━━━━━';
const MEDALS = ['🥇', '🥈', '🥉'];
const STATE_ICON: Record<MatchState, string> = { match: '✅', fail: '❌', unknown: '⚠️', not_relevant: '➖' };

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------- profile ----------

export function formatProfile(prefs: Preference[]): string {
  const lines = ['<b>YOUR FLAT PROFILE</b>'];
  for (const question of QUESTIONS) {
    const pref = prefs.find((p) => p.criterion === question.criterion);
    if (!pref) continue;
    const name = CRITERION_NAMES[pref.criterion];
    if (pref.criterion === 'city') {
      lines.push(`<b>${name}:</b> ${esc(describeDesired(pref))}`);
      continue;
    }
    if (pref.criterion === 'excluded_areas' && pref.desired_value === null) {
      lines.push(`<b>${name}:</b> None`);
      continue;
    }
    lines.push(`<b>${name}:</b> ${esc(describeDesired(pref))}\n${IMPORTANCE_NAMES[pref.importance]}`);
  }
  return lines.join('\n\n');
}

// ---------- status ----------

export interface MemberStatus {
  name: string;
  complete: boolean;
  listingCount: number;
}

export function formatStatus(groupName: string, joinCode: string, members: MemberStatus[], uniqueListings: number): string {
  const lines = [`<b>HOUSE SEARCH STATUS</b>\n${esc(groupName)} · join code <code>${joinCode}</code>`];
  for (const m of members) {
    const prefs = m.complete ? '✅ Preferences complete' : '⏳ Preferences not finished';
    lines.push(`<b>${esc(m.name)}</b>\n${prefs}\n${m.listingCount} ${m.listingCount === 1 ? 'flat' : 'flats'} added`);
  }
  const waiting = members.filter((m) => !m.complete).map((m) => esc(m.name));
  if (waiting.length) lines.push(`Waiting for ${joinNames(waiting)} to finish preferences.`);
  else if (uniqueListings > 0) lines.push(`${uniqueListings} ${uniqueListings === 1 ? 'flat' : 'flats'} ready to compare. Send /compare`);
  else lines.push('Everyone is ready. Add flats with /add');
  return lines.join('\n\n');
}

// ---------- shortlist ----------

export function listingHeadline(option: Pick<ListingEvaluation, 'facts'>): string {
  const { facts } = option;
  const parts = [facts.bhk ? bhkLabel(facts.bhk) : null, facts.location].filter(Boolean) as string[];
  return esc(parts.length ? parts.join(', ') : facts.title ?? 'Flat');
}

export function formatHeader(evaluatedCount: number, names: string[], optionCount: number, withoutConflictCount: number, unreadableCount: number): string {
  const lines = [
    `🏠 <b>${optionCount} ${optionCount === 1 ? 'FLAT' : 'FLATS'} WORTH DISCUSSING</b>`,
    `I compared ${evaluatedCount} ${evaluatedCount === 1 ? 'flat' : 'flats'} against the preferences of ${esc(joinNames(names))}.`,
  ];
  const conflicts = optionCount - Math.min(optionCount, withoutConflictCount);
  if (conflicts > 0) {
    const firstConflict = withoutConflictCount + 1;
    const which = conflicts === 1 ? `Option ${firstConflict} is the closest alternative` : `Options ${firstConflict}–${optionCount} are the closest alternatives`;
    const found = withoutConflictCount === 0 ? 'I found no flats' : `I found only ${withoutConflictCount} ${withoutConflictCount === 1 ? 'flat' : 'flats'}`;
    lines.push(`⚠️ ${found} with no confirmed conflict with everyone's hard requirements. ${which}, but ${conflicts === 1 ? 'it breaks' : 'they break'} at least one hard rule - shown clearly below.`);
  }
  if (unreadableCount > 0) lines.push(`${unreadableCount} ${unreadableCount === 1 ? 'flat' : 'flats'} couldn't be read - details at the end.`);
  return lines.join('\n\n');
}

function statusBlock(option: ListingEvaluation): string {
  if (option.status === 'qualified') return '<b>STATUS</b>\n✅ QUALIFIED - meets all confirmed hard requirements';
  if (option.status === 'needs_verification') {
    const n = option.hardUnknownCount;
    return `<b>STATUS</b>\n⚠️ NEEDS VERIFICATION - no confirmed conflicts, but ${n} must-have ${n === 1 ? 'requirement' : 'requirements'} can't be confirmed from the listing`;
  }
  const violations = option.members.flatMap((m) =>
    m.hardFails.map((f) => `${esc(m.name)} requires: ${esc(CRITERION_NAMES[f.criterion])} - ${esc(f.wanted)}.\nThis listing: ${esc(f.label)}.`),
  );
  return `<b>STATUS</b>\n❌ NEAR MATCH WITH HARD-RULE CONFLICT\n\n⚠️ <b>HARD RULE VIOLATION</b>\n${violations.join('\n\n')}`;
}

function percentLine(member: MemberEvaluation): string {
  const lines: string[] = [];
  if (member.prefPercent !== null) lines.push(`${member.prefPercent}% of confirmed preferences matched`);
  else if (member.prefUnknown > 0) lines.push('No preferences could be confirmed yet');
  else lines.push('No preferences to score');
  if (member.prefUnknown > 0) lines.push(`${member.prefUnknown} ${member.prefUnknown === 1 ? 'preference still needs' : 'preferences still need'} verification`);
  return lines.join('\n');
}

function resultLine(result: CriterionResult): string {
  const tag = result.importance === 'must_have' && result.state !== 'match' ? ' <i>(must have)</i>' : '';
  return `${STATE_ICON[result.state]} ${esc(result.label)}${tag}`;
}

function memberBlock(member: MemberEvaluation): string {
  const shown = member.results.filter((r) => r.state !== 'not_relevant');
  const order: Record<MatchState, number> = { fail: 0, match: 1, unknown: 2, not_relevant: 3 };
  shown.sort((a, b) => (a.importance === 'must_have' ? 0 : 1) - (b.importance === 'must_have' ? 0 : 1) || order[a.state] - order[b.state]);
  return [`<b>${esc(member.name.toUpperCase())}</b>`, percentLine(member), ...shown.map(resultLine)].join('\n');
}

const VERIFY_NAMES: Partial<Record<Criterion, string>> = {
  max_rent: 'Rent',
  areas: 'Exact location',
  excluded_areas: 'Exact location',
  bhk: 'Number of bedrooms',
  bathrooms: 'Number of bathrooms',
  pets: 'Pet policy',
  food: 'Food restrictions',
  metro: 'Metro / public transport access',
};

/** Unique list of things to check. Listing facts appear once; personal checks (commute, own requirement) are named. */
export function verificationItems(option: ListingEvaluation): string[] {
  const items = new Map<string, string[]>(); // label -> names for whom it is a must-have
  for (const member of option.members) {
    for (const r of member.results.filter((x) => x.state === 'unknown')) {
      const label =
        r.criterion === 'commute'
          ? `${member.name}'s commute (${(r.wanted.split(',')[0] ?? '').trim()})`
          : r.criterion === 'additional'
            ? `${member.name}: "${r.wanted}"`
            : VERIFY_NAMES[r.criterion] ?? CRITERION_NAMES[r.criterion];
      if (!items.has(label)) items.set(label, []);
      if (r.importance === 'must_have') items.get(label)!.push(member.name);
    }
  }
  return [...items].map(([label, mustFor]) => (mustFor.length ? `${label} - must-have for ${joinNames(mustFor)}` : label));
}

export function formatOption(option: ListingEvaluation, index: number, tradeoff: string, groupSize: number): string {
  const rent = option.facts.rent_total
    ? `${formatRupees(option.facts.rent_total)}/month (${formatRupees(rentShare(option.facts.rent_total, groupSize))} each)`
    : 'Rent not listed';
  const verify = verificationItems(option);
  const sections = [
    `${MEDALS[index] ?? '🏠'} <b>OPTION ${index + 1}</b>\n<b>${listingHeadline(option)}</b>\n${rent}`,
    statusBlock(option),
    ...option.members.map(memberBlock),
    `<b>MAIN TRADEOFF</b>\n${esc(tradeoff)}`,
  ];
  if (verify.length) sections.push(`<b>NEEDS VERIFICATION</b>\n${verify.map((v) => `⚠️ ${esc(v)}`).join('\n')}`);
  sections.push(`<a href="${esc(option.url)}">View listing</a>`);
  return sections.join('\n\n');
}

export const FINAL_MESSAGE = [
  'These are the options that best match the requirements your group entered.',
  '<b>I have not chosen a flat for you.</b>',
  'Before deciding, verify anything marked ⚠️ and discuss which tradeoffs you are comfortable making together.',
].join('\n\n');

// ---------- full comparison ("See full comparison") ----------

function importanceShort(importance: Importance): string {
  return importance === 'must_have' ? 'Must have' : importance === 'prefer' ? 'Prefer' : 'No preference';
}

export function formatDetails(option: ListingEvaluation): string {
  const sections = [`<b>FULL COMPARISON</b>\n${listingHeadline(option)}`];
  for (const question of QUESTIONS) {
    if (question.criterion === 'city') continue;
    const rows = option.members.map((m) => ({ member: m, result: m.results.find((r) => r.criterion === question.criterion) }));
    if (!rows.some((row) => row.result && row.result.state !== 'not_relevant')) continue; // nobody cares about this one

    const lines = [`<b>${CRITERION_NAMES[question.criterion].toUpperCase()}</b>`];
    for (const { member, result } of rows) {
      if (!result || result.state === 'not_relevant') {
        lines.push(`${esc(member.name)}\nNo preference\n➖`);
        continue;
      }
      const stateText = { match: 'Match', fail: 'Fail', unknown: 'Needs verification', not_relevant: '' }[result.state];
      lines.push(`${esc(member.name)}\n${importanceShort(result.importance)}: ${esc(result.wanted)}\n${STATE_ICON[result.state]} ${stateText}${result.label ? ` - ${esc(result.label)}` : ''}`);
    }
    sections.push(lines.join('\n\n'));
  }
  return sections.join(`\n\n${DIVIDER}\n\n`);
}
