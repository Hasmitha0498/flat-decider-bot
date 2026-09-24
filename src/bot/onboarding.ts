// Preference questionnaire flow: one question at a time, inline buttons wherever possible.
// Every answer is saved to the database immediately, so a member can stop and resume anytime.
import * as repo from '../db/repo';
import { normalizeRequirement } from '../gemini/normalizeRequirement';
import { CRITERION_NAMES } from '../matching/describe';
import type { ChatState, Importance, Member, Preference } from '../types';
import type { Ctx } from './context';
import { formatProfile } from './format';
import { QUESTIONS, type Choice, type Question } from './questions';
import { editMessage, escapeHtml, sendMessage, type Keyboard } from './telegram';

type QuestionnaireState = Extract<ChatState, { kind: 'questionnaire' }>;

const IMPORTANCE_CODES: Record<string, Importance> = { m: 'must_have', p: 'prefer', n: 'no_preference' };

function header(state: QuestionnaireState): string {
  return state.mode === 'setup' ? `<b>Preference setup</b>\n${state.index + 1} of ${QUESTIONS.length}\n\n` : '<b>Edit preference</b>\n\n';
}

function choiceKeyboard(index: number, prefix: 'ans' | 'sec', choices: Choice[]): Keyboard {
  const buttons = choices.map((c, i) => ({ text: c.label, data: `${prefix}:${index}:${i}` }));
  // Short labels side by side, long labels one per row.
  const rows: Keyboard = [];
  const perRow = buttons.every((b) => b.text.length <= 12) ? 3 : 1;
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

function importanceKeyboard(index: number, question: Question): Keyboard {
  const label = (imp: Importance, text: string) => (question.recommended === imp ? `${text} (recommended)` : text);
  const rows: Keyboard = [[{ text: label('must_have', 'Must have'), data: `imp:${index}:m` }], [{ text: label('prefer', 'Prefer'), data: `imp:${index}:p` }]];
  if (question.importance === 'must_prefer_none') rows.push([{ text: 'No preference', data: `imp:${index}:n` }]);
  return rows;
}

async function ask(ctx: Ctx, state: QuestionnaireState): Promise<void> {
  const question = QUESTIONS[state.index];
  const top = header(state);

  if (state.stage === 'importance') {
    await sendMessage(ctx.chatId, `${top}How important is this?`, importanceKeyboard(state.index, question));
  } else if (state.stage === 'second' && question.secondStep) {
    await sendMessage(ctx.chatId, top + question.secondStep.prompt, choiceKeyboard(state.index, 'sec', question.secondStep.choices));
  } else if (question.input === 'choice') {
    await sendMessage(ctx.chatId, top + question.prompt, choiceKeyboard(state.index, 'ans', question.choices!));
  } else {
    const keyboard = question.skipLabel ? [[{ text: question.skipLabel, data: `skip:${state.index}` }]] : undefined;
    await sendMessage(ctx.chatId, top + question.prompt, keyboard);
  }
}

export async function startQuestionnaire(ctx: Ctx, member: Member): Promise<void> {
  const state: QuestionnaireState = { kind: 'questionnaire', mode: 'setup', index: 0, stage: 'value' };
  await repo.setMemberState(member.id, state);
  await repo.setPreferencesComplete(member.id, false);
  await sendMessage(ctx.chatId, `Let's set up <b>your</b> flat profile. ${QUESTIONS.length} quick questions - your answers are only compared, never shared as a list.\n\nFor each thing, I'll ask what you want and then how important it is.`);
  await ask(ctx, state);
}

/** Continue an interrupted questionnaire at the first unanswered question, or show the summary. */
export async function resumeQuestionnaire(ctx: Ctx, member: Member): Promise<void> {
  const answered = new Set((await repo.getPreferences(member.id)).map((p) => p.criterion));
  const index = QUESTIONS.findIndex((q) => !answered.has(q.criterion));
  if (index === -1) return showProfileForConfirmation(ctx, member);
  const state: QuestionnaireState = { kind: 'questionnaire', mode: 'setup', index, stage: 'value' };
  await repo.setMemberState(member.id, state);
  await sendMessage(ctx.chatId, "Let's finish your flat profile.");
  await ask(ctx, state);
}

export async function startEdit(ctx: Ctx, member: Member, criterionIndex: number): Promise<void> {
  if (!QUESTIONS[criterionIndex]) return showEditMenu(ctx);
  const state: QuestionnaireState = { kind: 'questionnaire', mode: 'edit', index: criterionIndex, stage: 'value' };
  await repo.setMemberState(member.id, state);
  await repo.setPreferencesComplete(member.id, false);
  await ask(ctx, state);
}

export async function showEditMenu(ctx: Ctx): Promise<void> {
  const buttons = QUESTIONS.map((q, i) => ({ text: CRITERION_NAMES[q.criterion], data: `edit:${i}` }));
  const rows: Keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await sendMessage(ctx.chatId, 'Which preference do you want to change?', rows);
}

export async function showProfileForConfirmation(ctx: Ctx, member: Member): Promise<void> {
  const prefs = await repo.getPreferences(member.id);
  await sendMessage(ctx.chatId, formatProfile(prefs), [
    [{ text: '✅ Looks good', data: 'profile:confirm' }],
    [{ text: '✏️ Edit preferences', data: 'profile:edit' }],
  ]);
}

async function save(member: Member, question: Question, desired: unknown, importance: Importance): Promise<void> {
  const pref: Preference = { criterion: question.criterion, desired_value: desired ?? null, importance };
  await repo.savePreference(member.id, pref);
}

async function advance(ctx: Ctx, member: Member, state: QuestionnaireState): Promise<void> {
  const nextIndex = state.index + 1;
  if (state.mode === 'edit' || nextIndex >= QUESTIONS.length) {
    await repo.setMemberState(member.id, null);
    await showProfileForConfirmation(ctx, member);
    return;
  }
  const next: QuestionnaireState = { kind: 'questionnaire', mode: state.mode, index: nextIndex, stage: 'value' };
  await repo.setMemberState(member.id, next);
  await ask(ctx, next);
}

/** Called once we have "what they want". Decides whether to ask importance / second step. */
async function handleValue(ctx: Ctx, member: Member, state: QuestionnaireState, value: unknown, choice?: Choice): Promise<void> {
  const question = QUESTIONS[state.index];

  if (choice?.noPreference) {
    await save(member, question, choice.value ?? null, 'no_preference');
    return advance(ctx, member, state);
  }
  if (choice?.importance) {
    await save(member, question, value, choice.importance);
    return advance(ctx, member, state);
  }
  if (question.secondStep && state.stage === 'value') {
    const next: QuestionnaireState = { ...state, stage: 'second', pending: value };
    await repo.setMemberState(member.id, next);
    return ask(ctx, next);
  }
  if (question.importance === 'fixed') {
    await save(member, question, value, question.fixedImportance ?? 'prefer');
    return advance(ctx, member, state);
  }
  const next: QuestionnaireState = { ...state, stage: 'importance', pending: value };
  await repo.setMemberState(member.id, next);
  return ask(ctx, next);
}

/** Free-text answer while in the questionnaire. */
export async function handleQuestionnaireText(ctx: Ctx, member: Member, state: QuestionnaireState, text: string): Promise<void> {
  const question = QUESTIONS[state.index];
  if (state.stage !== 'value' || question.input !== 'text' || !question.parseText) {
    await sendMessage(ctx.chatId, 'Please tap one of the buttons above 👆 (or /cancel to stop).');
    return;
  }
  const parsed = question.parseText(text);
  if (!parsed.ok) {
    await sendMessage(ctx.chatId, parsed.error);
    return;
  }
  let value = parsed.value;
  if (question.criterion === 'commute') value = { destination: value as string };
  if (question.criterion === 'additional') value = { text: value as string, check: await normalizeRequirement(value as string) };
  await handleValue(ctx, member, state, value);
}

/** Button presses inside the questionnaire: ans / sec / imp / skip. */
export async function handleQuestionnaireButton(ctx: Ctx, member: Member, action: string, index: number, arg: string, messageId?: number): Promise<string | undefined> {
  const state = member.state;
  if (!state || state.kind !== 'questionnaire' || state.index !== index) return 'That question is no longer active.';
  const question = QUESTIONS[index];
  const answered = async (label: string) => {
    if (messageId) await editMessage(ctx.chatId, messageId, `${header(state)}${question.prompt}\n\n→ <b>${escapeHtml(label)}</b>`);
  };

  if (action === 'ans' && state.stage === 'value' && question.choices) {
    const choice = question.choices[Number(arg)];
    if (!choice) return 'Unknown option.';
    await answered(choice.label);
    await handleValue(ctx, member, state, choice.value, choice);
    return;
  }

  if (action === 'skip' && state.stage === 'value' && question.skipLabel) {
    await answered(question.skipLabel);
    await save(member, question, null, 'no_preference');
    await advance(ctx, member, state);
    return;
  }

  if (action === 'sec' && state.stage === 'second' && question.secondStep) {
    const choice = question.secondStep.choices[Number(arg)];
    if (!choice) return 'Unknown option.';
    if (messageId) await editMessage(ctx.chatId, messageId, `${header(state)}${question.secondStep.prompt}\n\n→ <b>${escapeHtml(choice.label)}</b>`);
    const value = { ...(state.pending as object), max_minutes: choice.value };
    const next: QuestionnaireState = { ...state, stage: 'importance', pending: value };
    await repo.setMemberState(member.id, next);
    await ask(ctx, next);
    return;
  }

  if (action === 'imp' && state.stage === 'importance') {
    const importance = IMPORTANCE_CODES[arg];
    if (!importance) return 'Unknown option.';
    if (messageId) await editMessage(ctx.chatId, messageId, `${header(state)}How important is this?\n\n→ <b>${importance === 'must_have' ? 'Must have' : importance === 'prefer' ? 'Prefer' : 'No preference'}</b>`);
    await save(member, question, importance === 'no_preference' ? null : state.pending, importance);
    await advance(ctx, member, state);
    return;
  }

  return 'That button has expired.';
}

export async function confirmProfile(ctx: Ctx, member: Member): Promise<void> {
  const prefs = await repo.getPreferences(member.id);
  const missing = QUESTIONS.filter((q) => !prefs.some((p) => p.criterion === q.criterion));
  if (missing.length) {
    await sendMessage(ctx.chatId, `A few questions are still unanswered (${missing.map((q) => CRITERION_NAMES[q.criterion]).join(', ')}). Send /edit to answer them.`);
    return;
  }
  await repo.setPreferencesComplete(member.id, true);
  await repo.setMemberState(member.id, null);
  await sendMessage(
    ctx.chatId,
    '✅ <b>Profile saved.</b>\n\nNext, add flats you like with /add (send the listing link).\nSee who is ready with /status. When everyone is done, anyone can run /compare.',
  );
}
