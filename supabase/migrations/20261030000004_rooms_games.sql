-- =============================================================================
-- Kafkasino :: Step 1 / Migration 4 — game catalogue, rooms (public/PIN), seats,
--                                      authoritative game state, chat, AFK primitives
-- =============================================================================
-- Sync model (zero-desync):
--   * game_states is the single source of truth, written ONLY by the server
--     (service_role Edge Functions). `version` increases by exactly 1 per write
--     (enforced by trigger), so clients detect gaps and re-fetch instead of guessing.
--   * Hidden information (hole cards, dealer hole card…) lives in game_private_states,
--     readable only by its owner. NEVER put hidden data into game_states.state.
-- =============================================================================

create table public.game_catalog (
  slug        text primary key,
  name        text not null,
  min_players int  not null check (min_players >= 1),
  max_players int  not null check (max_players >= min_players and max_players <= 9),
  is_enabled  boolean not null default false
);
alter table public.game_catalog enable row level security;
create policy game_catalog_read on public.game_catalog
  for select to anon, authenticated using (true);

insert into public.game_catalog (slug, name, min_players, max_players, is_enabled) values
  ('blackjack', 'Blackjack',          1, 6, true),    -- Step 7 (proof of concept)
  ('roulette',  'Roulette',           1, 8, false),   -- Step 8
  ('slots',     'Slots',              1, 1, false),   -- Step 8
  ('poker',     'Texas Hold''em',     2, 9, false),   -- Step 9
  ('durak',     'Durak',              2, 6, false),
  ('chess',     'Chess',              2, 2, false),
  ('checkers',  'Checkers',           2, 2, false);

-- ---------- rooms --------------------------------------------------------------
create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  game_type   text not null references public.game_catalog(slug),
  name        text not null check (char_length(name) between 1 and 40),
  visibility  text not null default 'public' check (visibility in ('public', 'private')),
  host_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'waiting' check (status in ('waiting', 'playing', 'closed')),
  max_players int  not null check (max_players between 1 and 9),
  min_bet     bigint not null default 0 check (min_bet >= 0),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index rooms_lobby_idx on public.rooms (game_type, created_at desc)
  where visibility = 'public' and status <> 'closed';
create trigger rooms_set_updated_at
  before update on public.rooms
  for each row execute function public.set_updated_at();

-- PINs live in their own table so that a SELECT on rooms can never leak them.
-- PIN alphabet: 32 unambiguous chars (no I, O, 0, 1) -> 32^6 ≈ 1.07e9 combinations.
create table public.room_secrets (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  pin     text not null unique check (pin ~ '^[A-HJ-NP-Z2-9]{6}$')
);

-- One table at a time per user (keeps sync, seating and anti-multi-accounting simple).
create table public.room_players (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  seat         smallint not null check (seat >= 0),
  status       text not null default 'active' check (status in ('active', 'afk', 'spectating')),
  stack        bigint not null default 0 check (stack >= 0),   -- reserved for table-stack games (poker)
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  afk_since    timestamptz,
  primary key (room_id, user_id),
  unique (room_id, seat)
);
create unique index room_players_one_room_per_user on public.room_players (user_id);

