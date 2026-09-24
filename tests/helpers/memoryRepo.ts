// In-memory stand-in for src/db/repo.ts used by conversation tests.
// It enforces the same rules as the real database (see supabase/migrations/002_persistent_membership.sql):
//   - one member row per (group_id, telegram_user_id)
//   - at most one ACTIVE (left_at is null) membership per telegram_user_id
import { DatabaseError } from '../../src/db/supabase';

export const store = {
  groups: [] as any[],
  members: [] as any[],
  prefs: [] as any[],
  listings: [] as any[],
  extractions: [] as any[],
  runs: [] as any[],
};

let nextId = 1;
const id = () => `id${nextId++}`;

export function resetStore() {
  for (const key of Object.keys(store) as (keyof typeof store)[]) store[key].length = 0;
}

const active = (m: any) => m.left_at === null;

async function addMember(input: any) {
  const duplicate = store.members.find((m) => m.telegram_user_id !== null && m.telegram_user_id === input.telegramUserId && (m.group_id === input.groupId || active(m)));
  if (duplicate) throw new DatabaseError('add you to the group', { message: 'duplicate key value violates unique constraint', code: '23505' });
  const m = { id: id(), group_id: input.groupId, telegram_user_id: input.telegramUserId, telegram_username: input.username, display_name: input.displayName, preferences_complete: false, state: null, left_at: null };
  store.members.push(m);
  return structuredClone(m);
}

async function findMembership(groupId: string, tg: number) {
  return structuredClone(store.members.find((m) => m.group_id === groupId && m.telegram_user_id === tg) ?? null);
}

export const repo = {
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
  getMemberByTelegramId: async (tg: number) => structuredClone(store.members.find((m) => m.telegram_user_id === tg && active(m)) ?? null),
  getMember: async (memberId: string) => store.members.find((m) => m.id === memberId),
  findMembership,
  addMember,
  ensureMembership: async (input: any) => {
    const existing = store.members.find((m) => m.group_id === input.groupId && m.telegram_user_id === input.telegramUserId);
    if (existing) {
      const rejoining = existing.left_at !== null;
      existing.left_at = null;
      existing.telegram_username = input.username;
      if (rejoining) existing.state = null;
      return { member: structuredClone(existing), outcome: rejoining ? 'rejoined' : 'existing' };
    }
    return { member: await addMember(input), outcome: 'created' };
  },
  getMembers: async (groupId: string) => store.members.filter((m) => m.group_id === groupId && active(m)),
  setMemberState: async (memberId: string, state: unknown) => void (store.members.find((m) => m.id === memberId).state = structuredClone(state)),
  setPreferencesComplete: async (memberId: string, v: boolean) => void (store.members.find((m) => m.id === memberId).preferences_complete = v),
  markMemberLeft: async (memberId: string) => void Object.assign(store.members.find((m) => m.id === memberId), { left_at: new Date().toISOString(), state: null }),
  setTelegramUsername: async (memberId: string, username: string | null) => void (store.members.find((m) => m.id === memberId).telegram_username = username),
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
  getListings: async (groupId: string) =>
    store.listings.filter((l) => l.group_id === groupId && store.members.some((m) => m.id === l.submitted_by && active(m))),
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
};
