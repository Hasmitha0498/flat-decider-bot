// End-to-end conversation test: real router, onboarding, listing and compare code,
// with an in-memory database, a fake Telegram and a fake Gemini.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keyboard } from '../src/bot/telegram';

// ---------- fake Telegram ----------
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

// ---------- fake Gemini ----------
vi.mock('../src/gemini/client', () => ({
  GeminiError: class GeminiError extends Error {},
  generateJson: vi.fn(async () => {
    throw new Error('offline'); // explanations fall back to the deterministic template
  }),
}));
vi.mock('../src/gemini/extractListing', () => {
  // Reads "rent=63000 lift=yes" style test descriptions. Missing keys stay null (unknown).
  const extractOne = (text: string) => {
    const get = (key: string) => text.match(new RegExp(`${key}=(\\S+)`))?.[1] ?? null;
    const bool = (key: string) => (get(key) === null ? null : get(key) === 'yes');
    const num = (key: string) => (get(key) === null ? null : Number(get(key)));
    if (!get('rent')) return { ok: false, reason: 'not enough listing details could be read' };
    return {
      ok: true,
      customAnswers: {},
      facts: {
        title: null, rent_total: num('rent'), location: get('area'), city: 'Pune', bhk: num('bhk'), bathrooms: num('bath'),
        lift: bool('lift'), parking: bool('parking'), pets_allowed: bool('pets'), food_restriction: null, furnishing: null,
        balcony: bool('balcony'), gated_community: null, metro_nearby: null, source_confidence: {},
      },
    };
  };
  return {
    extractListingFacts: vi.fn(async (listings: { id: string; text: string }[]) => new Map(listings.map((l) => [l.id, extractOne(l.text)]))),
  };
});
vi.mock('../src/listings/fetchPage', () => ({
  fetchListingText: vi.fn(async () => ({ ok: false, reason: 'the site requires a login or blocks automated access' })),
}));

// ---------- in-memory database ----------
const store = { groups: [] as any[], members: [] as any[], prefs: [] as any[], listings: [] as any[], extractions: [] as any[], runs: [] as any[] };
let nextId = 1;
const id = () => `id${nextId++}`;

vi.mock('../src/db/repo', () => ({
  createGroup: async (name: string, createdBy: number | null, isDemo = false) => {
    const g = { id: id(), name, join_code: `CODE${nextId}`, created_by: createdBy, status: 'active', is_demo: isDemo, created_at: '' };
    store.groups.push(g);
    return g;
  },
  getGroupByCode: async (code: string) => store.groups.find((g) => g.join_code === code.toUpperCase()) ?? null,
  getGroup: async (groupId: string) => store.groups.find((g) => g.id === groupId),
  deleteGroup: async (groupId: string) => {
    store.groups = store.groups.filter((g) => g.id !== groupId);
    store.members = store.members.filter((m) => m.group_id !== groupId);
  },
  getMemberByTelegramId: async (tg: number) => structuredClone(store.members.find((m) => m.telegram_user_id === tg) ?? null),
  getMember: async (memberId: string) => store.members.find((m) => m.id === memberId),
  addMember: async (input: any) => {
    const m = { id: id(), group_id: input.groupId, telegram_user_id: input.telegramUserId, telegram_username: input.username, display_name: input.displayName, preferences_complete: false, state: null };
    store.members.push(m);
    return structuredClone(m);
  },
  getMembers: async (groupId: string) => store.members.filter((m) => m.group_id === groupId),
  setMemberState: async (memberId: string, state: unknown) => void (store.members.find((m) => m.id === memberId).state = structuredClone(state)),
  setPreferencesComplete: async (memberId: string, v: boolean) => void (store.members.find((m) => m.id === memberId).preferences_complete = v),
  deleteMember: async (memberId: string) => void (store.members = store.members.filter((m) => m.id !== memberId)),
  savePreference: async (memberId: string, pref: any) => {
    store.prefs = store.prefs.filter((p) => !(p.member_id === memberId && p.criterion === pref.criterion));
    store.prefs.push({ member_id: memberId, ...structuredClone(pref) });
  },
  getPreferences: async (memberId: string) => store.prefs.filter((p) => p.member_id === memberId).map(({ member_id, ...p }) => p),
  getPreferencesForMembers: async (ids: string[]) => new Map(ids.map((mid) => [mid, store.prefs.filter((p) => p.member_id === mid).map(({ member_id, ...p }) => p)])),
  findListingByNormalizedUrl: async (groupId: string, url: string) => store.listings.find((l) => l.group_id === groupId && l.normalized_url === url) ?? null,
  addListing: async (input: any) => {
    const l = { id: id(), group_id: input.groupId, submitted_by: input.memberId, url: input.url, normalized_url: input.normalizedUrl, manual_text: input.manualText ?? null, status: 'pending', status_detail: null, created_at: '' };
    store.listings.push(l);
    return l;
  },
  getListings: async (groupId: string) => store.listings.filter((l) => l.group_id === groupId),
  getListing: async (listingId: string) => store.listings.find((l) => l.id === listingId) ?? null,
  deleteListing: async () => true,
  setListingManualText: async (listingId: string, text: string) => Object.assign(store.listings.find((l) => l.id === listingId), { manual_text: text, status: 'pending' }),
  setListingStatus: async (listingId: string, status: string, detail: string | null) => Object.assign(store.listings.find((l) => l.id === listingId), { status, status_detail: detail }),
  getExtractions: async () => new Map(store.extractions.map((e) => [e.listing_id, e])),
  saveExtraction: async (e: any) => void store.extractions.push(e),
  saveComparisonRun: async (groupId: string, _m: string, results: unknown) => {
    const r = { id: id(), group_id: groupId, results: structuredClone(results) };
    store.runs.push(r);
    return r.id;
  },
  getComparisonRun: async (runId: string) => store.runs.find((r) => r.id === runId) ?? null,
  getLatestComparisonRun: async (groupId: string) => [...store.runs].reverse().find((r) => r.group_id === groupId) ?? null,
}));

