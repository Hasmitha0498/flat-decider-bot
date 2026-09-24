// Returning members must be recognised by (group_id, telegram_user_id) - never restarted, never duplicated.
// Runs the real router, onboarding and group code against an in-memory database with Supabase's rules.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keyboard } from '../src/bot/telegram';

interface Sent { chatId: number; text: string; keyboard?: Keyboard }
const sent: Sent[] = [];
vi.mock('../src/bot/telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot/telegram')>();
  return {
    ...actual,
    sendMessage: vi.fn(async (chatId: number, text: string, keyboard?: Keyboard) => {
      sent.push({ chatId, text, keyboard });
      return sent.length;
    }),
    editMessage: vi.fn(async () => undefined),
    answerCallback: vi.fn(async () => undefined),
  };
});
vi.mock('../src/gemini/normalizeRequirement', () => ({ normalizeRequirement: async (text: string) => text }));
vi.mock('../src/db/repo', async () => (await import('./helpers/memoryRepo')).repo);

import { handleUpdate } from '../src/bot/handleUpdate';
import { QUESTIONS } from '../src/bot/questions';
import { repo, resetStore, store } from './helpers/memoryRepo';
import type { Preference } from '../src/types';

// ---------- helpers ----------
let updateId = 0;
const CREATOR = { id: 123, first_name: 'Hasmitha', username: 'hasmitha' };
const FRIEND = { id: 456, first_name: 'Meera', username: 'meera_old' };
type User = { id: number; first_name: string; username?: string };

async function say(user: User, text: string) {
  await handleUpdate({ update_id: ++updateId, message: { message_id: updateId, chat: { id: user.id, type: 'private' }, from: user, text } });
}
async function tap(user: User, label: string) {
  const msg = [...sent].reverse().find((m) => m.chatId === user.id && m.keyboard?.flat().some((b) => b.text.startsWith(label)));
  const button = msg?.keyboard?.flat().find((b) => b.text.startsWith(label));
  if (!button) throw new Error(`No button "${label}". Last message: ${sent.filter((m) => m.chatId === user.id).at(-1)?.text}`);
  await handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb', from: user, data: button.data, message: { message_id: 1, chat: { id: user.id, type: 'private' } } } });
}
const textsSince = (user: User, from: number) => sent.slice(from).filter((m) => m.chatId === user.id).map((m) => m.text).join('\n---\n');
const rowsFor = (tg: number, groupId: string) => store.members.filter((m) => m.telegram_user_id === tg && m.group_id === groupId);
const prefsOf = (memberId: string) => store.prefs.filter((p) => p.member_id === memberId).map(({ member_id, ...p }) => p).sort((a, b) => a.criterion.localeCompare(b.criterion));

const COMPLETE_PROFILE: Preference[] = QUESTIONS.map((q) => ({ criterion: q.criterion, desired_value: q.criterion === 'city' ? 'Pune' : null, importance: 'no_preference' }));

/** Creates a house search through the bot and gives the creator a finished, confirmed profile. */
async function creatorWithCompleteProfile() {
  await say(CREATOR, '/start');
  await tap(CREATOR, '➕ Create');
  const group = store.groups[0];
  const member = rowsFor(CREATOR.id, group.id)[0];
  for (const pref of [...COMPLETE_PROFILE, { criterion: 'max_rent', desired_value: 25000, importance: 'must_have' } as Preference]) await repo.savePreference(member.id, pref);
  await repo.setPreferencesComplete(member.id, true);
  await repo.setMemberState(member.id, null);
  return { group, member };
}

const RESTARTED = /Preference setup<\/b>\n1 of 16/;

beforeEach(() => {
  resetStore();
  sent.length = 0;
});

// ---------- the required scenarios ----------

