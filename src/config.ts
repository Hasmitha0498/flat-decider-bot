// All configuration comes from environment variables. Nothing secret is ever hard-coded.

export const MAX_MEMBERS = 6;
export const MAX_LISTINGS_PER_GROUP = 30; // bounds /compare time; the product is designed around ~15
export const SHORTLIST_SIZE = 3;

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const isGeminiConfigured = () => Boolean(env('GEMINI_API_KEY'));
// Default to flash-lite: on the free tier the Flash models allow only ~20 requests/day each, while
// flash-lite has a larger allowance, is fast, and extracts listing facts reliably (see README).
export const geminiModel = () => env('GEMINI_MODEL') ?? 'gemini-3.1-flash-lite';
/** Tried in order when the main model is overloaded or rate-limited. Comma-separated in the env var. */
export const geminiFallbackModels = () =>
  (env('GEMINI_FALLBACK_MODELS') ?? 'gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.5-flash').split(',').map((m) => m.trim()).filter(Boolean);
export const isDemoMode = () => env('DEMO_MODE') === 'true';
