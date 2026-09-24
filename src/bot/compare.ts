// /compare: load everything from the database, extract listing facts with Gemini (cached),
// run the deterministic matching, let Gemini explain the result, send the shortlist.
import { createHash } from 'node:crypto';
import { SHORTLIST_SIZE, geminiModel, isGeminiConfigured } from '../config';
import * as repo from '../db/repo';
import { GeminiError } from '../gemini/client';
import { explainTradeoffs } from '../gemini/explainTradeoffs';
import { extractListingFacts, type CustomCheck, type ExtractionResult, type ListingSource } from '../gemini/extractListing';
import { fetchListingText } from '../listings/fetchPage';
import { buildShortlist, type ListingEvaluation, type ListingInput, type MemberInput } from '../matching/rank';
import type { AdditionalWish, CustomAnswers, Listing, ListingFacts, Member } from '../types';
import type { Ctx } from './context';
import { DIVIDER, FINAL_MESSAGE, formatHeader, formatOption, joinNames } from './format';
import { editMessage, escapeHtml, sendMessage, type Keyboard } from './telegram';

const EXTRACTION_VERSION = 3; // bump to force re-extraction after prompt/schema changes
const FETCH_CONCURRENCY = 4; // reading web pages in parallel is fine
const BATCH_SIZE = 5; // listings per Gemini call (the free tier allows ~5 calls per minute)
const BATCH_MAX_CHARS = 40_000;

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

interface PendingExtraction {
  listing: Listing;
  inputHash: string;
  source: 'url' | 'manual';
  text: string;
}

/** Step 1 (no AI): reuse cached facts, or get the text to extract from. Never throws. */
async function prepareListing(listing: Listing, checks: CustomCheck[], cached?: repo.StoredExtraction): Promise<Extracted | PendingExtraction> {
  const inputHash = hashInput(listing, checks);
  if (cached && cached.input_hash === inputHash) return { ok: true, facts: cached.facts, customAnswers: cached.custom_checks };

  // Manually pasted text wins: the member copied it deliberately, often because the page couldn't be read.
  if (listing.manual_text) return { listing, inputHash, source: 'manual', text: listing.manual_text };

  const page = await fetchListingText(listing.url);
  if (!page.ok) {
    await repo.setListingStatus(listing.id, 'unreadable', page.reason).catch(() => undefined);
    return { ok: false, reason: page.reason, temporary: false };
  }
  return { listing, inputHash, source: 'url', text: page.text };
}

/** Groups listings so each Gemini call stays small. */
function toBatches(pending: PendingExtraction[]): PendingExtraction[][] {
  const batches: PendingExtraction[][] = [];
  let current: PendingExtraction[] = [];
  let chars = 0;
  for (const item of pending) {
    if (current.length && (current.length >= BATCH_SIZE || chars + item.text.length > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Step 2: one Gemini call per batch. A failed batch never stops the other batches. */
async function extractBatch(batch: PendingExtraction[], checks: CustomCheck[]): Promise<Extracted[]> {
  let results: Map<string, ExtractionResult>;
  try {
    const sources: ListingSource[] = batch.map((p) => ({ id: p.listing.id, text: p.text }));
    results = await extractListingFacts(sources, checks);
  } catch (error) {
    console.error(`Extraction failed for ${batch.length} listing(s):`, error);
    const reason = error instanceof GeminiError ? 'the AI service could not process it right now' : 'an unexpected error happened';
    await Promise.all(batch.map((p) => repo.setListingStatus(p.listing.id, 'failed', reason).catch(() => undefined)));
    return batch.map(() => ({ ok: false, reason, temporary: true }));
  }

  return Promise.all(
    batch.map(async (p): Promise<Extracted> => {
      const result = results.get(p.listing.id)!;
      try {
        if (!result.ok) {
          await repo.setListingStatus(p.listing.id, 'unreadable', result.reason);
          return { ok: false, reason: result.reason, temporary: false };
        }
        await repo.saveExtraction({ listing_id: p.listing.id, input_hash: p.inputHash, source: p.source, facts: result.facts, custom_checks: result.customAnswers, model: geminiModel() });
        await repo.setListingStatus(p.listing.id, 'extracted', null);
      } catch (error) {
        console.error(`Could not store extraction for ${p.listing.id}:`, error); // still usable for this run
      }
      return result.ok ? result : { ok: false, reason: result.reason, temporary: false };
    }),
  );
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

  // 4-5. Extraction: cached facts are reused; the rest is read, then sent to Gemini in small batches, one call at a time.
  const cache = await repo.getExtractions(listings.map((l) => l.id));
  const prepared = await mapWithConcurrency(listings, FETCH_CONCURRENCY, (listing) => prepareListing(listing, checks, cache.get(listing.id)));
  const extracted: Extracted[] = prepared.map((p) => ('listing' in p ? { ok: false, reason: 'not processed', temporary: true } : p));
  const pending = prepared.filter((p): p is PendingExtraction => 'listing' in p);

  let done = listings.length - pending.length;
  if (pending.length) await editMessage(ctx.chatId, progressId, `Checking ${listings.length} listings... ${done} done`);
  for (const batch of toBatches(pending)) {
    const results = await extractBatch(batch, checks);
    batch.forEach((p, i) => (extracted[listings.indexOf(p.listing)] = results[i]));
    done += batch.length;
    if (done < listings.length) await editMessage(ctx.chatId, progressId, `Checking ${listings.length} listings... ${done} done`);
  }
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
