// /compare: load everything from the database, extract listing facts with Gemini (cached),
// run the deterministic matching, let Gemini explain the result, send the shortlist.
import { createHash } from 'node:crypto';
import { SHORTLIST_SIZE, geminiModel, isGeminiConfigured } from '../config';
import * as repo from '../db/repo';
import { GeminiError } from '../gemini/client';
import { explainTradeoffs } from '../gemini/explainTradeoffs';
import { extractListingFacts, type CustomCheck } from '../gemini/extractListing';
import { fetchListingText } from '../listings/fetchPage';
import { buildShortlist, type ListingEvaluation, type ListingInput, type MemberInput } from '../matching/rank';
import type { AdditionalWish, CustomAnswers, Listing, ListingFacts, Member } from '../types';
import type { Ctx } from './context';
import { DIVIDER, FINAL_MESSAGE, formatHeader, formatOption, joinNames } from './format';
import { editMessage, escapeHtml, sendMessage, type Keyboard } from './telegram';

const EXTRACTION_VERSION = 1; // bump to force re-extraction after prompt/schema changes
const CONCURRENCY = 4;

export interface UnreadableListing {
  listingId: string;
  url: string;
  reason: string;
  submittedBy: string;
  temporary: boolean; // true = Gemini/API problem, try again later; false = listing text unusable
}

/** What we store in comparison_runs.results (used later by "See full comparison"). */
export interface StoredRun {
  names: string[];
  groupSize: number;
  options: ListingEvaluation[];
  tradeoffs: string[];
  unreadable: UnreadableListing[];
}

type Extracted = { ok: true; facts: ListingFacts; customAnswers: CustomAnswers } | { ok: false; reason: string; temporary: boolean };

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function hashInput(listing: Listing, checks: CustomCheck[]): string {
  const input = JSON.stringify({ v: EXTRACTION_VERSION, url: listing.normalized_url, manual: listing.manual_text, checks });
  return createHash('sha256').update(input).digest('hex');
}

/** Reuse cached facts when nothing changed; otherwise read the listing and ask Gemini. Never throws. */
async function extractOne(listing: Listing, checks: CustomCheck[], cached?: repo.StoredExtraction): Promise<Extracted> {
  const inputHash = hashInput(listing, checks);
  if (cached && cached.input_hash === inputHash) return { ok: true, facts: cached.facts, customAnswers: cached.custom_checks };

  try {
    // Manually pasted text wins: the member copied it deliberately, often because the page couldn't be read.
    let sourceText = listing.manual_text;
    const source: 'url' | 'manual' = sourceText ? 'manual' : 'url';
    if (!sourceText) {
      const page = await fetchListingText(listing.url);
      if (!page.ok) {
        await repo.setListingStatus(listing.id, 'unreadable', page.reason);
        return { ok: false, reason: page.reason, temporary: false };
      }
      sourceText = page.text;
    }

    const result = await extractListingFacts(sourceText, checks);
    if (!result.ok) {
      await repo.setListingStatus(listing.id, 'unreadable', result.reason);
      return { ok: false, reason: result.reason, temporary: false };
    }

    await repo.saveExtraction({ listing_id: listing.id, input_hash: inputHash, source, facts: result.facts, custom_checks: result.customAnswers, model: geminiModel() });
    await repo.setListingStatus(listing.id, 'extracted', null);
    return result;
  } catch (error) {
    console.error(`Extraction failed for listing ${listing.id}:`, error);
    const reason = error instanceof GeminiError ? 'the AI service could not process it right now' : 'an unexpected error happened';
    await repo.setListingStatus(listing.id, 'failed', reason).catch(() => undefined);
    return { ok: false, reason, temporary: true };
  }
}

/** Returns a list of human-readable blockers, or [] if /compare can run. */
function readinessProblems(members: Member[], listingCount: number): string[] {
  const problems: string[] = [];
  const unfinished = members.filter((m) => !m.preferences_complete).map((m) => m.display_name);
  if (unfinished.length) problems.push(`${joinNames(unfinished)} ${unfinished.length === 1 ? 'has' : 'have'} not finished their preferences yet.`);
  if (listingCount === 0) problems.push('No flats have been added yet. Anyone can add one with /add.');
  if (!isGeminiConfigured()) problems.push('The Gemini API key is not configured on the server (GEMINI_API_KEY).');
  return problems;
}

