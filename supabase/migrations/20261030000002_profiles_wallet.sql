-- =============================================================================
-- Kafkasino :: Step 1 / Migration 2 — profiles, avatars, wallet, ledger,
--                                      signup trigger (10x starting capital), daily bonus
-- =============================================================================

create or replace function public.require_uid()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;

-- ---------- avatar catalogue (10 pre-generated portraits) --------------------
create table public.avatars (
  id           text primary key,
  display_name text not null,
  image_path   text not null,              -- path inside the public 'avatars' storage bucket
  sort_order   int  not null unique
);
alter table public.avatars enable row level security;
-- anon too: the registration form must show avatars before the user is signed in.
create policy avatars_read on public.avatars for select to anon, authenticated using (true);

insert into public.avatars (id, display_name, image_path, sort_order) values
  ('fox',      'The Barrister — Fox',        'avatars/fox.svg',      1),
  ('owl',      'The Professor — Owl',        'avatars/owl.svg',      2),
  ('bear',     'The Executive — Bear',       'avatars/bear.svg',     3),
  ('wolf',     'The Detective — Wolf',       'avatars/wolf.svg',     4),
  ('lion',     'The Chairman — Lion',        'avatars/lion.svg',     5),
  ('raccoon',  'The Accountant — Raccoon',   'avatars/raccoon.svg',  6),
  ('elephant', 'The Diplomat — Elephant',    'avatars/elephant.svg', 7),
  ('penguin',  'The Maître d'' — Penguin',   'avatars/penguin.svg',  8),
  ('eagle',    'The Captain — Eagle',        'avatars/eagle.svg',    9),
  ('panther',  'The Gentleman — Panther',    'avatars/panther.svg', 10)
on conflict (id) do nothing;

-- ---------- profiles (public-facing data + hashed recovery phrase; NO balance) --
create table public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  username             text not null,
  avatar_id            text not null default 'fox' references public.avatars(id),
  equipped_card_back   uuid,                 -- FK to shop_items added in migration 3; NULL = default
  recovery_phrase_hash text,                 -- SHA-256 hex digest of the 12-word recovery phrase
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);
create unique index profiles_username_lower_key on public.profiles (lower(username));

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- Everyone signed in may see usernames/avatars (needed for tables, chat, lobby).
create policy profiles_read on public.profiles for select to authenticated using (true);
-- No write policies / grants: profile edits go through update_profile().

-- ---------- wallets (balance lives here, owner-read-only) --------------------
create table public.wallets (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  balance             bigint not null default 0 check (balance >= 0),
  last_bonus_claim_at timestamptz,
  updated_at          timestamptz not null default now()
);
alter table public.wallets enable row level security;

create policy wallets_read_own on public.wallets
  for select to authenticated
  using (user_id = (select auth.uid()));
-- No insert/update/delete policies, and no write grants (migration 7).

