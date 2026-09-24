// Gemini JOB 3: explain the already-computed result in plain language.
// Gemini receives the finished evaluation and may NOT change it - it only writes the "MAIN TRADEOFF" paragraph.
// If Gemini fails, a deterministic sentence is used instead.
import { z } from 'zod';
import { CRITERION_NAMES } from '../matching/describe';
import type { ListingEvaluation } from '../matching/rank';
import { generateJson } from './client';

const SCHEMA = {
  type: 'object',
  properties: {
    tradeoffs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { option: { type: 'integer' }, text: { type: 'string' } },
        required: ['option', 'text'],
      },
    },
  },
  required: ['tradeoffs'],
};

const Validator = z.object({ tradeoffs: z.array(z.object({ option: z.number().int(), text: z.string().min(1) })) });

const SYSTEM = `You write the "main tradeoff" for each flat a group of friends is considering.
You are given the final, already-decided evaluation. Do not re-rank, re-score or change any status.
Use only the facts provided. Do not invent amenities, distances or opinions.
2 sentences max per option, friendly and plain. Mention who it works well for and what the main compromise or open question is.
If the status is hard_conflict, clearly say which hard requirement it breaks.
Never say a flat is "the best" or tell the group what to choose.`;

/** Compact, name-and-outcome-only summary sent to Gemini (no URLs, no raw listing text). */
export function summarizeForExplanation(options: ListingEvaluation[]) {
  return options.map((option, index) => ({
    option: index + 1,
    status: option.status,
    members: option.members.map((m) => ({
      name: m.name,
      preference_match_percent: m.prefPercent,
      matched: m.results.filter((r) => r.state === 'match' && r.importance !== 'no_preference').map((r) => r.label),
      failed_preferences: m.results.filter((r) => r.state === 'fail' && r.importance === 'prefer').map((r) => r.label),
      broken_hard_requirements: m.hardFails.map((r) => `${CRITERION_NAMES[r.criterion]}: wanted ${r.wanted}, listing: ${r.label}`),
      needs_verification: m.results.filter((r) => r.state === 'unknown').map((r) => CRITERION_NAMES[r.criterion]),
    })),
  }));
}

export function fallbackTradeoff(option: ListingEvaluation): string {
  if (option.status === 'hard_conflict') {
    const broken = option.members.flatMap((m) => m.hardFails.map((f) => `${m.name}'s ${CRITERION_NAMES[f.criterion].toLowerCase()} requirement`));
    return `This is the closest alternative, but it breaks ${broken.join(' and ')}.`;
  }
  const scored = option.members.filter((m) => m.prefPercent !== null).sort((a, b) => b.prefPercent! - a.prefPercent!);
  if (scored.length === 0) return 'Most preferences could not be confirmed from the listing, so check the details below together.';
  const best = scored[0];
  const worst = scored[scored.length - 1];
  if (best === worst || best.prefPercent === worst.prefPercent) {
    return `Preferences are evenly met across the group (${worst.prefPercent}% each for those with confirmed preferences).`;
  }
  return `This works best for ${best.name} (${best.prefPercent}%). ${worst.name} gets the least of what they prefer (${worst.prefPercent}%).`;
}

export async function explainTradeoffs(options: ListingEvaluation[]): Promise<string[]> {
  const fallback = options.map(fallbackTradeoff);
  try {
    const result = await generateJson({
      system: SYSTEM,
      prompt: JSON.stringify(summarizeForExplanation(options)),
      jsonSchema: SCHEMA,
      validator: Validator,
    });
    return options.map((_, index) => {
      const text = result.tradeoffs.find((t) => t.option === index + 1)?.text;
      return text ? text.slice(0, 500) : fallback[index];
    });
  } catch (error) {
    console.warn('explainTradeoffs fell back to template text:', String(error));
    return fallback;
  }
}
