// Thin wrapper around the official Gemini SDK (@google/genai) that only ever returns
// schema-validated JSON. We never parse free-form prose from the model.
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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

// Attempt plan: two rounds through [main model, ...fallback models], with a longer pause between rounds.
// Gemini often answers "high demand" (503) for a few seconds at a time, and each model has its own capacity,
// so moving on to the next model is faster than hammering an overloaded one. On a rate limit (429) the
// retry of that same model in round 2 waits as long as Gemini asks (capped): the free tier allows ~5 calls/min.
export function attemptPlan(): { model: string; delayMs: number }[] {
  const models = [...new Set([geminiModel(), ...geminiFallbackModels()])]; // main first, no model twice per round
  const round = (firstDelayMs: number) => models.map((model, i) => ({ model, delayMs: i === 0 ? firstDelayMs : 500 }));
  return [...round(0), ...round(4000)];
}
const MAX_RATE_LIMIT_WAIT_MS = 35_000;

// Extraction and explanations need little reasoning. Low thinking keeps calls to a few seconds; at the
// default level a long listing page can exceed the deadline (504 DEADLINE_EXCEEDED).
const THINKING_LEVEL = ThinkingLevel.LOW;
const modelsWithoutThinkingLevel = new Set<string>(); // learned at runtime from 400 errors

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gemini's 429 errors say e.g. "Please retry in 17.7s". */
export function suggestedRetryMs(error: unknown): number | null {
  const match = String(error instanceof Error ? error.message : error).match(/retry in ([\d.]+)s/i);
  return match ? Math.min(Math.ceil(Number(match[1]) * 1000) + 500, MAX_RATE_LIMIT_WAIT_MS) : null;
}

/** Calls Gemini, retrying on API errors or invalid output (see attemptPlan), then gives up with GeminiError. */
export async function generateJson<T>(request: JsonRequest<T>): Promise<T> {
  let lastError: unknown;
  const rateLimitedUntil = new Map<string, number>();

  for (const attempt of attemptPlan()) {
    const waitForRateLimit = Math.max(0, (rateLimitedUntil.get(attempt.model) ?? 0) - Date.now());
    const delay = Math.max(attempt.delayMs, waitForRateLimit);
    if (delay) await sleep(delay);

    const started = Date.now();
    try {
      return await callOnce(request, attempt.model);
    } catch (error) {
      lastError = error;
      // Server-side log only (no prompt, no key): which model failed, how fast, and Gemini's status.
      const status = String(error instanceof Error ? error.message : error).match(/"status":\s*"([A-Z_]+)"|aborted|validation/i)?.[0] ?? 'error';
      console.warn(`[gemini] ${attempt.model} failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${status}`);
      const retryMs = suggestedRetryMs(error);
      if (retryMs) rateLimitedUntil.set(attempt.model, Date.now() + retryMs);
    }
  }
  throw new GeminiError(`Gemini request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** One call to one model. Retries once immediately if the model rejects the thinking setting. */
async function callOnce<T>(request: JsonRequest<T>, model: string): Promise<T> {
  const useThinking = !modelsWithoutThinkingLevel.has(model);
  let response;
  try {
    response = await client().models.generateContent({
      model,
      contents: request.prompt,
      config: {
        systemInstruction: request.system,
        responseMimeType: 'application/json',
        responseJsonSchema: request.jsonSchema,
        temperature: 0,
        ...(useThinking ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {}),
      },
    });
  } catch (error) {
    if (useThinking && /thinking/i.test(String(error instanceof Error ? error.message : error)) && /400|INVALID_ARGUMENT/.test(String(error))) {
      modelsWithoutThinkingLevel.add(model);
      return callOnce(request, model);
    }
    throw error;
  }
  const parsed = request.validator.safeParse(JSON.parse(response.text ?? ''));
  if (!parsed.success) throw new Error(`Gemini output failed validation: ${parsed.error.message}`);
  return parsed.data;
}
