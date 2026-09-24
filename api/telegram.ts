// Vercel serverless function: Telegram sends every update here (webhook).
import { waitUntil } from '@vercel/functions';
import { env } from '../src/config';
import { handleUpdate } from '../src/bot/handleUpdate';
import type { TelegramUpdate } from '../src/bot/telegram';

export async function POST(request: Request): Promise<Response> {
  // Reject calls that don't carry our secret, so nobody can post fake updates.
  const secret = env('TELEGRAM_WEBHOOK_SECRET');
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  // Answer Telegram immediately (so it doesn't retry) and keep working in the background.
  // /compare can take a while when many listings need reading.
  waitUntil(handleUpdate(update));
  return new Response('OK');
}

// The configuration check lives at /health (api/health.ts).
export function GET(): Response {
  return new Response('Flat Decider webhook is running. Telegram sends updates here.');
}
