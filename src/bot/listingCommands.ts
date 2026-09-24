// /add, /listings, /remove and "Add details manually". Users bring the listings - we never search for flats.
import { MAX_LISTINGS_PER_GROUP } from '../config';
import * as repo from '../db/repo';
import { normalizeUrl, parseListingUrl } from '../listings/url';
import type { Listing, Member } from '../types';
import type { Ctx } from './context';
import { escapeHtml, sendMessage, type Keyboard } from './telegram';

const STATUS_TEXT: Record<Listing['status'], string> = {
  pending: '🕓 Will be read at the next /compare',
  extracted: '✅ Details read',
  unreadable: '⚠️ Could not read listing details',
  failed: '⚠️ Processing failed last time',
};

function shortUrl(url: string): string {
  const clean = url.replace(/^https?:\/\/(www\.)?/, '');
  return clean.length > 45 ? `${clean.slice(0, 42)}...` : clean;
}

export async function askForUrl(ctx: Ctx, member: Member): Promise<void> {
  await repo.setMemberState(member.id, { kind: 'awaiting_url' });
  await sendMessage(ctx.chatId, '🔗 Send me the apartment listing link (NoBroker, MagicBricks, 99acres, a Facebook post... any public URL).\n\n/cancel to stop.');
}

export async function addListingFromText(ctx: Ctx, member: Member, text: string): Promise<void> {
  const url = parseListingUrl(text);
  if (!url) {
    await sendMessage(ctx.chatId, "That doesn't look like a public listing link. Please send a URL starting with https://");
    return;
  }

  const normalized = normalizeUrl(url);
  const existing = await repo.findListingByNormalizedUrl(member.group_id, normalized);
  if (existing) {
    const by = existing.submitted_by === member.id ? 'you' : (await repo.getMember(existing.submitted_by)).display_name;
    await repo.setMemberState(member.id, null);
    await sendMessage(ctx.chatId, `This flat is already on the group's list (added by ${escapeHtml(by)}). I didn't add it again.`);
    return;
  }

  const listings = await repo.getListings(member.group_id);
  if (listings.length >= MAX_LISTINGS_PER_GROUP) {
    await sendMessage(ctx.chatId, `The group already has ${listings.length} flats, which is the limit. Remove some with /remove first.`);
    return;
  }

  const created = await repo.addListing({ groupId: member.group_id, memberId: member.id, url: url.toString(), normalizedUrl: normalized });
  await repo.setMemberState(member.id, null);
  if (!created) {
    await sendMessage(ctx.chatId, "This flat is already on the group's list. I didn't add it again.");
    return;
  }

  const mine = listings.filter((l) => l.submitted_by === member.id).length + 1;
  const total = listings.length + 1;
  await sendMessage(
    ctx.chatId,
    `✅ <b>Apartment added.</b>\n\nYou have added ${mine} ${mine === 1 ? 'flat' : 'flats'}.\nThe group currently has ${total} unique ${total === 1 ? 'flat' : 'flats'}.\n\nSend another link, or /status to see the group.`,
    [[{ text: '📝 Add details manually', data: `manual:${created.id}` }]],
  );
}

export async function showMyListings(ctx: Ctx, member: Member): Promise<void> {
  const all = await repo.getListings(member.group_id);
  const mine = all.filter((l) => l.submitted_by === member.id);
  if (mine.length === 0) {
    await sendMessage(ctx.chatId, `You haven't added any flats yet. The group has ${all.length} in total.\n\nUse /add to add one.`);
    return;
  }
  const lines = mine.map((l, i) => {
    const detail = l.status_detail ? ` (${escapeHtml(l.status_detail)})` : '';
    const manual = l.manual_text ? '\n📝 Manual details added' : '';
    return `${i + 1}. <a href="${escapeHtml(l.url)}">${escapeHtml(shortUrl(l.url))}</a>\n${STATUS_TEXT[l.status]}${detail}${manual}`;
  });
  const keyboard: Keyboard = mine.map((l, i) => [{ text: `📝 Add details manually - #${i + 1}`, data: `manual:${l.id}` }]);
  await sendMessage(ctx.chatId, `<b>YOUR FLATS</b> (${mine.length} of ${all.length} in the group)\n\n${lines.join('\n\n')}`, keyboard);
}

export async function showRemoveMenu(ctx: Ctx, member: Member): Promise<void> {
  const mine = (await repo.getListings(member.group_id)).filter((l) => l.submitted_by === member.id);
  if (mine.length === 0) {
    await sendMessage(ctx.chatId, "You haven't added any flats, so there's nothing to remove.");
    return;
  }
  const keyboard: Keyboard = mine.map((l, i) => [{ text: `🗑 #${i + 1} ${shortUrl(l.url)}`, data: `rm:${l.id}` }]);
  await sendMessage(ctx.chatId, 'Which of your flats should I remove? (You can only remove flats you added.)', keyboard);
}

export async function removeListing(ctx: Ctx, member: Member, listingId: string): Promise<void> {
  const removed = await repo.deleteListing(listingId, member.id);
  await sendMessage(ctx.chatId, removed ? '🗑 Flat removed from the group list.' : "I couldn't find that flat among the ones you added.");
}

export async function askForManualText(ctx: Ctx, member: Member, listingId: string): Promise<void> {
  const listing = await repo.getListing(listingId);
  if (!listing || listing.group_id !== member.group_id) {
    await sendMessage(ctx.chatId, 'That listing no longer exists.');
    return;
  }
  if (listing.submitted_by !== member.id) {
    const owner = await repo.getMember(listing.submitted_by);
    await sendMessage(ctx.chatId, `Only ${escapeHtml(owner.display_name)}, who added this flat, can paste its details.`);
    return;
  }
  await repo.setMemberState(member.id, { kind: 'awaiting_manual_text', listingId });
  await sendMessage(
    ctx.chatId,
    `📝 Paste the listing description for:\n${escapeHtml(shortUrl(listing.url))}\n\nCopy everything useful from the listing page - rent, area, BHK, bathrooms, amenities, rules. I'll only use what the text says.\n\n/cancel to stop.`,
  );
}

export async function saveManualText(ctx: Ctx, member: Member, listingId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length < 40) {
    await sendMessage(ctx.chatId, 'That seems too short to describe a flat. Please paste the full listing text (or /cancel).');
    return;
  }
  const listing = await repo.getListing(listingId);
  if (!listing || listing.submitted_by !== member.id) {
    await repo.setMemberState(member.id, null);
    await sendMessage(ctx.chatId, 'That listing no longer exists.');
    return;
  }
  await repo.setListingManualText(listingId, trimmed.slice(0, 8000));
  await repo.setMemberState(member.id, null);
  await sendMessage(ctx.chatId, "✅ Details saved. I'll use this text the next time anyone runs /compare.");
}
