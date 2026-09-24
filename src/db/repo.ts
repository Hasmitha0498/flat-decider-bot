// Every database read/write the bot does. The database is the source of truth ("memory").
import type { ChatState, CustomAnswers, Group, Listing, ListingFacts, ListingStatus, Member, Preference } from '../types';
import { DatabaseError, db } from './supabase';

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

function check<T>(action: string, result: Result<T>): T {
  if (result.error) throw new DatabaseError(action, result.error);
  return result.data as T;
}

// ---------- groups ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

function randomJoinCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

export async function createGroup(name: string, createdBy: number | null, isDemo = false): Promise<Group> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await db()
      .from('groups')
      .insert({ name, created_by: createdBy, join_code: randomJoinCode(), is_demo: isDemo })
      .select()
      .single();
    if (result.error?.code === '23505') continue; // join code collision - try another
    return check('create a group', result);
  }
  throw new DatabaseError('create a group', { message: 'could not generate a unique join code' });
}

export async function getGroupByCode(code: string): Promise<Group | null> {
  return check('find the group', await db().from('groups').select().eq('join_code', code.toUpperCase()).maybeSingle());
}

export async function getGroup(groupId: string): Promise<Group> {
  return check('load the group', await db().from('groups').select().eq('id', groupId).single());
}

export async function deleteGroup(groupId: string): Promise<void> {
  check('delete the group', await db().from('groups').delete().eq('id', groupId));
}

// ---------- members ----------

export async function getMemberByTelegramId(telegramUserId: number): Promise<Member | null> {
  return check('load your profile', await db().from('members').select().eq('telegram_user_id', telegramUserId).maybeSingle());
}

export async function getMember(memberId: string): Promise<Member> {
  return check('load the member', await db().from('members').select().eq('id', memberId).single());
}

export async function addMember(input: {
  groupId: string;
  telegramUserId: number | null;
  username: string | null;
  displayName: string;
}): Promise<Member> {
  const result = await db()
    .from('members')
    .insert({
      group_id: input.groupId,
      telegram_user_id: input.telegramUserId,
      telegram_username: input.username,
      display_name: input.displayName,
    })
    .select()
    .single();
  return check('add you to the group', result);
}

export async function getMembers(groupId: string): Promise<Member[]> {
  return check('load group members', await db().from('members').select().eq('group_id', groupId).order('created_at'));
}

export async function setMemberState(memberId: string, state: ChatState | null): Promise<void> {
  check('save your progress', await db().from('members').update({ state }).eq('id', memberId));
}

export async function setPreferencesComplete(memberId: string, complete: boolean): Promise<void> {
  check('update your profile', await db().from('members').update({ preferences_complete: complete }).eq('id', memberId));
}

export async function deleteMember(memberId: string): Promise<void> {
  check('remove you from the group', await db().from('members').delete().eq('id', memberId));
}

// ---------- preferences ----------

export async function savePreference(memberId: string, pref: Preference): Promise<void> {
  const result = await db()
    .from('preferences')
    .upsert(
      { member_id: memberId, criterion: pref.criterion, desired_value: pref.desired_value, importance: pref.importance, updated_at: new Date().toISOString() },
      { onConflict: 'member_id,criterion' },
    );
  check('save your answer', result);
}

export async function getPreferences(memberId: string): Promise<Preference[]> {
  return check('load preferences', await db().from('preferences').select('criterion, desired_value, importance').eq('member_id', memberId));
}

export async function getPreferencesForMembers(memberIds: string[]): Promise<Map<string, Preference[]>> {
  const rows: (Preference & { member_id: string })[] = check(
    'load preferences',
    await db().from('preferences').select('member_id, criterion, desired_value, importance').in('member_id', memberIds),
  );
  const byMember = new Map<string, Preference[]>(memberIds.map((id) => [id, []]));
  for (const { member_id, ...pref } of rows) byMember.get(member_id)?.push(pref);
  return byMember;
}

// ---------- listings ----------

export async function findListingByNormalizedUrl(groupId: string, normalizedUrl: string): Promise<Listing | null> {
  return check(
    'check for duplicates',
    await db().from('listings').select().eq('group_id', groupId).eq('normalized_url', normalizedUrl).maybeSingle(),
  );
}

/** Returns null if the same URL already exists in the group (unique constraint). */
export async function addListing(input: { groupId: string; memberId: string; url: string; normalizedUrl: string; manualText?: string }): Promise<Listing | null> {
  const result = await db()
    .from('listings')
    .insert({ group_id: input.groupId, submitted_by: input.memberId, url: input.url, normalized_url: input.normalizedUrl, manual_text: input.manualText ?? null })
    .select()
    .single();
  if (result.error?.code === '23505') return null;
  return check('save the listing', result);
}

export async function getListings(groupId: string): Promise<Listing[]> {
  return check('load listings', await db().from('listings').select().eq('group_id', groupId).order('created_at'));
}

export async function getListing(listingId: string): Promise<Listing | null> {
  return check('load the listing', await db().from('listings').select().eq('id', listingId).maybeSingle());
}

export async function deleteListing(listingId: string, memberId: string): Promise<boolean> {
  const rows: unknown[] = check('remove the listing', await db().from('listings').delete().eq('id', listingId).eq('submitted_by', memberId).select('id'));
  return rows.length > 0;
}

export async function setListingManualText(listingId: string, text: string): Promise<void> {
  check('save the listing details', await db().from('listings').update({ manual_text: text, status: 'pending', status_detail: null }).eq('id', listingId));
}

export async function setListingStatus(listingId: string, status: ListingStatus, detail: string | null): Promise<void> {
  check('update the listing', await db().from('listings').update({ status, status_detail: detail }).eq('id', listingId));
}

// ---------- extractions ----------

export interface StoredExtraction {
  listing_id: string;
  input_hash: string;
  source: 'url' | 'manual';
  facts: ListingFacts;
  custom_checks: CustomAnswers;
}

export async function getExtractions(listingIds: string[]): Promise<Map<string, StoredExtraction>> {
  if (listingIds.length === 0) return new Map();
  const rows: StoredExtraction[] = check(
    'load listing details',
    await db().from('listing_extractions').select('listing_id, input_hash, source, facts, custom_checks').in('listing_id', listingIds),
  );
  return new Map(rows.map((row) => [row.listing_id, row]));
}

export async function saveExtraction(extraction: StoredExtraction & { model: string }): Promise<void> {
  check('save listing details', await db().from('listing_extractions').upsert({ ...extraction, created_at: new Date().toISOString() }));
}

// ---------- comparison runs ----------

export async function saveComparisonRun(groupId: string, memberId: string, results: unknown): Promise<string> {
  const row: { id: string } = check(
    'save the comparison',
    await db().from('comparison_runs').insert({ group_id: groupId, triggered_by: memberId, results }).select('id').single(),
  );
  return row.id;
}

export async function getComparisonRun(runId: string): Promise<{ id: string; group_id: string; results: unknown } | null> {
  return check('load the comparison', await db().from('comparison_runs').select('id, group_id, results').eq('id', runId).maybeSingle());
}

export async function getLatestComparisonRun(groupId: string): Promise<{ id: string; group_id: string; results: unknown } | null> {
  return check(
    'load the comparison',
    await db().from('comparison_runs').select('id, group_id, results').eq('group_id', groupId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  );
}
