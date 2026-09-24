// DEMO ONLY: the /demo Telegram command. Does nothing unless DEMO_MODE=true.
import { sendMessage, escapeHtml } from '../bot/telegram';
import type { Ctx } from '../bot/context';
import { isDemoMode } from '../config';
import { seedDemo } from './seedDemo';

export async function startDemo(ctx: Ctx): Promise<void> {
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
