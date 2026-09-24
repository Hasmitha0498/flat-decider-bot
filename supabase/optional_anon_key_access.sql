-- OPTIONAL. Run this only if you want the bot to use SUPABASE_ANON_KEY
-- instead of SUPABASE_SERVICE_ROLE_KEY.
--
-- It lets the anon role read/write the bot's tables. That is acceptable only because
-- this app has no frontend: the anon key lives in server environment variables and
-- is never shipped to a browser. Do not publish the anon key anywhere if you run this.

do $$
declare t text;
begin
  foreach t in array array['groups','members','preferences','listings','listing_extractions','comparison_runs']
  loop
    execute format('drop policy if exists server_anon_access on %I', t);
    execute format('create policy server_anon_access on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;