export async function runCompare(ctx: Ctx, member: Member): Promise<void> {
  // 1-3. Fetch current members, their latest preferences and the current apartment pool.
  const members = await repo.getMembers(member.group_id);
  const listings = await repo.getListings(member.group_id);

  const problems = readinessProblems(members, listings.length);
  if (problems.length) {
    await sendMessage(ctx.chatId, `<b>Not ready to compare yet</b>\n\n${problems.map((p) => `• ${escapeHtml(p)}`).join('\n')}\n\nSee /status for details.`);
    return;
  }

  const prefsByMember = await repo.getPreferencesForMembers(members.map((m) => m.id));
  const memberInputs: MemberInput[] = members.map((m) => ({ memberId: m.id, name: m.display_name, preferences: prefsByMember.get(m.id) ?? [] }));
  const names = members.map((m) => m.display_name);

  // Free-text requirements become yes/no checks answered from the listing text.
  const checks: CustomCheck[] = memberInputs.flatMap((m) => {
    const additional = m.preferences.find((p) => p.criterion === 'additional' && p.importance !== 'no_preference' && p.desired_value);
    return additional ? [{ memberId: m.memberId, question: (additional.desired_value as AdditionalWish).check }] : [];
  });

  await sendMessage(ctx.chatId, `Comparing ${listings.length} ${listings.length === 1 ? 'flat' : 'flats'} against ${members.length} ${members.length === 1 ? "person's" : "people's"} requirements...`);
  const progressId = await sendMessage(ctx.chatId, `Checking ${listings.length} listings...`);

  // 4-5. Extraction (cached, parallel, one failure never stops the rest).
  const cache = await repo.getExtractions(listings.map((l) => l.id));
  let done = 0;
  let lastEdit = Date.now();
  const extracted = await mapWithConcurrency(listings, CONCURRENCY, async (listing) => {
    const result = await extractOne(listing, checks, cache.get(listing.id));
    done++;
    if (Date.now() - lastEdit > 2000 && done < listings.length) {
      lastEdit = Date.now();
      await editMessage(ctx.chatId, progressId, `Checking ${listings.length} listings... ${done} done`);
    }
    return result;
  });
  await editMessage(ctx.chatId, progressId, `Checked ${listings.length} listings.`);

  const nameById = new Map(members.map((m) => [m.id, m.display_name]));
  const inputs: ListingInput[] = [];
  const unreadable: UnreadableListing[] = [];
  listings.forEach((listing, i) => {
    const result = extracted[i];
    if (result.ok) inputs.push({ listingId: listing.id, url: listing.url, facts: result.facts, customAnswers: result.customAnswers });
    else unreadable.push({ listingId: listing.id, url: listing.url, reason: result.reason, submittedBy: nameById.get(listing.submitted_by) ?? 'someone', temporary: result.temporary });
  });

  if (inputs.length === 0) {
    const allTemporary = unreadable.every((u) => u.temporary);
    await sendMessage(
      ctx.chatId,
      allTemporary
        ? '😕 The AI service (Gemini) is unavailable right now, so I could not read any listings. Please try /compare again in a few minutes.'
        : "😕 I couldn't read details from any of the listings.",
    );
    await sendUnreadable(ctx, unreadable);
    return;
  }

  // Deterministic matching & ranking - no AI involved here.
  const shortlist = buildShortlist(inputs, memberInputs, SHORTLIST_SIZE);

  // Gemini only explains the finished result.
  const tradeoffs = await explainTradeoffs(shortlist.options);

  const run: StoredRun = { names, groupSize: members.length, options: shortlist.options, tradeoffs, unreadable };
  const runId = await repo.saveComparisonRun(member.group_id, member.id, run);

  // 6. Send the result.
  await sendMessage(ctx.chatId, formatHeader(shortlist.evaluatedCount, names, shortlist.options.length, shortlist.withoutConflictCount, unreadable.length));
  for (const [index, option] of shortlist.options.entries()) {
    await sendMessage(ctx.chatId, `${DIVIDER}\n\n${formatOption(option, index, tradeoffs[index], members.length)}`, [
      [{ text: '🔍 See full comparison', data: `det:${runId}:${index}` }],
    ]);
  }
  await sendUnreadable(ctx, unreadable);
  await sendMessage(ctx.chatId, `${DIVIDER}\n\n${FINAL_MESSAGE}`);
}

async function sendUnreadable(ctx: Ctx, unreadable: UnreadableListing[]): Promise<void> {
  if (unreadable.length === 0) return;
  const lines = unreadable.map(
    (u, i) =>
      `${i + 1}. <a href="${escapeHtml(u.url)}">${escapeHtml(u.url.replace(/^https?:\/\//, '').slice(0, 50))}</a> - added by ${escapeHtml(u.submittedBy)}\n` +
      (u.temporary ? `Not processed: ${escapeHtml(u.reason)}. Try /compare again later.` : `Could not read listing details: ${escapeHtml(u.reason)}.`),
  );
  const keyboard: Keyboard = unreadable
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => !u.temporary)
    .map(({ u, i }) => [{ text: `📝 Add details manually - #${i + 1}`, data: `manual:${u.listingId}` }]);
  await sendMessage(
    ctx.chatId,
    `⚠️ <b>NOT INCLUDED IN THIS COMPARISON</b>\n\n${lines.join('\n\n')}\n\nThe person who added a flat can paste its description with the button below, then run /compare again. I never guess missing details.`,
    keyboard.length ? keyboard : undefined,
  );
}
