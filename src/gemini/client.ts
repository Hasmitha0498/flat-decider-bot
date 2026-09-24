// Thin wrapper around the official Gemini SDK (@google/genai) that only ever returns
// schema-validated JSON. We never parse free-form prose from the model.
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { geminiFallbackModels, geminiModel, requireEnv } from '../config';

let ai: GoogleGenAI | null = null;

function client(): GoogleGenAI {
  if (!ai) ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY'), httpOptions: { timeout: 30_000 } });
  return ai;
}

export class GeminiError extends Error {}

interface JsonRequest<T> {
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>; // sent to Gemini so it answers in this shape
  validator: z.ZodType<T>; // checked again on our side before anything is stored
}

// Attempt plan: the main model, the main model again after a pause, then each fallback model once.
// Pauses help with Gemini's short "high demand" (503) spikes; on rate limits (429) a retry of the same
// model waits as long as Gemini asks (capped), because the free tier allows only a few requests per minute.
// Fallback models have their own capacity and quota, so they are tried without waiting for the rate limit.
function attemptPlan(): { model: string; delayMs: number; sameModelRetry: boolean }[] {
  return [
    { model: geminiModel(), delayMs: 0, sameModelRetry: false },
    { model: geminiModel(), delayMs: 2000, sameModelRetry: true },
    ...geminiFallbackModels().map((model) => ({ model, delayMs: 1000, sameModelRetry: false })),
  ];
}
const MAX_RATE_LIMIT_WAIT_MS = 35_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gemini's 429 errors say e.g. "Please retry in 17.7s". */
export function suggestedRetryMs(error: unknown): number | null {
  const match = String(error instanceof Error ? error.message : error).match(/retry in ([\d.]+)s/i);
  return match ? Math.min(Math.ceil(Number(match[1]) * 1000) + 500, MAX_RATE_LIMIT_WAIT_MS) : null;
}

/** Calls Gemini, retrying on API errors or invalid output (see attemptPlan), then gives up with GeminiError. */
export async function generateJson<T>(request: JsonRequest<T>): Promise<T> {
  let lastError: unknown;
  for (const attempt of attemptPlan()) {
    const rateLimitWait = attempt.sameModelRetry && lastError ? suggestedRetryMs(lastError) ?? 0 : 0;
    if (attempt.delayMs) await sleep(Math.max(attempt.delayMs, rateLimitWait));
    try {
      const response = await client().models.generateContent({
        model: attempt.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          responseMimeType: 'application/json',
          responseJsonSchema: request.jsonSchema,
          temperature: 0,
        },
      });
      const parsed = request.validator.safeParse(JSON.parse(response.text ?? ''));
      if (parsed.success) return parsed.data;
      lastError = new Error(`Gemini output failed validation: ${parsed.error.message}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new GeminiError(`Gemini request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
