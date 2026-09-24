// Tiny Telegram Bot API client (plain fetch - no framework needed for a handful of methods).
import { requireEnv } from '../config';

export interface Button {
  text: string;
  data?: string; // callback_data (max 64 bytes)
  url?: string;
}
export type Keyboard = Button[][];

export class TelegramError extends Error {}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${requireEnv('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!json.ok) throw new TelegramError(`Telegram ${method} failed: ${json.description ?? response.status}`);
  return json.result as T;
}

function replyMarkup(keyboard?: Keyboard) {
  if (!keyboard) return undefined;
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? b.text })),
    ),
  };
}

/** Messages use Telegram HTML formatting. Always escape user/listing text with escapeHtml(). */
export async function sendMessage(chatId: number, text: string, keyboard?: Keyboard): Promise<number> {
  const result = await call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: replyMarkup(keyboard),
  });
  return result.message_id;
}

export async function editMessage(chatId: number, messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
  try {
    await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup(keyboard),
    });
  } catch (error) {
    // "message is not modified" and similar edit errors are harmless.
    console.warn(String(error));
  }
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  try {
    await call('answerCallbackQuery', { callback_query_id: callbackId, text });
  } catch (error) {
    console.warn(String(error));
  }
}

export async function setWebhook(url: string, secret?: string): Promise<void> {
  await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
}

export async function deleteWebhook(): Promise<void> {
  await call('deleteWebhook', {});
}

export async function setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
  await call('setMyCommands', { commands });
}

export async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Split long text on blank lines so each piece fits Telegram's 4096-char limit. */
export function splitMessage(text: string, limit = 3900): string[] {
  const parts: string[] = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    if (current && current.length + block.length + 2 > limit) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  return parts;
}

// ---------- the subset of Telegram's update types we use ----------

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
}
