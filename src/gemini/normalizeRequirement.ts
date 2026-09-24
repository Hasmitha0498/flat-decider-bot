// Gemini JOB 2 (part 1): turn a free-text requirement into a yes/no question a listing could answer.
// If Gemini is unavailable we simply keep the person's own words - nothing breaks.
import { z } from 'zod';
import { isGeminiConfigured } from '../config';
import { generateJson } from './client';

const SCHEMA = {
  type: 'object',
  properties: { check_question: { type: 'string', description: 'One short yes/no question about a rental listing' } },
  required: ['check_question'],
};

const Validator = z.object({ check_question: z.string().min(3).max(200) });

export async function normalizeRequirement(text: string): Promise<string> {
  if (!isGeminiConfigured()) return text;
  try {
    const result = await generateJson({
      system:
        'Rewrite a flat-hunter\'s requirement as ONE short yes/no question that could be answered from the text of a rental listing. ' +
        'Keep place names exactly as written. Do not add new requirements.',
      prompt: `Requirement: ${text}`,
      jsonSchema: SCHEMA,
      validator: Validator,
    });
    return result.check_question;
  } catch (error) {
    console.warn('normalizeRequirement fell back to raw text:', String(error));
    return text;
  }
}
