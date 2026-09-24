// The preference questionnaire, as data. Each question asks "what do you want?" and then,
// separately, "how important is it?" - Yes and Must Have are never the same thing.
import type { Criterion, Importance } from '../types';

export interface Choice {
  label: string;
  value: unknown;
  /** "Doesn't matter"-style answers: stored as no_preference, importance question skipped. */
  noPreference?: boolean;
  /** Answers that already say how important they are (used by the metro question). */
  importance?: Importance;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface Question {
  criterion: Criterion;
  prompt: string;
  input: 'choice' | 'text';
  choices?: Choice[];
  parseText?: (text: string) => ParseResult;
  /** Button shown under text questions to answer "no preference / none". */
  skipLabel?: string;
  /** Which importance buttons to show. 'fixed' = don't ask, use fixedImportance. */
  importance: 'must_prefer_none' | 'must_prefer' | 'fixed';
  fixedImportance?: Importance;
  recommended?: Importance;
  /** Commute needs a second answer (max minutes) before importance. */
  secondStep?: { prompt: string; choices: Choice[] };
}

// ---------- text parsers ----------

export function parseRupees(text: string): ParseResult {
  const cleaned = text.toLowerCase().replace(/[₹,\s]|rs\.?|inr/g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(k|l|lakh|lac)?$/);
  if (!match) return { ok: false, error: 'Please send just the amount, e.g. 25000 or 25k.' };
  const multiplier = match[2] === 'k' ? 1000 : match[2] ? 100000 : 1;
  const amount = Math.round(Number(match[1]) * multiplier);
  if (amount < 1000 || amount > 10_000_000) return { ok: false, error: 'That amount looks off - please send your monthly share in rupees, e.g. 25000.' };
  return { ok: true, value: amount };
}

export function parseList(text: string): ParseResult {
  const items = text
    .split(/,|\n|;|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60);
  if (items.length === 0) return { ok: false, error: 'Please send one or more area names separated by commas.' };
  return { ok: true, value: [...new Set(items)].slice(0, 10) };
}

const shortText = (max: number) => (text: string): ParseResult => {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Please type a short answer.' };
  if (trimmed.length > max) return { ok: false, error: `Please keep it under ${max} characters.` };
  return { ok: true, value: trimmed };
};

const yesNoMatter: Choice[] = [
  { label: 'Yes', value: true },
  { label: 'No', value: false },
  { label: "Doesn't matter", value: null, noPreference: true },
];

// ---------- the questions, in order ----------

export const QUESTIONS: Question[] = [
  {
    criterion: 'city',
    prompt: '🏙 Which <b>city</b> are you looking in?',
    input: 'text',
    parseText: shortText(60),
    importance: 'fixed',
    fixedImportance: 'no_preference', // city is search context, not a score
  },
  {
    criterion: 'max_rent',
    prompt: '💰 What is the <b>maximum monthly rent contribution</b> you are comfortable paying?\n\nSend an amount, e.g. <code>25000</code> or <code>25k</code>.',
    input: 'text',
    parseText: parseRupees,
    importance: 'must_prefer',
    recommended: 'must_have',
  },
  {
    criterion: 'areas',
    prompt: '📍 Which <b>areas</b> would you like to live in?\n\nSend one or more, separated by commas, e.g. <code>Baner, Aundh</code>.',
    input: 'text',
    parseText: parseList,
    skipLabel: 'No preference',
    importance: 'must_prefer_none',
  },
  {
    criterion: 'excluded_areas',
    prompt: '🚫 Any areas you <b>absolutely do not want</b> to live in?\n\nSend them separated by commas, or tap None.',
    input: 'text',
    parseText: parseList,
    skipLabel: 'None',
    importance: 'fixed',
    fixedImportance: 'must_have', // exclusions are always hard rules
  },
  {
    criterion: 'commute',
    prompt: '🚌 Where do you <b>regularly need to travel</b> to? (office, college, family, gym...)\n\nSend an area or place, e.g. <code>Hinjewadi Phase 1</code>.',
    input: 'text',
    parseText: shortText(80),
    skipLabel: 'Skip - no regular commute',
    importance: 'must_prefer_none',
    secondStep: {
      prompt: '⏱ <b>Maximum commute time</b> you are comfortable with?',
      choices: [15, 30, 45, 60, 90].map((m) => ({ label: `${m} min`, value: m })),
    },
  },
  {
    criterion: 'bhk',
    prompt: '🏠 Preferred <b>apartment type</b>?',
    input: 'choice',
    choices: [
      { label: '1BHK', value: 1 },
      { label: '2BHK', value: 2 },
      { label: '3BHK', value: 3 },
      { label: '4BHK+', value: 4 },
      { label: 'No preference', value: null, noPreference: true },
    ],
    importance: 'must_prefer_none',
  },
  {
    criterion: 'bathrooms',
    prompt: '🚿 <b>Minimum bathrooms</b>?',
    input: 'choice',
    choices: [
      { label: '1', value: 1 },
      { label: '2', value: 2 },
      { label: '3+', value: 3 },
      { label: 'No preference', value: null, noPreference: true },
    ],
    importance: 'must_prefer_none',
  },
  { criterion: 'lift', prompt: '🛗 <b>Lift</b>?', input: 'choice', choices: yesNoMatter, importance: 'must_prefer_none' },
  {
    criterion: 'parking',
    prompt: '🚗 <b>Parking</b>?',
    input: 'choice',
    choices: [
      { label: 'Required', value: true },
      { label: "Not required / Doesn't matter", value: null, noPreference: true },
    ],
    importance: 'must_prefer_none',
  },
  {
    criterion: 'furnishing',
    prompt: '🛋 <b>Furnishing</b>?',
    input: 'choice',
    choices: [
      { label: 'Fully furnished', value: 'fully_furnished' },
      { label: 'Semi-furnished', value: 'semi_furnished' },
      { label: 'Unfurnished', value: 'unfurnished' },
      { label: "Doesn't matter", value: null, noPreference: true },
    ],
    importance: 'must_prefer_none',
  },
  {
    criterion: 'pets',
    prompt: '🐾 <b>Pets</b>?',
    input: 'choice',
    choices: [
      { label: 'Must allow pets', value: true },
      { label: 'Pets not needed', value: null, noPreference: true },
      { label: "Doesn't matter", value: null, noPreference: true },
    ],
    importance: 'must_prefer_none',
  },
  {
    criterion: 'food',
    prompt: '🍳 Do you care whether the property has <b>vegetarian / non-vegetarian restrictions</b>?',
    input: 'choice',
    choices: [
      { label: 'Must allow non-veg', value: 'non_veg_allowed' },
      { label: 'Vegetarian-only is okay', value: 'veg_only_ok', noPreference: true },
      { label: 'No preference', value: null, noPreference: true },
    ],
    importance: 'must_prefer_none',
  },
  { criterion: 'balcony', prompt: '🌿 <b>Balcony</b>?', input: 'choice', choices: yesNoMatter, importance: 'must_prefer_none' },
  { criterion: 'gated_community', prompt: '🔒 <b>Gated community</b>?', input: 'choice', choices: yesNoMatter, importance: 'must_prefer_none' },
  {
    criterion: 'metro',
    prompt: '🚇 How much does <b>metro / public transport access</b> matter?',
    input: 'choice',
    choices: [
      { label: 'Important', value: true, importance: 'must_have' },
      { label: 'Nice to have', value: true, importance: 'prefer' },
      { label: "Doesn't matter", value: null, noPreference: true },
    ],
    importance: 'fixed',
  },
  {
    criterion: 'additional',
    prompt: '✍️ <b>Anything else that matters to you?</b>\n\nType it in your own words, e.g. <i>"Close to my parents in Aundh"</i>, or tap Nothing else.',
    input: 'text',
    parseText: shortText(300),
    skipLabel: 'Nothing else',
    importance: 'must_prefer',
  },
];

export const questionIndex = (criterion: Criterion) => QUESTIONS.findIndex((q) => q.criterion === criterion);
