// Thin wrapper around the official Gemini SDK (@google/genai) that only ever returns
// schema-validated JSON. We never parse free-form prose from the model.
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { geminiModel, requireEnv } from '../config';

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

/** Calls Gemini once, retries once on API errors or invalid output, then gives up with GeminiError. */
export async function generateJson<T>(request: JsonRequest<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await client().models.generateContent({
        model: geminiModel(),
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
