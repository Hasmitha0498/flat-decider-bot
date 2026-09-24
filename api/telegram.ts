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

// Settings the bot needs. The status page shows only whether each is set - never the values.
const REQUIRED_SETTINGS = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'SUPABASE_URL', 'TELEGRAM_WEBHOOK_SECRET'];

export function GET(): Response {
  const lines = REQUIRED_SETTINGS.map((name) => `${env(name) ? '✓' : '✗ missing'}  ${name}`);
  const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY') ? 'SUPABASE_SERVICE_ROLE_KEY' : env('SUPABASE_ANON_KEY') ? 'SUPABASE_ANON_KEY' : null;
  lines.push(`${supabaseKey ? '✓' : '✗ missing'}  Supabase key${supabaseKey ? ` (${supabaseKey})` : ''}`);
  return new Response(`Flat Decider bot is running.\n\nConfiguration:\n${lines.join('\n')}\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
