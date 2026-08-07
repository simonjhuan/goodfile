-- ============================================================================
-- GoodFile — Cloud Share setup
-- Run ONCE in Supabase Dashboard → SQL Editor.
-- Before running, edit the two placeholders in step 4 (proj_url, service_key).
-- ============================================================================

-- 1) Storage bucket: public reads, 50 MB per-file limit ----------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('shared', 'shared', true, 52428800)   -- 52428800 = 50 MB
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- 2) RLS: allow anonymous uploads + public reads on the 'shared' bucket only --
--    (storage.objects already has RLS enabled by Supabase)
drop policy if exists "goodfile anon upload" on storage.objects;
create policy "goodfile anon upload"
  on storage.objects for insert to anon
  with check (bucket_id = 'shared');

drop policy if exists "goodfile public read" on storage.objects;
create policy "goodfile public read"
  on storage.objects for select to anon
  using (bucket_id = 'shared');

-- 3) Extensions for the scheduled cleanup ------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 4) Cleanup function: delete files older than 20 minutes from 'shared' -------
--    Deletes the physical files (frees space) via the Storage REST API.
--    >>> EDIT the two lines marked below before running. <<<
create or replace function public.goodfile_cleanup_expired()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  proj_url    text := 'https://YOUR_PROJECT_REF.supabase.co';  -- <-- your Project URL
  service_key text := 'YOUR_SERVICE_ROLE_KEY';                 -- <-- service_role key (Settings → API)
  r       record;
  removed integer := 0;
begin
  for r in
    select name
    from storage.objects
    where bucket_id = 'shared'
      and created_at < now() - interval '20 minutes'
  loop
    perform net.http_delete(
      url     := proj_url || '/storage/v1/object/shared/' || r.name,
      headers := jsonb_build_object(
        'authorization', 'Bearer ' || service_key,
        'apikey', service_key
      )
    );
    removed := removed + 1;
  end loop;
  return removed;
end;
$$;

-- 5) Schedule it. Runs every 5 minutes (files live 20–25 min worst case). -----
--    Use '* * * * *' to run every minute for tighter expiry.
do $$
begin
  perform cron.unschedule('goodfile-cleanup');
exception when others then
  null;  -- not scheduled yet
end $$;

select cron.schedule(
  'goodfile-cleanup',
  '*/5 * * * *',
  $$ select public.goodfile_cleanup_expired(); $$
);

-- ----------------------------------------------------------------------------
-- Handy checks:
--   select * from cron.job;                       -- confirm the schedule exists
--   select public.goodfile_cleanup_expired();     -- run cleanup manually now
--   select * from storage.objects where bucket_id='shared' order by created_at desc;
--   select * from net._http_response order by created desc limit 10;  -- delete responses
-- ----------------------------------------------------------------------------