describe('returning members', () => {
  it('Test 1: a completed member who comes back is recognised, not restarted', async () => {
    const { group, member } = await creatorWithCompleteProfile();
    const before = prefsOf(member.id);
    const from = sent.length;

    await say(CREATOR, `/join ${group.join_code}`);
    await say(CREATOR, '/start');
    await tap(CREATOR, '👀 View preferences');

    const out = textsSince(CREATOR, from);
    expect(out).toContain('Welcome back, Hasmitha 👋');
    expect(out).toContain('Your flat preferences are saved.');
    expect(out).toContain('YOUR FLAT PROFILE');
    expect(out).not.toMatch(RESTARTED);
    expect(rowsFor(CREATOR.id, group.id)).toHaveLength(1);
    expect(rowsFor(CREATOR.id, group.id)[0].id).toBe(member.id);
    expect(prefsOf(member.id)).toEqual(before);
    expect(store.members[0].preferences_complete).toBe(true);
  });

  it('Test 2: a member who stopped halfway resumes at the next unanswered question', async () => {
    const { group } = await creatorWithCompleteProfile();
    await say(FRIEND, `/join ${group.join_code}`);
    // Answer questions 1-8.
    await say(FRIEND, 'Pune');
    await say(FRIEND, '22000');
    await tap(FRIEND, 'Must have');
    await say(FRIEND, 'Baner');
    await tap(FRIEND, 'Prefer');
    await tap(FRIEND, 'None');
    await say(FRIEND, 'Shivajinagar');
    await tap(FRIEND, '45 min');
    await tap(FRIEND, 'Prefer');
    await tap(FRIEND, '3BHK');
    await tap(FRIEND, 'Must have');
    await tap(FRIEND, '2');
    await tap(FRIEND, 'Must have');
    await tap(FRIEND, 'Yes'); // lift
    await tap(FRIEND, 'Must have');
    const friend = rowsFor(FRIEND.id, group.id)[0];
    const saved = prefsOf(friend.id);
    expect(saved).toHaveLength(8);

    // The chat session is lost (e.g. Vercel restarted, user closed Telegram for days).
    await repo.setMemberState(friend.id, null);
    const from = sent.length;
    await say(FRIEND, `/join ${group.join_code}`);

    const out = textsSince(FRIEND, from);
    expect(out).toContain('Welcome back, Meera');
    expect(out).toContain('continuing from question 9');
    expect(out).toContain('<b>Preference setup</b>\n9 of 16');
    expect(out).toContain('Parking');
    expect(out).not.toMatch(RESTARTED);
    expect(prefsOf(friend.id)).toEqual(saved);
    expect(rowsFor(FRIEND.id, group.id)).toHaveLength(1);
  });

  it('Test 3: the creator can leave and rejoin without losing ownership, answers or flats', async () => {
    const { group, member } = await creatorWithCompleteProfile();
    await say(CREATOR, 'https://example-flats.in/baner-1');
    const before = prefsOf(member.id);

    await say(CREATOR, '/leave');
    await tap(CREATOR, 'Yes, leave');
    expect(store.members.find((m) => m.id === member.id).left_at).not.toBeNull();
    expect(store.prefs.some((p) => p.member_id === member.id)).toBe(true); // nothing deleted
    expect(store.listings).toHaveLength(1);

    const from = sent.length;
    await say(CREATOR, `/join ${group.join_code}`);
    await say(CREATOR, '/status');

    const out = textsSince(CREATOR, from);
    expect(out).toContain('Welcome back, Hasmitha');
    expect(out).not.toMatch(RESTARTED);
    expect(out).toContain('Hasmitha</b> (started this search)');
    expect(out).toContain('1 flat added');
    expect(rowsFor(CREATOR.id, group.id)).toHaveLength(1);
    expect(rowsFor(CREATOR.id, group.id)[0].id).toBe(member.id);
    expect(store.groups[0].created_by).toBe(CREATOR.id);
    expect(prefsOf(member.id)).toEqual(before);
    expect(store.listings[0].submitted_by).toBe(member.id);
  });

  it('Test 4: joining the same search repeatedly never creates a second member', async () => {
    const { group } = await creatorWithCompleteProfile();
    await say(FRIEND, `/join ${group.join_code}`);
    await say(FRIEND, `/join ${group.join_code}`);
    await say(FRIEND, `/join ${group.join_code.toLowerCase()}`);
    await say(FRIEND, '/start');
    await say(CREATOR, `/join ${group.join_code}`);
    await tap(CREATOR, '🔑 Join'); // the button on /start is not shown to members, but old messages can still be tapped
    expect(rowsFor(FRIEND.id, group.id)).toHaveLength(1);
    expect(rowsFor(CREATOR.id, group.id)).toHaveLength(1);
    expect(store.members).toHaveLength(2);
  });

  it('Test 5: a changed Telegram username is the same member', async () => {
    const { group } = await creatorWithCompleteProfile();
    await say(FRIEND, `/join ${group.join_code}`);
    const original = rowsFor(FRIEND.id, group.id)[0];

    const renamed = { ...FRIEND, username: 'meera_new' };
    await say(renamed, '/status');
    await say(renamed, `/join ${group.join_code}`);

    const rows = rowsFor(FRIEND.id, group.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].telegram_username).toBe('meera_new');
  });

  it('Test 6: saved preferences only change through an explicit edit', async () => {
    const { group, member } = await creatorWithCompleteProfile();
    const before = prefsOf(member.id);

    await say(CREATOR, `/join ${group.join_code}`);
    await say(CREATOR, '/start');
    await tap(CREATOR, '➕ Create'); // an old "Create" button must not start a new profile either
    await say(CREATOR, '/preferences');
    expect(prefsOf(member.id)).toEqual(before);
    expect(store.groups).toHaveLength(1);

    // Deliberate edit: only the edited answer changes.
    await tap(CREATOR, '✏️ Edit preferences');
    await tap(CREATOR, 'Lift');
    await tap(CREATOR, 'Yes');
    await tap(CREATOR, 'Prefer');
    const after = prefsOf(member.id);
    expect(after.find((p) => p.criterion === 'lift')).toEqual({ criterion: 'lift', desired_value: true, importance: 'prefer' });
    expect(after.filter((p) => p.criterion !== 'lift')).toEqual(before.filter((p) => p.criterion !== 'lift'));
  });

  it('a member of one search who enters another code is told how to switch, not duplicated', async () => {
    const { group } = await creatorWithCompleteProfile();
    const other = await repo.createGroup('Other search', 999);
    const from = sent.length;
    await say(CREATOR, `/join ${other.join_code}`);
    expect(textsSince(CREATOR, from)).toContain('send /leave first');
    expect(store.members.filter((m) => m.telegram_user_id === CREATOR.id)).toHaveLength(1);
    expect(store.members[0].group_id).toBe(group.id);
  });

  it('Test 7 (app level): a racing duplicate insert resolves to the existing member', async () => {
    const { group, member } = await creatorWithCompleteProfile();
    await expect(repo.addMember({ groupId: group.id, telegramUserId: CREATOR.id, username: null, displayName: 'x' })).rejects.toMatchObject({ code: '23505' });
    const { member: same, outcome } = await repo.ensureMembership({ groupId: group.id, telegramUserId: CREATOR.id, username: 'hasmitha', displayName: 'Hasmitha' });
    expect(outcome).toBe('existing');
    expect(same.id).toBe(member.id);
    expect(same.preferences_complete).toBe(true);
  });
});
