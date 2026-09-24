// Runs the real SQL migrations in an embedded Postgres (PGlite) and checks the membership rules at database level.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeAll, describe, expect, it } from 'vitest';

const sql = (file: string) => readFileSync(join(__dirname, '..', 'supabase', 'migrations', file), 'utf8');

let db: PGlite;
let groupA: string;
let groupB: string;

async function addMember(groupId: string, telegramUserId: number | null, name = 'Member') {
  const result = await db.query<{ id: string }>(
    'insert into members (group_id, telegram_user_id, display_name) values ($1, $2, $3) returning id',
    [groupId, telegramUserId, name],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(sql('001_init.sql'));

  // Data created before the fix must survive the migration.
  const groups = await db.query<{ id: string }>("insert into groups (name, join_code, created_by) values ('A', 'AAAAAA', 123), ('B', 'BBBBBB', 999) returning id");
  [groupA, groupB] = groups.rows.map((r) => r.id);
  const existing = await addMember(groupA, 123, 'Hasmitha');
  await db.query("insert into preferences (member_id, criterion, desired_value, importance) values ($1, 'lift', 'true', 'must_have')", [existing]);

  await db.exec(sql('002_persistent_membership.sql'));
}, 30_000);

describe('database membership rules (migration 002)', () => {
  it('keeps existing members and preferences, with left_at empty', async () => {
    const members = await db.query<{ display_name: string; left_at: string | null }>('select display_name, left_at from members');
    expect(members.rows).toEqual([{ display_name: 'Hasmitha', left_at: null }]);
    expect((await db.query('select * from preferences')).rows).toHaveLength(1);
  });

  it('Test 7: rejects a second member with the same group_id + telegram_user_id', async () => {
    await expect(addMember(groupA, 123)).rejects.toThrow(/members_group_telegram_user_key|duplicate key/);
    const count = await db.query<{ n: number }>('select count(*)::int as n from members where group_id = $1 and telegram_user_id = 123', [groupA]);
    expect(count.rows[0].n).toBe(1);
  });

  it('allows only one ACTIVE house search per Telegram user', async () => {
    await expect(addMember(groupB, 123)).rejects.toThrow(/members_one_active_search_per_user|duplicate key/);
  });

  it('lets a user who left one search join another, and rejoin the first by reactivating the same row', async () => {
    await db.query('update members set left_at = now() where group_id = $1 and telegram_user_id = 123', [groupA]);
    const inB = await addMember(groupB, 123);
    expect(inB).toBeTruthy();

    // Reactivating A while active in B is blocked; after leaving B it works on the SAME row.
    await expect(db.query('update members set left_at = null where group_id = $1 and telegram_user_id = 123', [groupA])).rejects.toThrow(/duplicate key/);
    await db.query('update members set left_at = now() where id = $1', [inB]);
    await db.query('update members set left_at = null where group_id = $1 and telegram_user_id = 123', [groupA]);
    const rows = await db.query('select id from members where group_id = $1 and telegram_user_id = 123', [groupA]);
    expect(rows.rows).toHaveLength(1);
    expect((await db.query("select * from preferences where criterion = 'lift'")).rows).toHaveLength(1);
  });

  it('still allows several demo placeholder members without a Telegram account', async () => {
    await addMember(groupA, null, 'Meera');
    await addMember(groupA, null, 'Kavita');
    const placeholders = await db.query<{ n: number }>('select count(*)::int as n from members where telegram_user_id is null');
    expect(placeholders.rows[0].n).toBe(2);
  });

  it('is safe to run twice', async () => {
    await expect(db.exec(sql('002_persistent_membership.sql'))).resolves.toBeDefined();
  });
});
