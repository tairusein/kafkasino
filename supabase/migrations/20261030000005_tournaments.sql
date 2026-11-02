-- =============================================================================
-- Kafkasino :: Step 1 / Migration 5 — tournaments & the editable homepage banner
-- =============================================================================
-- The homepage hero banner IS the single `is_featured` tournament:
--   date -> starts_at, prize name -> prize_name, prize image -> prize_image_path.
-- Only the Admin can create/edit tournaments (RLS + is_admin()).

create table public.tournaments (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 120),
  description      text not null default '',
  game_type        text references public.game_catalog(slug),
  prize_name       text not null check (char_length(prize_name) between 1 and 120),
  prize_image_path text,                       -- object path in public bucket 'tournament-images'
  starts_at        timestamptz not null,
  entry_fee        bigint not null default 0 check (entry_fee >= 0),
  max_participants int check (max_participants is null or max_participants > 0),
  status           text not null default 'draft'
                     check (status in ('draft', 'upcoming', 'live', 'finished', 'cancelled')),
  is_featured      boolean not null default false,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tournaments_featured_not_draft check (not is_featured or status <> 'draft')
);
-- At most one banner tournament at any time.
create unique index tournaments_single_featured on public.tournaments (is_featured) where is_featured;

create trigger tournaments_set_updated_at
  before update on public.tournaments
  for each row execute function public.set_updated_at();

create table public.tournament_participants (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  fee_paid      bigint not null default 0 check (fee_paid >= 0),
  registered_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);
create index tournament_participants_user_idx on public.tournament_participants (user_id);

alter table public.tournaments             enable row level security;
alter table public.tournament_participants enable row level security;

-- Public pages: drafts are visible to the admin only.
create policy tournaments_read on public.tournaments
  for select to anon, authenticated
  using (status <> 'draft' or public.is_admin());

create policy tournaments_admin_insert on public.tournaments
  for insert to authenticated with check (public.is_admin());
create policy tournaments_admin_update on public.tournaments
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy tournaments_admin_delete on public.tournaments
  for delete to authenticated using (public.is_admin());

-- Participant list is visible to signed-in users; writes only via RPCs below.
create policy tournament_participants_read on public.tournament_participants
  for select to authenticated
  using (true);

-- Atomically move the banner to another tournament (admin only).
create or replace function public.admin_set_featured_tournament(p_tournament_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tournaments where id = p_tournament_id and status <> 'draft') then
    raise exception 'tournament_not_found_or_draft';
  end if;
  update public.tournaments set is_featured = false where is_featured and id <> p_tournament_id;
  update public.tournaments set is_featured = true  where id = p_tournament_id;
end;
$$;

create or replace function public.register_for_tournament(p_tournament_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_uid();
  v_t       public.tournaments;
  v_count   int;
  v_balance bigint;
begin
  -- Lock order everywhere: tournament row, then wallet row.
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if not found or v_t.status = 'draft' then raise exception 'tournament_not_found'; end if;
  if v_t.status <> 'upcoming' or v_t.starts_at <= now() then
    raise exception 'registration_closed';
  end if;
  if exists (select 1 from public.tournament_participants
              where tournament_id = p_tournament_id and user_id = v_uid) then
    raise exception 'already_registered';
  end if;

  select count(*) into v_count from public.tournament_participants where tournament_id = p_tournament_id;
  if v_t.max_participants is not null and v_count >= v_t.max_participants then
    raise exception 'tournament_full';
  end if;

  if v_t.entry_fee > 0 then
    v_balance := public.apply_balance_delta(
      v_uid, -v_t.entry_fee, 'tournament_entry', 'tournament', v_t.id::text
    );
  else
    select balance into v_balance from public.wallets where user_id = v_uid;
  end if;

  insert into public.tournament_participants (tournament_id, user_id, fee_paid)
  values (p_tournament_id, v_uid, v_t.entry_fee);

  return jsonb_build_object('tournament_id', v_t.id, 'balance', v_balance, 'participants', v_count + 1);
end;
$$;

create or replace function public.unregister_from_tournament(p_tournament_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_uid();
  v_t       public.tournaments;
  v_fee     bigint;
  v_balance bigint;
begin
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if not found or v_t.status = 'draft' then raise exception 'tournament_not_found'; end if;
  if v_t.status <> 'upcoming' or v_t.starts_at <= now() then
    raise exception 'registration_closed';
  end if;

  delete from public.tournament_participants
   where tournament_id = p_tournament_id and user_id = v_uid
  returning fee_paid into v_fee;
  if not found then raise exception 'not_registered'; end if;

  if v_fee > 0 then
    v_balance := public.apply_balance_delta(
      v_uid, v_fee, 'tournament_refund', 'tournament', v_t.id::text
    );
  else
    select balance into v_balance from public.wallets where user_id = v_uid;
  end if;
  return jsonb_build_object('tournament_id', v_t.id, 'balance', v_balance);
end;
$$;