import { handleUpdate } from '../src/bot/handleUpdate';

// ---------- helpers ----------
let updateId = 0;
const users: Record<string, number> = { Riya: 101, Meera: 102 };

async function say(name: string, text: string) {
  const uid = users[name];
  await handleUpdate({ update_id: ++updateId, message: { message_id: updateId, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: name }, text } });
}

async function tap(name: string, label: string) {
  const uid = users[name];
  const withButtons = [...sent].reverse().find((m) => m.chatId === uid && m.keyboard?.flat().some((b) => b.text.startsWith(label)));
  const button = withButtons?.keyboard?.flat().find((b) => b.text.startsWith(label));
  if (!button) throw new Error(`No button "${label}" for ${name}. Last message: ${sent.filter((m) => m.chatId === uid).at(-1)?.text}`);
  await handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb', from: { id: uid, first_name: name }, data: button.data, message: { message_id: 1, chat: { id: uid, type: 'private' } } } });
}

const lastText = (name: string) => sent.filter((m) => m.chatId === users[name]).at(-1)?.text ?? '';
const allText = (name: string) => sent.filter((m) => m.chatId === users[name]).map((m) => m.text).join('\n---\n');

/** Answers all 16 questions. `lift` decides this person's lift answer + importance. */
async function completeProfile(name: string, budget: string, lift: { value: 'Yes' | "Doesn't matter"; importance?: 'Must have' | 'Prefer' }) {
  await say(name, 'Pune');
  await say(name, budget);
  await tap(name, 'Must have'); // budget importance
  await say(name, 'Baner, Aundh');
  await tap(name, 'Prefer');
  await tap(name, 'None'); // excluded areas
  await say(name, 'Hinjewadi');
  await tap(name, '30 min');
  await tap(name, 'Prefer');
  await tap(name, '3BHK');
  await tap(name, 'Must have');
  await tap(name, '2');
  await tap(name, 'Prefer');
  await tap(name, lift.value);
  if (lift.importance) await tap(name, lift.importance);
  await tap(name, 'Not required');
  await tap(name, "Doesn't matter"); // furnishing
  await tap(name, "Doesn't matter"); // pets
  await tap(name, 'No preference'); // food
  await tap(name, 'Yes'); // balcony
  await tap(name, 'Prefer');
  await tap(name, "Doesn't matter"); // gated
  await tap(name, "Doesn't matter"); // metro
  await tap(name, 'Nothing else');
}

beforeEach(() => {
  sent.length = 0;
  process.env.GEMINI_API_KEY = 'test-key';
});