-- ---------- append-only ledger ----------------------------------------------
create table public.wallet_transactions (
  id              bigint generated always as identity primary key,
  user_id         uuid   not null references auth.users(id) on delete cascade,
  amount          bigint not null check (amount <> 0),
  balance_after   bigint not null check (balance_after >= 0),
  kind            text   not null check (kind in (
                    'starting_bonus','daily_bonus','bet','win','refund',
                    'game_bet','game_win','game_refund','purchase',
                    'tournament_entry','tournament_refund','tournament_prize','admin_adjust')),
  reference_type  text,
  reference_id    text,
  idempotency_key text unique,             -- guards against double-spend / replayed requests
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index wallet_transactions_user_idx on public.wallet_transactions (user_id, created_at desc);

create or replace function public.forbid_ledger_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'wallet_transactions is append-only';
end;
$$;
create trigger wallet_transactions_no_update
  before update on public.wallet_transactions
  for each row execute function public.forbid_ledger_update();

alter table public.wallet_transactions enable row level security;
create policy wallet_tx_read_own on public.wallet_transactions
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------- THE ONLY WAY BALANCES CHANGE -------------------------------------
-- Internal primitive. Not executable by anon/authenticated (migration 7); it is
-- called by other SECURITY DEFINER RPCs and by trusted Edge Functions (service_role).
-- * Row-locks the wallet (serialises concurrent mutations -> no lost updates).
-- * Refuses to go below zero.
-- * Idempotent when p_idempotency_key is supplied (returns the original balance_after).
create or replace function public.apply_balance_delta(
  p_user            uuid,
  p_amount          bigint,
  p_kind            text,
  p_reference_type  text  default null,
  p_reference_id    text  default null,
  p_idempotency_key text  default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_new     bigint;
  v_prior   bigint;
  v_kind    text := coalesce(nullif(trim(p_kind), ''), 'bet');
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'amount_must_be_nonzero' using errcode = '22023';
  end if;

  if v_kind not in (
    'starting_bonus','daily_bonus','bet','win','refund',
    'game_bet','game_win','game_refund','purchase',
    'tournament_entry','tournament_refund','tournament_prize','admin_adjust'
  ) then
    v_kind := case when p_amount < 0 then 'bet' else 'win' end;
  end if;

  select balance into v_balance from public.wallets where user_id = p_user for update;
  if not found then
    insert into public.wallets (user_id, balance)
    values (p_user, public.starting_balance())
    on conflict (user_id) do nothing;

    select balance into v_balance from public.wallets where user_id = p_user for update;
    if not found then
      raise exception 'wallet_not_found';
    end if;
  end if;

  if p_idempotency_key is not null then
    select balance_after into v_prior
      from public.wallet_transactions
     where idempotency_key = p_idempotency_key and user_id = p_user;
    if found then
      return v_prior;
    end if;
  end if;

  v_new := v_balance + p_amount;
  if v_new < 0 then
    raise exception 'insufficient_funds';
  end if;

  insert into public.wallet_transactions
    (user_id, amount, balance_after, kind, reference_type, reference_id, idempotency_key, metadata)
  values
    (p_user, p_amount, v_new, v_kind, p_reference_type, p_reference_id, p_idempotency_key,
     coalesce(p_metadata, '{}'::jsonb));

  update public.wallets set balance = v_new, updated_at = now() where user_id = p_user;
  return v_new;
end;
$$;

-- 6-argument overload used by all game engines (Blackjack, Roulette, Slots, Poker, Durak, Chess, Checkers)
create or replace function public.apply_balance_delta(
  p_user            uuid,
  p_amount          bigint,
  p_kind            text,
  p_metadata        jsonb,
  p_room_id         uuid default null,
  p_idempotency_key text default null
)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
begin
  return public.apply_balance_delta(
    p_user,
    p_amount,
    p_kind,
    case when p_room_id is not null then 'room' else 'game' end,
    p_room_id::text,
    p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- 3-argument convenience overload for authenticated callers
create or replace function public.apply_balance_delta(
  p_amount   bigint,
  p_kind     text  default 'bet',
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.require_uid();
begin
  return public.apply_balance_delta(
    v_uid,
    p_amount,
    p_kind,
    'game',
    null,
    null,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- ---------- signup trigger: profile + role + wallet + 10x starting capital ----
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta          jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_username      text  := nullif(trim(v_meta ->> 'username'), '');
  v_email_local   text;
  v_avatar        text  := coalesce(
    nullif(trim(v_meta ->> 'avatar_id'), ''),
    nullif(trim(v_meta ->> 'avatar'), ''),
    'fox'
  );
  v_recovery_hash text  := coalesce(
    nullif(trim(v_meta ->> 'recovery_phrase_hash'), ''),
    nullif(trim(v_meta ->> 'recovery_digest'), '')
  );
  c_multiplier    constant bigint := 10;
  v_daily_bonus   bigint;
  v_start         bigint;
begin
  -- 1. Resolve username from metadata, or derive from synthetic internal email, or fallback to player_<id>
  if v_username is null and new.email is not null then
    v_email_local := split_part(new.email, '@', 1);
    v_email_local := regexp_replace(v_email_local, '^u\.|\.u$', '', 'g');
    v_email_local := regexp_replace(v_email_local, '[^A-Za-z0-9_]', '', 'g');
    if v_email_local ~ '^[A-Za-z0-9_]{3,20}$' then
      v_username := v_email_local;
    end if;
  end if;

  if v_username is null then
    v_username := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  if v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid_username';
  end if;

  -- 2. Validate avatar against public.avatars (Ensure 'fox' exists so FK never fails)
  insert into public.avatars (id, display_name, image_path, sort_order)
  values ('fox', 'The Barrister — Fox', 'avatars/fox.jpg', 1)
  on conflict (id) do nothing;

  if not exists (select 1 from public.avatars where id = v_avatar) then
    raise exception 'invalid_avatar';
  end if;

  -- 3. Insert profile with raw username, avatar_id, and SHA-256 recovery_phrase_hash
  insert into public.profiles (id, username, avatar_id, recovery_phrase_hash)
  values (new.id, v_username, v_avatar, v_recovery_hash)
  on conflict (id) do update
    set username             = excluded.username,
        avatar_id            = excluded.avatar_id,
        recovery_phrase_hash = coalesce(excluded.recovery_phrase_hash, public.profiles.recovery_phrase_hash),
        updated_at           = now();

  -- 4. Provision player role and wallet
  insert into public.user_roles (user_id, role)
  values (new.id, 'player')
  on conflict (user_id, role) do nothing;

  insert into public.wallets (user_id, balance)
  values (new.id, 0)
  on conflict (user_id) do nothing;

  -- 5. Grant 10x starting capital
  v_daily_bonus := coalesce(public.cfg_int('daily_bonus_amount'), 1000);
  if v_daily_bonus <= 0 then
    v_daily_bonus := 1000;
  end if;
  v_start := c_multiplier * v_daily_bonus;

  perform public.apply_balance_delta(
    new.id, v_start, 'starting_bonus', 'user', new.id::text,
    'starting_bonus:' || new.id::text,
    jsonb_build_object('multiplier', c_multiplier, 'daily_bonus', v_daily_bonus)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Registration UX helper (callable by anon). Case-insensitive.
create or replace function public.is_username_available(p_username text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(trim(p_username)));
$$;

-- Controlled profile edit (username / avatar only).
create or replace function public.update_profile(p_username text default null, p_avatar_id text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.require_uid();
  v_name text := nullif(trim(p_username), '');
begin
  if v_name is not null and v_name !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid_username';
  end if;
  if p_avatar_id is not null and not exists (select 1 from public.avatars where id = p_avatar_id) then
    raise exception 'invalid_avatar';
  end if;
  update public.profiles
     set username  = coalesce(v_name, username),
         avatar_id = coalesce(p_avatar_id, avatar_id)
   where id = v_uid;
end;
$$;

-- ---------- daily bonus (reset at 03:00 local, timezone/hour from app_config) --
-- Start of the current bonus "day": the most recent reset instant <= p_now.
create or replace function public.bonus_period_start(p_now timestamptz default now())
returns timestamptz
language sql stable
set search_path = ''
as $$
  select (date_trunc('day', (p_now at time zone c.tz) - make_interval(hours => c.h::int))
          + make_interval(hours => c.h::int)) at time zone c.tz
  from (select public.cfg_text('bonus_timezone') as tz, public.cfg_int('bonus_reset_hour') as h) c;
$$;

-- The next reset instant strictly after p_now.
create or replace function public.bonus_next_reset(p_now timestamptz default now())
returns timestamptz
language sql stable
set search_path = ''
as $$
  select (date_trunc('day', (p_now at time zone c.tz) - make_interval(hours => c.h::int))
          + interval '1 day' + make_interval(hours => c.h::int)) at time zone c.tz
  from (select public.cfg_text('bonus_timezone') as tz, public.cfg_int('bonus_reset_hour') as h) c;
$$;

-- Server-authoritative status: the client renders button vs. countdown from this
-- (uses server_now so a wrong client clock cannot desync the countdown).
create or replace function public.get_bonus_status()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.require_uid();
  v_last timestamptz;
begin
  select last_bonus_claim_at into v_last from public.wallets where user_id = v_uid;
  return jsonb_build_object(
    'can_claim',     v_last is null or v_last < public.bonus_period_start(now()),
    'amount',        public.cfg_int('daily_bonus_amount'),
    'next_reset_at', public.bonus_next_reset(now()),
    'server_now',    now(),
    'last_claim_at', v_last
  );
end;
$$;

create or replace function public.claim_daily_bonus()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_uid();
  v_last    timestamptz;
  v_start   timestamptz := public.bonus_period_start(now());
  v_amount  bigint := public.cfg_int('daily_bonus_amount');
  v_balance bigint;
begin
  -- Lock first: concurrent double-clicks serialise here.
  select last_bonus_claim_at into v_last from public.wallets where user_id = v_uid for update;
  if not found then
    raise exception 'wallet_not_found';
  end if;
  if v_last is not null and v_last >= v_start then
    raise exception 'bonus_already_claimed';
  end if;

  v_balance := public.apply_balance_delta(
    v_uid, v_amount, 'daily_bonus', 'bonus_period', v_start::text,
    'daily_bonus:' || v_uid::text || ':' || v_start::text
  );
  update public.wallets set last_bonus_claim_at = now() where user_id = v_uid;

  return jsonb_build_object(
    'amount',        v_amount,
    'balance',       v_balance,
    'next_reset_at', public.bonus_next_reset(now()),
    'server_now',    now()
  );
end;
$$;

-- Admin-only manual correction (always ledgered, reason mandatory).
create or replace function public.admin_adjust_balance(p_user uuid, p_amount bigint, p_reason text)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'reason_required';
  end if;
  return public.apply_balance_delta(
    p_user, p_amount, 'admin_adjust', 'admin', (select auth.uid())::text, null,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;
