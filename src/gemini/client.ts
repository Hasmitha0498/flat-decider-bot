// Thin wrapper around the official Gemini SDK (@google/genai) that only ever returns
// schema-validated JSON. We never parse free-form prose from the model.
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { geminiFallbackModel, geminiModel, requireEnv } from '../config';

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

// Attempt plan: main model, main model again after a pause, then the fallback model.
// Pauses help with Gemini's short "high demand" (503) / rate-limit (429) spikes.
const ATTEMPTS = [
  { delayMs: 0, fallback: false },
  { delayMs: 2000, fallback: false },
  { delayMs: 4000, fallback: true },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls Gemini, retrying on API errors or invalid output (see ATTEMPTS), then gives up with GeminiError. */
export async function generateJson<T>(request: JsonRequest<T>): Promise<T> {
  let lastError: unknown;
  for (const attempt of ATTEMPTS) {
    if (attempt.delayMs) await sleep(attempt.delayMs);
    try {
      const response = await client().models.generateContent({
        model: attempt.fallback ? geminiFallbackModel() : geminiModel(),
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
