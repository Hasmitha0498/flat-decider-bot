// Entry point for every Telegram update (webhook on Vercel, or long polling locally).
// Routes commands, free text and button presses. Errors are caught here so the bot never crashes.
import { isDemoMode } from '../config';
import * as repo from '../db/repo';
import { DatabaseError } from '../db/supabase';
import { seedDemo } from '../demo/seedDemo';
import { runCompare } from './compare';
import type { Ctx } from './context';
import { formatProfile } from './format';
import * as group from './groupCommands';
import * as listings from './listingCommands';
import * as onboarding from './onboarding';
import { answerCallback, escapeHtml, sendMessage, TelegramError, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './telegram';

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (error) {
    console.error('Failed to handle update', update.update_id, error);
    if (!chatId || error instanceof TelegramError) return; // can't reach the user anyway
    const text =
      error instanceof DatabaseError
        ? '😕 I had trouble reaching my database. Your last action may not have been saved - please try again in a moment.'
        : '😕 Something went wrong on my side. Please try again.';
    await sendMessage(chatId, text).catch(() => undefined);
  }
}

async function buildCtx(chatId: number, user: TelegramUser): Promise<Ctx> {
  return { chatId, user, member: await repo.getMemberByTelegramId(user.id) };
}

async function requireMember(ctx: Ctx): Promise<boolean> {
  if (ctx.member) return true;
  await sendMessage(ctx.chatId, "You're not in a house search yet. Send /start to create one, or /join CODE to join your friends.");
  return false;
}

// ---------- messages ----------

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!message.from || !message.text) return;
  if (message.chat.type !== 'private') {
    await sendMessage(message.chat.id, 'Please message me privately - each person answers their own questions separately.');
    return;
  }
  const ctx = await buildCtx(message.chat.id, message.from);
  const text = message.text.trim();

  if (text.startsWith('/')) {
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.slice(1).split('@')[0].toLowerCase();
    await handleCommand(ctx, command, rest.join(' '));
  } else {
    await handleFreeText(ctx, text);
  }
}

async function handleCommand(ctx: Ctx, command: string, args: string): Promise<void> {
  // Commands that work without a group.
  switch (command) {
    case 'start':
      return group.handleStart(ctx);
    case 'help':
      return void (await sendMessage(ctx.chatId, group.HELP));
    case 'create':
      return group.createGroup(ctx, args);
    case 'join':
      return group.joinGroup(ctx, args || undefined);
    case 'demo':
      return startDemo(ctx);
  }

  if (!(await requireMember(ctx))) return;
  const member = ctx.member!;

  switch (command) {
    case 'cancel':
      await repo.setMemberState(member.id, null);
      return void (await sendMessage(ctx.chatId, 'OK, stopped. ' + (member.preferences_complete ? '' : 'Your preferences are not confirmed yet - send /preferences to review them.')));
    case 'status':
      return group.showStatus(ctx, member);
    case 'preferences': {
      const prefs = await repo.getPreferences(member.id);
      if (prefs.length === 0) return onboarding.startQuestionnaire(ctx, member);
      if (!member.preferences_complete) return onboarding.resumeQuestionnaire(ctx, member);
      return void (await sendMessage(ctx.chatId, `${formatProfile(prefs)}\n\nChange something with /edit`));
    }
    case 'edit':
      return onboarding.showEditMenu(ctx);
    case 'add':
      return args ? listings.addListingFromText(ctx, member, args) : listings.askForUrl(ctx, member);
    case 'listings':
      return listings.showMyListings(ctx, member);
    case 'remove':
      return listings.showRemoveMenu(ctx, member);
    case 'compare':
      return runCompare(ctx, member);
    case 'details':
      return group.showDetailsMenu(ctx, member);
    case 'leave':
      return group.confirmLeave(ctx);
    default:
      await sendMessage(ctx.chatId, `I don't know that command.\n\n${group.HELP}`);
  }
}

async function handleFreeText(ctx: Ctx, text: string): Promise<void> {
  const member = ctx.member;
  if (!member) {
    await group.handleStart(ctx);
    return;
  }
  const state = member.state;
  if (state?.kind === 'questionnaire') return onboarding.handleQuestionnaireText(ctx, member, state, text);
  if (state?.kind === 'awaiting_manual_text') return listings.saveManualText(ctx, member, state.listingId, text);
  if (state?.kind === 'awaiting_url' || /^https?:\/\//i.test(text)) return listings.addListingFromText(ctx, member, text);
  await sendMessage(ctx.chatId, `Not sure what to do with that. Send a listing link to add a flat, or pick a command:\n\n${group.HELP}`);
}

// ---------- buttons ----------

async function handleCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const ctx = await buildCtx(chatId, query.from);
  const [action, first = '', second = ''] = (query.data ?? '').split(':');
  let notice: string | undefined;

  try {
    if (action === 'menu') {
      if (first === 'create') await group.createGroup(ctx);
      else await group.explainJoin(ctx);
      return;
    }
    if (!(await requireMember(ctx))) return;
    const member = ctx.member!;

    switch (action) {
      case 'ans':
      case 'sec':
      case 'imp':
        notice = await onboarding.handleQuestionnaireButton(ctx, member, action, Number(first), second, query.message?.message_id);
        break;
      case 'skip':
        notice = await onboarding.handleQuestionnaireButton(ctx, member, action, Number(first), '', query.message?.message_id);
        break;
      case 'profile':
        if (first === 'confirm') await onboarding.confirmProfile(ctx, member);
        else await onboarding.showEditMenu(ctx);
        break;
      case 'edit':
        await onboarding.startEdit(ctx, member, Number(first));
        break;
      case 'manual':
        await listings.askForManualText(ctx, member, first);
        break;
      case 'rm':
        await listings.removeListing(ctx, member, first);
        break;
      case 'det':
        await group.showDetails(ctx, member, first, Number(second));
        break;
      case 'leave':
        if (first === 'yes') await group.leaveGroup(ctx, member);
        else await sendMessage(chatId, 'OK, you are still in the house search.');
        break;
      default:
        notice = 'That button has expired.';
    }
  } finally {
    await answerCallback(query.id, notice);
  }
}

// ---------- demo ----------

async function startDemo(ctx: Ctx): Promise<void> {
  if (!isDemoMode()) {
    await sendMessage(ctx.chatId, 'Demo mode is turned off.');
    return;
  }
  if (ctx.member) {
    await sendMessage(ctx.chatId, "You're already in a house search. Send /leave first, then /demo.");
    return;
  }
  const demo = await seedDemo(ctx.user.id, ctx.user.username ?? null);
  await sendMessage(
    ctx.chatId,
    `🎬 <b>Demo created:</b> ${escapeHtml(demo.name)}\n\nYou are playing <b>Riya</b>. Meera and Kavita have finished their preferences, and the group has added 9 flats (one of them unreadable on purpose).\n\nTry:\n/status\n/preferences\n/compare\n\nWhen finished, send /leave.`,
  );
}
