// /start, create, /join, /status, /leave, /details, /help.
import { MAX_MEMBERS } from '../config';
import * as repo from '../db/repo';
import type { Member } from '../types';
import type { StoredRun } from './compare';
import { displayName, type Ctx } from './context';
import { formatDetails, formatStatus, listingHeadline } from './format';
import { startQuestionnaire } from './onboarding';
import { escapeHtml, sendMessage, splitMessage } from './telegram';

export const INTRO = [
  '🏠 <b>Find the flats your group can actually agree on.</b>',
  'First, everyone tells me what matters to them. Then each person adds the flats they like. I compare everything and show you the strongest options and the tradeoffs.',
].join('\n\n');

export const HELP = [
  '<b>Commands</b>',
  '/status - who is ready, how many flats',
  '/add - add a flat (send a listing link)',
  '/listings - flats you added',
  '/remove - remove one of your flats',
  '/preferences - view your preferences',
  '/edit - change a preference',
  '/compare - compare all flats against everyone\'s requirements',
  '/details - full comparison for the last result',
  '/cancel - stop what you are typing',
  '/leave - leave this house search',
].join('\n');

export async function handleStart(ctx: Ctx): Promise<void> {
  if (ctx.member) {
    const group = await repo.getGroup(ctx.member.group_id);
    await sendMessage(ctx.chatId, `${INTRO}\n\nYou're in <b>${escapeHtml(group.name)}</b> (join code <code>${group.join_code}</code>).\n\n${HELP}`);
    return;
  }
  await sendMessage(ctx.chatId, INTRO, [
    [{ text: '➕ Create a house search', data: 'menu:create' }],
    [{ text: '🔑 Join a house search', data: 'menu:join' }],
  ]);
}

async function alreadyInGroup(ctx: Ctx): Promise<boolean> {
  if (!ctx.member) return false;
  const group = await repo.getGroup(ctx.member.group_id);
  await sendMessage(ctx.chatId, `You're already in <b>${escapeHtml(group.name)}</b> (code <code>${group.join_code}</code>). Send /leave first if you want to start or join a different one.`);
  return true;
}

export async function createGroup(ctx: Ctx, name?: string): Promise<void> {
  if (await alreadyInGroup(ctx)) return;
  const groupName = (name?.trim() || `${displayName(ctx.user)}'s house search`).slice(0, 60);
  const group = await repo.createGroup(groupName, ctx.user.id);
  const member = await repo.addMember({ groupId: group.id, telegramUserId: ctx.user.id, username: ctx.user.username ?? null, displayName: displayName(ctx.user) });
  await sendMessage(
    ctx.chatId,
    `✅ Created <b>${escapeHtml(group.name)}</b>.\n\nYour join code is:\n<code>${group.join_code}</code>\n\nSend this to your friends - they join with:\n<code>/join ${group.join_code}</code>`,
  );
  await startQuestionnaire({ ...ctx, member }, member);
}

export async function explainJoin(ctx: Ctx): Promise<void> {
  if (await alreadyInGroup(ctx)) return;
  await sendMessage(ctx.chatId, 'Ask the friend who created the house search for the join code, then send:\n<code>/join CODE</code>');
}

export async function joinGroup(ctx: Ctx, code: string | undefined): Promise<void> {
  if (await alreadyInGroup(ctx)) return;
  if (!code) {
    await explainJoin(ctx);
    return;
  }
  const group = await repo.getGroupByCode(code.trim());
  if (!group || group.status !== 'active') {
    await sendMessage(ctx.chatId, `❌ I couldn't find a house search with the code <code>${escapeHtml(code.trim().toUpperCase())}</code>. Check the code and try again.`);
    return;
  }
  const members = await repo.getMembers(group.id);
  if (members.length >= MAX_MEMBERS) {
    await sendMessage(ctx.chatId, `This house search already has ${members.length} people, which is the maximum.`);
    return;
  }
  const member = await repo.addMember({ groupId: group.id, telegramUserId: ctx.user.id, username: ctx.user.username ?? null, displayName: displayName(ctx.user) });
  const others = members.map((m) => escapeHtml(m.display_name)).join(', ');
  await sendMessage(ctx.chatId, `✅ You joined <b>${escapeHtml(group.name)}</b>${others ? ` with ${others}` : ''}.`);
  await startQuestionnaire({ ...ctx, member }, member);
}

export async function showStatus(ctx: Ctx, member: Member): Promise<void> {
  const [group, members, listings] = await Promise.all([repo.getGroup(member.group_id), repo.getMembers(member.group_id), repo.getListings(member.group_id)]);
  const statuses = members.map((m) => ({
    name: m.display_name,
    complete: m.preferences_complete,
    listingCount: listings.filter((l) => l.submitted_by === m.id).length,
  }));
  await sendMessage(ctx.chatId, formatStatus(group.name, group.join_code, statuses, listings.length));
}

export async function confirmLeave(ctx: Ctx): Promise<void> {
  await sendMessage(ctx.chatId, 'Leave this house search? Your preferences and the flats you added will be deleted.', [
    [{ text: 'Yes, leave', data: 'leave:yes' }],
    [{ text: 'Cancel', data: 'leave:no' }],
  ]);
}

export async function leaveGroup(ctx: Ctx, member: Member): Promise<void> {
  const group = await repo.getGroup(member.group_id);
  if (group.is_demo) await repo.deleteGroup(group.id); // demo groups are throwaway: remove everything
  else await repo.deleteMember(member.id);
  await sendMessage(ctx.chatId, 'You left the house search. Send /start to create or join another.');
}

// ---------- full comparison ----------

export async function showDetailsMenu(ctx: Ctx, member: Member): Promise<void> {
  const run = await repo.getLatestComparisonRun(member.group_id);
  if (!run) {
    await sendMessage(ctx.chatId, 'There is no comparison yet. Run /compare first.');
    return;
  }
  const results = run.results as StoredRun;
  await sendMessage(
    ctx.chatId,
    'Which option do you want the full comparison for?',
    results.options.map((option, i) => [{ text: `Option ${i + 1}: ${listingHeadline(option).replace(/&amp;/g, '&')}`, data: `det:${run.id}:${i}` }]),
  );
}

export async function showDetails(ctx: Ctx, member: Member, runId: string, index: number): Promise<void> {
  const run = await repo.getComparisonRun(runId);
  if (!run || run.group_id !== member.group_id) {
    await sendMessage(ctx.chatId, 'That comparison is no longer available. Run /compare again.');
    return;
  }
  const option = (run.results as StoredRun).options[index];
  if (!option) {
    await sendMessage(ctx.chatId, 'That option is no longer available.');
    return;
  }
  for (const part of splitMessage(`<b>OPTION ${index + 1}</b> · ${formatDetails(option)}`)) {
    await sendMessage(ctx.chatId, part);
  }
}
