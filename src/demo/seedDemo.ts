// DEMO ONLY: creates one demo house search with three completed profiles and example flats.
import * as repo from '../db/repo';
import { normalizeUrl } from '../listings/url';
import type { Group } from '../types';
import { DEMO_LISTINGS, DEMO_MEMBERS } from './demoData';

/**
 * @param ownerTelegramId If given, this Telegram user plays the first demo member (Riya),
 *                        so they can run /compare, /details etc. from their own Telegram.
 */
export async function seedDemo(ownerTelegramId: number | null, ownerUsername: string | null = null): Promise<Group> {
  const group = await repo.createGroup('Demo house search (Pune)', ownerTelegramId, true);

  const memberIds: string[] = [];
  for (const [index, demoMember] of DEMO_MEMBERS.entries()) {
    const isOwner = index === 0 && ownerTelegramId !== null;
    const member = await repo.addMember({
      groupId: group.id,
      telegramUserId: isOwner ? ownerTelegramId : null,
      username: isOwner ? ownerUsername : null,
      displayName: demoMember.name,
    });
    for (const pref of demoMember.preferences) await repo.savePreference(member.id, pref);
    await repo.setPreferencesComplete(member.id, true);
    memberIds.push(member.id);
  }

  for (const listing of DEMO_LISTINGS) {
    await repo.addListing({
      groupId: group.id,
      memberId: memberIds[listing.submittedBy],
      url: listing.url,
      normalizedUrl: normalizeUrl(new URL(listing.url)),
      manualText: listing.manualText ?? undefined,
    });
  }
  return group;
}