describe('full conversation', () => {
  it('create → join → preferences → add flats → compare → details', async () => {
    await say('Riya', '/start');
    expect(lastText('Riya')).toContain('Find the flats your group can actually agree on');
    await tap('Riya', '➕ Create');
    const code = store.groups[0].join_code;
    expect(allText('Riya')).toContain(`/join ${code}`);
    expect(lastText('Riya')).toContain('<b>Preference setup</b>\n1 of 16');

    await say('Meera', '/join WRONG1');
    expect(lastText('Meera')).toContain("couldn't find a house search");
    await say('Meera', `/join ${code.toLowerCase()}`);
    expect(allText('Meera')).toContain('You joined');

    await completeProfile('Riya', '25k', { value: "Doesn't matter" });
    expect(lastText('Riya')).toContain('YOUR FLAT PROFILE');
    expect(lastText('Riya')).toContain('<b>Max rent:</b> ₹25,000 per person\nMUST HAVE');

    // Not confirmed yet → compare is blocked.
    await say('Riya', '/compare');
    expect(lastText('Riya')).toContain('Not ready to compare yet');
    expect(lastText('Riya')).toContain('Riya and Meera have not finished');

    const riyaSummary = [...sent].reverse().find((m) => m.chatId === users.Riya && m.text.includes('YOUR FLAT PROFILE'));
    expect(riyaSummary?.keyboard?.flat().map((b) => b.text)).toEqual(['✅ Looks good', '✏️ Edit preferences']);
    await tap('Riya', '✅ Looks good');
    expect(lastText('Riya')).toContain('Profile saved');

    await completeProfile('Meera', '22000', { value: 'Yes', importance: 'Must have' });
    await tap('Meera', '✅ Looks good');

    // Editing un-confirms the profile until "Looks good" again.
    await say('Meera', '/edit');
    await tap('Meera', 'Lift');
    await tap('Meera', 'Yes');
    await tap('Meera', 'Must have');
    expect(store.members.find((m) => m.display_name === 'Meera').preferences_complete).toBe(false);
    await tap('Meera', '✅ Looks good');

    await say('Riya', '/compare');
    expect(lastText('Riya')).toContain('No flats have been added yet');

    // Add flats: one via /add + link, others by pasting links directly.
    await say('Riya', '/add');
    await say('Riya', 'https://www.example-flats.in/baner-a?utm_source=whatsapp');
    expect(lastText('Riya')).toContain('Apartment added');
    expect(lastText('Riya')).toContain('The group currently has 1 unique flat');
    await say('Meera', 'https://example-flats.in/baner-a/');
    expect(lastText('Meera')).toContain('already on the group');
    await say('Meera', 'https://example-flats.in/aundh-no-lift');
    await say('Meera', 'https://example-flats.in/baner-lift-unknown');
    await say('Riya', 'https://example-flats.in/needs-login');

    // Details: Meera uses the real "Add details manually" flow; the others are pre-filled. One stays unreadable.
    const [a, , liftUnknown] = store.listings;
    store.listings.find((l) => l.id === a.id).manual_text = 'rent=40000 area=Baner bhk=3 bath=2 lift=yes balcony=yes';
    store.listings.find((l) => l.id === liftUnknown.id).manual_text = 'rent=42000 area=Baner bhk=3 bath=2 balcony=no';
    await say('Meera', '/listings');
    expect(lastText('Meera')).toContain('YOUR FLATS');
    await tap('Meera', '📝 Add details manually - #1');
    expect(lastText('Meera')).toContain('Paste the listing description');
    await say('Meera', 'too short');
    expect(lastText('Meera')).toContain('too short');
    await say('Meera', 'Lovely flat. rent=38000 area=Aundh bhk=3 bath=2 lift=no balcony=yes. Available now.');
    expect(lastText('Meera')).toContain('Details saved');

    // Only the person who added a flat can paste its details.
    const riyaListing = store.listings.find((l) => l.url.includes('needs-login'));
    await handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb', from: { id: users.Meera, first_name: 'Meera' }, data: `manual:${riyaListing.id}`, message: { message_id: 1, chat: { id: users.Meera, type: 'private' } } } });
    expect(lastText('Meera')).toContain('Only Riya');

    await say('Riya', '/status');
    expect(lastText('Riya')).toContain('4 flats ready to compare');

    sent.length = 0;
    await say('Riya', '/compare');
    const out = allText('Riya');
    expect(out).toContain('Comparing 4 flats against 2 people');
    expect(out).toContain('3 FLATS WORTH DISCUSSING');
    expect(out).toContain('I found only 2 flats');
    expect(out).toContain('✅ QUALIFIED');
    expect(out).toContain('⚠️ NEEDS VERIFICATION');
    expect(out).toContain('NEAR MATCH WITH HARD-RULE CONFLICT');
    expect(out).toContain('Meera requires: Lift - Yes.');
    expect(out).toContain('NOT INCLUDED IN THIS COMPARISON');
    expect(out).toContain('requires a login');
    expect(out).toContain('I have not chosen a flat for you.');
    // Order: qualified, needs verification, conflict.
    expect(out.indexOf('OPTION 1')).toBeLessThan(out.indexOf('QUALIFIED'));
    expect(out.indexOf('NEEDS VERIFICATION -')).toBeLessThan(out.indexOf('NEAR MATCH'));

    const before = sent.length;
    await tap('Riya', '🔍 See full comparison');
    const details = sent.slice(before).map((m) => m.text).join('\n');
    expect(details).toContain('FULL COMPARISON');
    expect(details).toContain('<b>LIFT</b>');
    expect(details).toContain('Must have: Yes');
    expect(details).toContain('No preference\n➖');
  });
});
