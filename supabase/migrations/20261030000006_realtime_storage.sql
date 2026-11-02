-- =============================================================================
-- Kafkasino :: Step 1 / Migration 6 — Realtime authorization, publication, Storage
-- =============================================================================

-- ---------- Realtime Broadcast/Presence authorization ----------------------------
-- Clients MUST open channels with `config: { private: true }`. Topics:
--   presence:global      -> site-wide online status (Presence only)
--   room:<room uuid>     -> room chat/emotes (Broadcast) + room presence; members only
-- postgres_changes subscriptions are authorised by the table RLS policies instead.
create or replace function public.can_use_realtime_topic(p_topic text, p_extension text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_topic = 'presence:global'
      then p_extension = 'presence'
    when p_topic ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then p_extension in ('broadcast', 'presence')
           and public.is_room_member(substr(p_topic, 6)::uuid)
    else false
  end;
$$;

create policy kafkasino_realtime_receive on realtime.messages
  for select to authenticated
  using (public.can_use_realtime_topic((select realtime.topic()), extension));

create policy kafkasino_realtime_send on realtime.messages
  for insert to authenticated
  with check (public.can_use_realtime_topic((select realtime.topic()), extension));

-- ---------- Realtime publication (postgres_changes; RLS-filtered per subscriber) --
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.wallets,          -- live balance (owner-only via RLS)
      public.rooms,
      public.room_players,
      public.game_states,
      public.game_private_states,
      public.chat_messages,
      public.tournaments;
  end if;
end $$;

-- Full row for UPDATE/DELETE payloads so clients can reconcile without extra fetches.
alter table public.room_players replica identity full;
alter table public.rooms        replica identity full;

-- ---------- Storage buckets -------------------------------------------------------
-- Public-read assets. Uploads are admin-only (tournament images) or service-role only.
-- SVG is deliberately NOT allowed for user-uploaded content (script injection risk).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars',           'avatars',           true, 1048576, null),
  ('shop-assets',       'shop-assets',       true, 2097152, null),
  ('tournament-images', 'tournament-images', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy kafkasino_assets_read on storage.objects
  for select to anon, authenticated
  using (bucket_id in ('avatars', 'shop-assets', 'tournament-images'));

create policy kafkasino_tournament_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tournament-images' and public.is_admin());

create policy kafkasino_tournament_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'tournament-images' and public.is_admin())
  with check (bucket_id = 'tournament-images' and public.is_admin());

create policy kafkasino_tournament_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tournament-images' and public.is_admin());

