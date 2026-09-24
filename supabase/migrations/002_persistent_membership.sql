-- 002: A member's identity is (group_id, telegram_user_id), and leaving no longer deletes data.
--
-- Before: telegram_user_id was unique across ALL groups, and /leave deleted the member row
-- (cascading to their preferences and listings). Rejoining therefore created a brand-new member.
-- After:  leaving sets left_at; rejoining the same house search reactivates the same row.
--
-- Safe to run more than once. Run AFTER 001_init.sql.
-- Pre-check (should return no rows; it cannot, while the old unique constraint exists):
--   select group_id, telegram_user_id, count(*) from members
--   where telegram_user_id is not null group by 1, 2 having count(*) > 1;

-- 1. Leaving is recorded instead of deleting the membership.
alter table members add column if not exists left_at timestamptz;

-- 2. Drop the old "one row per Telegram user, ever" rule (auto-named by 001_init.sql).
alter table members drop constraint if exists members_telegram_user_id_key;

-- 3. One membership row per person per house search. Rejoining reuses it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'members_group_telegram_user_key') then
    alter table members add constraint members_group_telegram_user_key unique (group_id, telegram_user_id);
  end if;
end $$;

-- 4. A person is active in at most one house search at a time (the bot's "current" search).
create unique index if not exists members_one_active_search_per_user
  on members (telegram_user_id)
  where left_at is null and telegram_user_id is not null;
