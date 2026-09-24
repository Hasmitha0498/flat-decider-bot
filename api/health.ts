// GET /health - internal check that the server has every setting it needs.
// Shows only whether each setting is present, never its value.
import { env } from '../src/config';

const REQUIRED_SETTINGS = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'SUPABASE_URL', 'TELEGRAM_WEBHOOK_SECRET'];

export function GET(): Response {
  const lines = REQUIRED_SETTINGS.map((name) => `${env(name) ? '✓' : '✗ missing'}  ${name}`);
  const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY') ? 'SUPABASE_SERVICE_ROLE_KEY' : env('SUPABASE_ANON_KEY') ? 'SUPABASE_ANON_KEY' : null;
  lines.push(`${supabaseKey ? '✓' : '✗ missing'}  Supabase key${supabaseKey ? ` (${supabaseKey})` : ''}`);
  const healthy = lines.every((line) => line.startsWith('✓'));
  return new Response(`Flat Decider bot is running.\n\nConfiguration:\n${lines.join('\n')}\n`, {
    status: healthy ? 200 : 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
