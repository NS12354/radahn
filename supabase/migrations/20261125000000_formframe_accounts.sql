-- Formframe accounts: each signed-in user's projects and scenes.
--
-- The studio keeps working copies in the browser (IndexedDB) and mirrors them
-- here when you're signed in, so they're backed up and follow you to any computer.
-- Row-level security: a user can only see and change their own rows.

create table if not exists public.documents (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('project', 'scene')),
  id         text        not null check (char_length(id) between 1 and 64),
  name       text        not null default '' check (char_length(name) <= 300),
  board      text        not null default '',
  thumb      text,                                   -- small JPEG data URL for the home screen
  body       text        not null default '',        -- the project / scene JSON
  created    bigint      not null,                   -- ms since epoch (same clock as the browser copy)
  updated    bigint      not null,                   -- ms since epoch: last edit
  deleted    boolean     not null default false,     -- kept briefly so other computers drop their copy too
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id),
  constraint body_size check (octet_length(body) <= 50 * 1024 * 1024),
  constraint thumb_size check (thumb is null or octet_length(thumb) <= 512 * 1024)
);

comment on table public.documents is 'Formframe projects and scenes, one row per item per user. body is the full JSON; the list view reads only the small columns.';

create index if not exists documents_user_updated on public.documents (user_id, updated desc);

alter table public.documents enable row level security;

create policy "read own documents"   on public.documents for select to authenticated using ((select auth.uid()) = user_id);
create policy "add own documents"    on public.documents for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "change own documents" on public.documents for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "remove own documents" on public.documents for delete to authenticated using ((select auth.uid()) = user_id);

-- keep updated_at honest on every write
create or replace function public.documents_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents
  for each row execute function public.documents_touch();

-- the anonymous role never touches this table
revoke all on public.documents from anon;
grant select, insert, update, delete on public.documents to authenticated;