create table public.pin_attempts (        -- failed PIN guesses, for throttling
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index pin_attempts_user_idx on public.pin_attempts (user_id, attempted_at desc);

-- ---------- authoritative state --------------------------------------------------
create table public.game_states (
  room_id       uuid primary key references public.rooms(id) on delete cascade,
  version       bigint not null default 0,
  phase         text   not null default 'lobby',
  state         jsonb  not null default '{}'::jsonb,       -- PUBLIC information only
  turn_user_id  uuid references auth.users(id) on delete set null,
  turn_deadline timestamptz,                                -- server-set: now() + turn_timeout_seconds
  updated_at    timestamptz not null default now()
);

create or replace function public.enforce_game_state_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version <> old.version + 1 then
    raise exception 'version_conflict: expected %, got %', old.version + 1, new.version
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger game_states_version
  before update on public.game_states
  for each row execute function public.enforce_game_state_version();

create table public.game_private_states (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,            -- hole cards etc.
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- ---------- chat -----------------------------------------------------------------
create table public.chat_messages (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index chat_messages_room_idx on public.chat_messages (room_id, id desc);

-- ---------- RLS helper predicates (SECURITY DEFINER: avoid policy recursion) -----
create or replace function public.is_room_member(p_room uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_players
    where room_id = p_room and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_room_host(p_room uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms where id = p_room and host_id = (select auth.uid())
  );
$$;

create or replace function public.is_public_room(p_room uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms
    where id = p_room and visibility = 'public' and status <> 'closed'
  );
$$;

-- ---------- RLS --------------------------------------------------------------------
alter table public.rooms               enable row level security;
alter table public.room_secrets        enable row level security;
alter table public.room_players        enable row level security;
alter table public.pin_attempts        enable row level security;   -- no policies: server only
alter table public.game_states         enable row level security;
alter table public.game_private_states enable row level security;
alter table public.chat_messages       enable row level security;

-- Lobby: all public rooms; private rooms only for members/host. Never exposes PINs.
create policy rooms_read on public.rooms
  for select to authenticated
  using (visibility = 'public' or host_id = (select auth.uid()) or public.is_room_member(id));

-- Only the host can read their room's PIN (to share it).
create policy room_secrets_read_host on public.room_secrets
  for select to authenticated
  using (public.is_room_host(room_id));

-- Seats: visible for public rooms (lobby counts) and for rooms you sit in.
create policy room_players_read on public.room_players
  for select to authenticated
  using (public.is_room_member(room_id) or public.is_public_room(room_id));

create policy game_states_read on public.game_states
  for select to authenticated
  using (public.is_room_member(room_id));

create policy game_private_read_own on public.game_private_states
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy chat_read on public.chat_messages
  for select to authenticated
  using (public.is_room_member(room_id));

-- ---------- internal: PIN generation ---------------------------------------------
create or replace function public.generate_room_pin()
returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 chars
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_pin   text := '';
  i       int;
begin
  -- bytes 0..5 of a v4 UUID are fully random; 256 % 32 = 0 so no modulo bias.
  for i in 0..5 loop
    v_pin := v_pin || substr(c_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_pin;
end;
$$;

-- ---------- internal: seat a user (shared by join_room / join_room_by_pin) -------
create or replace function public.internal_join_room(p_room_id uuid, p_user uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room   public.rooms;
  v_count  int;
  v_seat   int;
  v_status text;
  v_other  uuid;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' then
    raise exception 'room_not_found';
  end if;

  -- Idempotent re-join of the same room.
  select seat into v_seat from public.room_players where room_id = p_room_id and user_id = p_user;
  if found then
    return jsonb_build_object('room_id', p_room_id, 'seat', v_seat, 'already_seated', true);
  end if;

  select room_id into v_other from public.room_players where user_id = p_user;
  if found then
    raise exception 'already_in_another_room';
  end if;

  select count(*) into v_count from public.room_players where room_id = p_room_id;
  if v_count >= v_room.max_players then
    raise exception 'room_full';
  end if;

  select min(s) into v_seat
    from generate_series(0, v_room.max_players - 1) s
   where not exists (select 1 from public.room_players rp where rp.room_id = p_room_id and rp.seat = s);

  -- Late joiners to a running game watch until the next round.
  v_status := case when v_room.status = 'playing' then 'spectating' else 'active' end;

  insert into public.room_players (room_id, user_id, seat, status)
  values (p_room_id, p_user, v_seat, v_status);

  return jsonb_build_object('room_id', p_room_id, 'seat', v_seat, 'status', v_status, 'already_seated', false);
end;
$$;

-- ---------- RPCs -------------------------------------------------------------------
create or replace function public.create_room(
  p_game_type   text,
  p_name        text,
  p_visibility  text   default 'public',
  p_max_players int    default null,
  p_min_bet     bigint default 0
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.require_uid();
  v_game public.game_catalog;
  v_name text := trim(p_name);
  v_max  int;
  v_room uuid;
  v_pin  text;
  v_try  int := 0;
begin
  select * into v_game from public.game_catalog where slug = p_game_type and is_enabled;
  if not found then raise exception 'game_not_available'; end if;

  if p_visibility not in ('public', 'private') then raise exception 'invalid_visibility'; end if;
  if v_name is null or char_length(v_name) not between 1 and 40 then raise exception 'invalid_name'; end if;
  if coalesce(p_min_bet, 0) < 0 then raise exception 'invalid_min_bet'; end if;

  v_max := coalesce(p_max_players, v_game.max_players);
  if v_max < v_game.min_players or v_max > v_game.max_players then
    raise exception 'invalid_max_players';
  end if;

  if exists (select 1 from public.room_players where user_id = v_uid) then
    raise exception 'already_in_another_room';
  end if;

  insert into public.rooms (game_type, name, visibility, host_id, max_players, min_bet)
  values (p_game_type, v_name, p_visibility, v_uid, v_max, coalesce(p_min_bet, 0))
  returning id into v_room;

  insert into public.game_states (room_id) values (v_room);
  insert into public.room_players (room_id, user_id, seat) values (v_room, v_uid, 0);

  if p_visibility = 'private' then
    loop
      v_pin := public.generate_room_pin();
      begin
        insert into public.room_secrets (room_id, pin) values (v_room, v_pin);
        exit;
      exception when unique_violation then
        v_try := v_try + 1;
        if v_try >= 10 then raise exception 'pin_generation_failed'; end if;
      end;
    end loop;
  end if;

  return jsonb_build_object('room_id', v_room, 'pin', v_pin);
end;
$$;

-- Public rooms only. Private rooms are joinable exclusively through their PIN.
create or replace function public.join_room(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.require_uid();
  v_vis text;
begin
  select visibility into v_vis from public.rooms where id = p_room_id and status <> 'closed';
  if not found then raise exception 'room_not_found'; end if;
  if v_vis <> 'public' and not public.is_room_member(p_room_id) then
    raise exception 'room_not_found';    -- do not reveal that a private room exists
  end if;
  return public.internal_join_room(p_room_id, v_uid);
end;
$$;

-- Returns {ok:false,error:'invalid_pin'} instead of raising so the failed-attempt
-- row survives (a raise would roll it back and defeat the throttle).
create or replace function public.join_room_by_pin(p_pin text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.require_uid();
  v_pin  text := upper(trim(p_pin));
  v_room uuid;
  v_fail int;
begin
  delete from public.pin_attempts where user_id = v_uid and attempted_at < now() - interval '1 hour';

  select count(*) into v_fail
    from public.pin_attempts
   where user_id = v_uid and attempted_at > now() - interval '10 minutes';
  if v_fail >= 10 then
    raise exception 'too_many_attempts';
  end if;

  select rs.room_id into v_room
    from public.room_secrets rs
    join public.rooms r on r.id = rs.room_id
   where rs.pin = v_pin and r.status <> 'closed';

  if not found then
    insert into public.pin_attempts (user_id) values (v_uid);
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  return jsonb_build_object('ok', true) || public.internal_join_room(v_room, v_uid);
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.require_uid();
  v_room public.rooms;
  v_next uuid;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then return; end if;

  delete from public.room_players where room_id = p_room_id and user_id = v_uid;
  if not found then return; end if;

  select user_id into v_next from public.room_players
   where room_id = p_room_id order by seat limit 1;

  if v_next is null then
    update public.rooms set status = 'closed', closed_at = now() where id = p_room_id;
    delete from public.room_secrets where room_id = p_room_id;
  elsif v_room.host_id = v_uid then
    update public.rooms set host_id = v_next where id = p_room_id;
  end if;
  -- NOTE: forfeits / settlement of an in-progress hand are handled by the game
  -- engine (Step 6/7), which observes the room_players DELETE.
end;
$$;

-- A player flagged AFK clicks "I'm back".
create or replace function public.return_from_afk(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.require_uid();
begin
  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid and status = 'afk';
end;
$$;

-- Internal (service_role only): called by the timeout worker after it forced the
-- neutral action. Sets the player's status to AFK.
create or replace function public.force_afk(p_room_id uuid, p_user uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.room_players
     set status = 'afk', afk_since = coalesce(afk_since, now())
   where room_id = p_room_id and user_id = p_user and status = 'active';
$$;

create or replace function public.send_chat_message(p_room_id uuid, p_body text)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.require_uid();
  v_body text := trim(p_body);
  v_id   bigint;
begin
  if not exists (select 1 from public.room_players where room_id = p_room_id and user_id = v_uid) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;
  if v_body is null or char_length(v_body) not between 1 and 300 then
    raise exception 'invalid_message';
  end if;
  if exists (
    select 1 from public.chat_messages
     where user_id = v_uid and created_at > now() - interval '700 milliseconds'
  ) then
    raise exception 'rate_limited';
  end if;
  insert into public.chat_messages (room_id, user_id, body)
  values (p_room_id, v_uid, v_body)
  returning id into v_id;
  return v_id;
end;
$$;

