-- =============================================================================
-- FILE: 20261030000001_core.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 1 â€” core: config, RBAC, shared helpers
-- =============================================================================
-- Conventions used in every migration:
--   * Every SECURITY DEFINER function pins `search_path = ''` and fully qualifies
--     every object (prevents search_path hijacking).
--   * Table/function privileges are locked down centrally in migration 7.
--   * Clients get SELECT only (RLS-filtered). ALL writes go through RPCs.
-- =============================================================================

-- ---------- generic helpers --------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- app_config -------------------------------------------------------
-- Non-secret, globally readable tunables. Writes ONLY via admin_set_config().
create table public.app_config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);
alter table public.app_config enable row level security;

create policy app_config_read on public.app_config
  for select to anon, authenticated
  using (true);

insert into public.app_config (key, value, description) values
  ('daily_bonus_amount',   '1000'::jsonb,
     'Chips granted by the daily bonus. Starting balance is ALWAYS exactly 10x this value.'),
  ('bonus_reset_hour',     '3'::jsonb,
     'Local hour (0-23) at which the daily bonus resets.'),
  ('bonus_timezone',       '"Europe/Berlin"'::jsonb,
     'IANA timezone used for the daily bonus reset.'),
  ('turn_timeout_seconds', '15'::jsonb,
     'Seconds a player has to act before the server forces a neutral action and marks them AFK.');

create or replace function public.cfg_int(p_key text)
returns bigint
language sql stable
set search_path = ''
as $$
  select (value #>> '{}')::bigint from public.app_config where key = p_key;
$$;

create or replace function public.cfg_text(p_key text)
returns text
language sql stable
set search_path = ''
as $$
  select value #>> '{}' from public.app_config where key = p_key;
$$;

-- ---------- RBAC -------------------------------------------------------------
create type public.app_role as enum ('admin', 'player');

create table public.user_roles (
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.app_role not null default 'player',
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Exactly ONE primary admin may exist, enforced by the database itself.
create unique index user_roles_single_admin
  on public.user_roles (role)
  where role = 'admin';

alter table public.user_roles enable row level security;

-- A user can read only their own roles (so the UI can show/hide admin links).
-- There are NO insert/update/delete policies and no write grants: roles can only
-- be changed by the service role / SQL (see bootstrap_admin below).
create policy user_roles_read_own on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- SECURITY DEFINER so it can be used inside RLS policies of other tables
-- without recursing into user_roles' own RLS.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'admin'
  );
$$;

-- One-time bootstrap of the primary admin. Run manually (SQL editor / service role):
--   select public.bootstrap_admin('you@example.com');
-- Not callable by anon/authenticated (see migration 7).
create or replace function public.bootstrap_admin(p_email text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'user_not_found';
  end if;
  if exists (select 1 from public.user_roles where role = 'admin') then
    raise exception 'admin_already_exists';
  end if;
  insert into public.user_roles (user_id, role) values (v_user, 'admin');
  return v_user;
end;
$$;

-- Admin-only, validated config writer.
create or replace function public.admin_set_config(p_key text, p_value jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_int bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_config where key = p_key) then
    raise exception 'unknown_config_key';
  end if;

  case p_key
    when 'daily_bonus_amount' then
      v_int := (p_value #>> '{}')::bigint;
      if v_int < 1 or v_int > 1000000000 then raise exception 'invalid_value'; end if;
    when 'bonus_reset_hour' then
      v_int := (p_value #>> '{}')::bigint;
      if v_int < 0 or v_int > 23 then raise exception 'invalid_value'; end if;
    when 'bonus_timezone' then
      if jsonb_typeof(p_value) <> 'string'
         or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_value #>> '{}') then
        raise exception 'invalid_value';
      end if;
    when 'turn_timeout_seconds' then
      v_int := (p_value #>> '{}')::bigint;
      if v_int < 5 or v_int > 120 then raise exception 'invalid_value'; end if;
    else
      raise exception 'unknown_config_key';
  end case;

  update public.app_config
     set value = p_value, updated_at = now(), updated_by = (select auth.uid())
   where key = p_key;
end;
$$;



-- =============================================================================
-- FILE: 20261030000002_profiles_wallet.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 2 â€” profiles, avatars, wallet, ledger,
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
  ('fox',      'The Barrister â€” Fox',        'avatars/fox.svg',      1),
  ('owl',      'The Professor â€” Owl',        'avatars/owl.svg',      2),
  ('bear',     'The Executive â€” Bear',       'avatars/bear.svg',     3),
  ('wolf',     'The Detective â€” Wolf',       'avatars/wolf.svg',     4),
  ('lion',     'The Chairman â€” Lion',        'avatars/lion.svg',     5),
  ('raccoon',  'The Accountant â€” Raccoon',   'avatars/raccoon.svg',  6),
  ('elephant', 'The Diplomat â€” Elephant',    'avatars/elephant.svg', 7),
  ('penguin',  'The MaÃ®tre d'' â€” Penguin',   'avatars/penguin.svg',  8),
  ('eagle',    'The Captain â€” Eagle',        'avatars/eagle.svg',    9),
  ('panther',  'The Gentleman â€” Panther',    'avatars/panther.svg', 10)
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
  values ('fox', 'The Barrister â€” Fox', 'avatars/fox.jpg', 1)
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


-- =============================================================================
-- FILE: 20261030000003_shop.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 3 â€” shop (card backs, premium interactive emotes)
-- =============================================================================

create table public.shop_items (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  kind           text not null check (kind in ('card_back', 'emote')),
  name           text not null,
  description    text not null default '',
  price          bigint not null check (price >= 0),
  -- Asset reference, e.g. {"svg":"shop-assets/card-backs/gold-crest.svg"} or {"animation":"slap"}
  asset          jsonb not null default '{}'::jsonb,
  is_interactive boolean not null default false,   -- targets another player's avatar
  is_consumable  boolean not null default false,   -- each purchase grants N uses
  grant_quantity int not null default 1 check (grant_quantity > 0),
  is_active      boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint shop_card_back_rules check (kind <> 'card_back' or (not is_consumable and not is_interactive)),
  constraint shop_interactive_is_emote check (not is_interactive or kind = 'emote')
);
create trigger shop_items_set_updated_at
  before update on public.shop_items
  for each row execute function public.set_updated_at();

alter table public.shop_items enable row level security;
create policy shop_items_read on public.shop_items
  for select to authenticated
  using (is_active or public.is_admin());
create policy shop_items_admin_insert on public.shop_items
  for insert to authenticated with check (public.is_admin());
create policy shop_items_admin_update on public.shop_items
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy shop_items_admin_delete on public.shop_items
  for delete to authenticated using (public.is_admin());

-- Inventory: owner-read-only. Only purchase_item() / consume_emote_charge() write.
create table public.user_items (
  user_id     uuid not null references auth.users(id) on delete cascade,
  item_id     uuid not null references public.shop_items(id) on delete cascade,
  quantity    int  not null default 1 check (quantity >= 0),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.user_items enable row level security;
create policy user_items_read_own on public.user_items
  for select to authenticated
  using (user_id = (select auth.uid()));

alter table public.profiles
  add constraint profiles_equipped_card_back_fkey
  foreign key (equipped_card_back) references public.shop_items(id) on delete set null;

-- ---------- seed catalogue (prices are relative to the 1000-chip daily bonus) ---
insert into public.shop_items (slug, kind, name, description, price, asset, is_interactive, is_consumable, grant_quantity, sort_order) values
  ('cb-burgundy-classic', 'card_back', 'Burgundy Classic',   'Deep burgundy field with a fine gold border.',       2000,
     '{"svg":"shop-assets/card-backs/burgundy-classic.svg"}', false, false, 1, 10),
  ('cb-graphite-guilloche','card_back','Graphite GuillochÃ©', 'Engraved guillochÃ© pattern on graphite.',            4000,
     '{"svg":"shop-assets/card-backs/graphite-guilloche.svg"}', false, false, 1, 20),
  ('cb-gold-crest',       'card_back', 'Gold Crest',         'Embossed gold crest on burgundy.',                  10000,
     '{"svg":"shop-assets/card-backs/gold-crest.svg"}', false, false, 1, 30),
  ('cb-midnight-lattice', 'card_back', 'Midnight Lattice',   'Fine gold lattice over midnight graphite.',          6000,
     '{"svg":"shop-assets/card-backs/midnight-lattice.svg"}', false, false, 1, 40),
  ('cb-royal-monogram',   'card_back', 'Royal Monogram',     'Hand-set K monogram in polished gold.',             20000,
     '{"svg":"shop-assets/card-backs/royal-monogram.svg"}', false, false, 1, 50),

  ('em-slap',   'emote', 'The Slap',        'Your avatar delivers a crisp slap to an opponent.',      300, '{"animation":"slap"}',   true,  true, 5, 100),
  ('em-punch',  'emote', 'The Punch',       'A swift punch lands on your chosen opponent.',           400, '{"animation":"punch"}',  true,  true, 5, 110),
  ('em-poop',   'emote', 'Special Delivery','Hurl a certain brown item at an opponent.',              500, '{"animation":"poop"}',   true,  true, 5, 120),
  ('em-tomato', 'emote', 'Rotten Tomato',   'Splat! A tomato finds its target.',                      300, '{"animation":"tomato"}', true,  true, 5, 130),
  ('em-toast',  'emote', 'Champagne Toast', 'Raise a glass to a worthy opponent.',                    200, '{"animation":"toast"}',  true,  true, 5, 140);

-- ---------- purchase -----------------------------------------------------------
-- Atomic: debit + inventory grant in one transaction. Server computes the price;
-- the client never supplies it. p_idempotency_key makes double-clicks harmless.
create or replace function public.purchase_item(
  p_item_id         uuid,
  p_quantity        int  default 1,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_uid();
  v_item    public.shop_items;
  v_qty     int  := coalesce(p_quantity, 1);
  v_total   bigint;
  v_units   int;
  v_key     text;
  v_balance bigint;
  v_owned   int;
begin
  -- Serialise this user's money operations first.
  perform 1 from public.wallets where user_id = v_uid for update;
  if not found then raise exception 'wallet_not_found'; end if;

  select * into v_item from public.shop_items where id = p_item_id and is_active;
  if not found then raise exception 'item_not_found'; end if;

  -- Replay check comes first: a retried request must report the original outcome,
  -- not trip the "already owned" rule it caused itself.
  if p_idempotency_key is not null then
    v_key := 'purchase:' || v_uid::text || ':' || p_idempotency_key;
    if exists (select 1 from public.wallet_transactions where idempotency_key = v_key) then
      select balance into v_balance from public.wallets where user_id = v_uid;
      select quantity into v_owned from public.user_items
        where user_id = v_uid and item_id = v_item.id;
      return jsonb_build_object('balance', v_balance, 'item_id', v_item.id,
                                'quantity', coalesce(v_owned, 0), 'replayed', true);
    end if;
  end if;

  if v_item.is_consumable then
    if v_qty < 1 or v_qty > 100 then raise exception 'invalid_quantity'; end if;
  else
    v_qty := 1;
    if exists (select 1 from public.user_items where user_id = v_uid and item_id = v_item.id) then
      raise exception 'already_owned';
    end if;
  end if;

  v_total := v_item.price * v_qty;
  v_units := v_item.grant_quantity * v_qty;

  if v_total > 0 then
    v_balance := public.apply_balance_delta(
      v_uid, -v_total, 'purchase', 'shop_item', v_item.id::text, v_key,
      jsonb_build_object('slug', v_item.slug, 'quantity', v_qty, 'units', v_units)
    );
  else
    select balance into v_balance from public.wallets where user_id = v_uid;
  end if;

  insert into public.user_items (user_id, item_id, quantity)
  values (v_uid, v_item.id, v_units)
  on conflict (user_id, item_id)
  do update set quantity = public.user_items.quantity + excluded.quantity
  returning quantity into v_owned;

  return jsonb_build_object('balance', v_balance, 'item_id', v_item.id,
                            'quantity', v_owned, 'replayed', false);
end;
$$;

-- Equip an owned card back (NULL = restore the default).
create or replace function public.equip_card_back(p_item_id uuid default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if p_item_id is not null then
    if not exists (
      select 1
        from public.user_items ui
        join public.shop_items si on si.id = ui.item_id
       where ui.user_id = v_uid and ui.item_id = p_item_id and si.kind = 'card_back'
    ) then
      raise exception 'item_not_owned';
    end if;
  end if;
  update public.profiles set equipped_card_back = p_item_id where id = v_uid;
end;
$$;

-- Internal (service_role / other definer RPCs only): spend one emote charge.
-- Used by the realtime game layer (Step 6) when an interactive emote is sent.
create or replace function public.consume_emote_charge(p_user uuid, p_item_id uuid)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_left int;
begin
  update public.user_items ui
     set quantity = ui.quantity - 1
    from public.shop_items si
   where ui.user_id = p_user and ui.item_id = p_item_id
     and si.id = ui.item_id and si.kind = 'emote'
     and ui.quantity > 0
  returning ui.quantity into v_left;
  if not found then
    raise exception 'no_charges_left';
  end if;
  return v_left;
end;
$$;


-- =============================================================================
-- FILE: 20261030000004_rooms_games.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 4 â€” game catalogue, rooms (public/PIN), seats,
--                                      authoritative game state, chat, AFK primitives
-- =============================================================================
-- Sync model (zero-desync):
--   * game_states is the single source of truth, written ONLY by the server
--     (service_role Edge Functions). `version` increases by exactly 1 per write
--     (enforced by trigger), so clients detect gaps and re-fetch instead of guessing.
--   * Hidden information (hole cards, dealer hole cardâ€¦) lives in game_private_states,
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
-- PIN alphabet: 32 unambiguous chars (no I, O, 0, 1) -> 32^6 â‰ˆ 1.07e9 combinations.
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



-- =============================================================================
-- FILE: 20261030000005_tournaments.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 5 â€” tournaments & the editable homepage banner
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



-- =============================================================================
-- FILE: 20261030000006_realtime_storage.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 6 â€” Realtime authorization, publication, Storage
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



-- =============================================================================
-- FILE: 20261030000007_lockdown_grants.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 1 / Migration 7 â€” privilege lockdown (deny-by-default)
-- =============================================================================
-- Supabase auto-grants broad privileges on new public objects to anon/authenticated.
-- We strip ALL of them, then re-grant the minimum. RLS stays the second line of defence.
-- service_role, postgres, and supabase_auth_admin (used by GoTrue triggers on auth.users)
-- retain full backend execution/table privileges.
--
-- !! Every future migration that adds a table or function MUST add its own grants.
--    The default-privilege revokes below make new objects private by default.

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- ---------- Backend & GoTrue Auth Trigger Roles (MUST keep full access) -------------
grant usage on schema public to postgres, anon, authenticated, service_role, supabase_auth_admin;
grant all on all tables    in schema public to postgres, service_role, supabase_auth_admin;
grant all on all sequences in schema public to postgres, service_role, supabase_auth_admin;
grant execute on all functions in schema public to postgres, service_role, supabase_auth_admin;

-- ---------- Tables: SELECT only (rows further filtered by RLS) ---------------------
grant select on public.avatars, public.app_config, public.game_catalog, public.tournaments
  to anon;

grant select on
  public.avatars, public.app_config, public.game_catalog, public.tournaments,
  public.profiles, public.user_roles,
  public.wallets, public.wallet_transactions,
  public.shop_items, public.user_items,
  public.rooms, public.room_secrets, public.room_players,
  public.game_states, public.game_private_states, public.chat_messages,
  public.tournament_participants
  to authenticated;

-- Admin-managed content: write privilege is granted, but RLS policies only pass is_admin().
grant insert, update, delete on public.shop_items, public.tournaments to authenticated;

-- NOTHING else is writable by clients: wallets, wallet_transactions, user_items, user_roles,
-- profiles, rooms, room_players, game_states, chat_messages, tournament_participants ...
-- (pin_attempts has RLS enabled, no policies and no grants: fully server-side.)

-- ---------- Functions: RLS helper predicates (evaluated as the caller) -------------
grant execute on function
  public.is_admin(),
  public.is_room_member(uuid),
  public.is_room_host(uuid),
  public.is_public_room(uuid),
  public.can_use_realtime_topic(text, text)
  to anon, authenticated;

-- ---------- Functions: client RPCs --------------------------------------------------
grant execute on function public.is_username_available(text) to anon, authenticated;

grant execute on function
  public.update_profile(text, text),
  public.get_bonus_status(),
  public.claim_daily_bonus(),
  public.purchase_item(uuid, int, text),
  public.equip_card_back(uuid),
  public.create_room(text, text, text, int, bigint),
  public.join_room(uuid),
  public.join_room_by_pin(text),
  public.leave_room(uuid),
  public.return_from_afk(uuid),
  public.send_chat_message(uuid, text),
  public.register_for_tournament(uuid),
  public.unregister_from_tournament(uuid),
  -- admin-only RPCs: authenticated may call them, each one checks is_admin() internally
  public.admin_adjust_balance(uuid, bigint, text),
  public.admin_set_config(text, jsonb),
  public.admin_set_featured_tournament(uuid)
  to authenticated;

-- ---------- Functions: server-only (service_role / postgres / supabase_auth_admin) --
grant execute on function
  public.apply_balance_delta(uuid, bigint, text, text, text, text, jsonb),
  public.apply_balance_delta(uuid, bigint, text, jsonb, uuid, text),
  public.apply_balance_delta(bigint, text, jsonb),
  public.consume_emote_charge(uuid, uuid),
  public.force_afk(uuid, uuid),
  public.bootstrap_admin(text),
  public.handle_new_user()
  to postgres, service_role, supabase_auth_admin;

grant execute on function
  public.apply_balance_delta(bigint, text, jsonb)
  to authenticated;


-- =============================================================================
-- FILE: 20261030000008_avatar_image_paths.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 2 / Migration 8 â€” avatar assets are shipped as JPG with the web app
-- =============================================================================
-- The registration screen renders avatars from the web app's /avatars/<id>.jpg (no network
-- dependency before sign-in). Keep the catalogue in sync with that.
update public.avatars
   set image_path = 'avatars/' || id || '.jpg';


-- =============================================================================
-- FILE: 20261030000009_tournaments_seed_realtime.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 4 / Migration 9 â€” default featured banner tournament &
--                                      realtime publication for participants
-- =============================================================================

-- Add tournament_participants to Realtime so rosters and seat counts update live.
alter table public.tournament_participants replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.tournament_participants;
    exception when duplicate_object then
      null;
    end;
  end if;
end $$;

-- Seed an initial featured tournament if none is featured yet, so the homepage
-- hero banner is populated out of the box and immediately editable by the Admin.
insert into public.tournaments (
  title,
  description,
  game_type,
  prize_name,
  prize_image_path,
  starts_at,
  entry_fee,
  max_participants,
  status,
  is_featured
)
select
  'The Grand House Invitational',
  'High-stakes championship across the house tables. Registered contenders compete through elimination rounds for the house crest and the grand prize.',
  'blackjack',
  'Royal Gold Chronograph & 50,000 Chips',
  '/tournaments/royal-chronograph.svg',
  date_trunc('hour', now() + interval '7 days') + interval '20 hours',
  1000,
  64,
  'upcoming',
  true
where not exists (
  select 1 from public.tournaments where is_featured
);



-- =============================================================================
-- FILE: 20261030000010_game_engine_core.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 6 / Migration 10 â€” Game Engine Core:
--   * Server clock helper (`get_server_time`)
--   * Interactive emote charge consumption RPC (`use_interactive_emote`)
--   * 15-second turn deadline & automatic AFK neutral-action enforcement
--     (`start_turn_cycle`, `perform_turn_action`, `claim_turn_timeout`)
-- =============================================================================

-- ---------- 1. Server clock sync helper --------------------------------------
create or replace function public.get_server_time()
returns timestamptz
language sql stable
set search_path = ''
as $$
  select now();
$$;

-- ---------- 2. Spend & validate a targeted interactive emote -----------------
create or replace function public.use_interactive_emote(
  p_room_id     uuid,
  p_target_user uuid,
  p_item_id     uuid
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid   uuid := public.require_uid();
  v_item  public.shop_items;
  v_left  int;
begin
  if v_uid = p_target_user then
    raise exception 'cannot_target_self';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = v_uid
  ) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = p_target_user
  ) then
    raise exception 'target_not_in_room';
  end if;

  select * into v_item
    from public.shop_items
   where id = p_item_id and kind = 'emote' and is_interactive and is_active;
  if not found then
    raise exception 'item_not_found';
  end if;

  v_left := public.consume_emote_charge(v_uid, p_item_id);

  return jsonb_build_object(
    'item_id',     v_item.id,
    'slug',        v_item.slug,
    'name',        v_item.name,
    'animation',   coalesce(v_item.asset ->> 'animation', 'slap'),
    'sender_id',   v_uid,
    'target_id',   p_target_user,
    'remaining',   v_left,
    'server_now',  now()
  );
end;
$$;

-- ---------- 3. Internal helper: pick next active seat in a room --------------
create or replace function public.next_active_room_user(
  p_room_id      uuid,
  p_current_user uuid default null
)
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_cur_seat smallint;
  v_next     uuid;
begin
  if p_current_user is not null then
    select seat into v_cur_seat
      from public.room_players
     where room_id = p_room_id and user_id = p_current_user;
  end if;

  if v_cur_seat is not null then
    select user_id into v_next
      from public.room_players
     where room_id = p_room_id and status = 'active' and seat > v_cur_seat
     order by seat asc
     limit 1;
    if found then
      return v_next;
    end if;
  end if;

  select user_id into v_next
    from public.room_players
   where room_id = p_room_id and status = 'active'
   order by seat asc
   limit 1;

  return v_next;
end;
$$;

-- ---------- 4. Start or resume a turn cycle (15s deadline per turn) ----------
create or replace function public.start_turn_cycle(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.require_uid();
  v_room     public.rooms;
  v_gs       public.game_states;
  v_first    uuid;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' then
    raise exception 'room_not_found';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = v_uid
  ) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;

  -- Mark the caller active if they were AFK/spectating.
  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;

  v_first := public.next_active_room_user(p_room_id, null);
  if v_first is null then
    raise exception 'no_active_players';
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_first,
         turn_deadline = v_deadline,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'last_action', jsonb_build_object(
             'type', 'round_started',
             'user_id', v_uid,
             'forced_by_timeout', false,
             'at', now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'turn_user_id',  v_first,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- ---------- 5. Perform an in-turn action before the 15s deadline -------------
create or replace function public.perform_turn_action(
  p_room_id uuid,
  p_action  text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.require_uid();
  v_gs       public.game_states;
  v_next     uuid;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
  v_act      text := trim(coalesce(p_action, ''));
begin
  if v_act = '' or char_length(v_act) > 40 then
    raise exception 'invalid_action';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  if v_gs.turn_user_id is distinct from v_uid then
    raise exception 'not_your_turn';
  end if;

  -- If the 15s deadline already passed on the server clock, enforce the timeout instead.
  if v_gs.turn_deadline is not null and now() > v_gs.turn_deadline then
    return public.claim_turn_timeout(p_room_id);
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;

  v_next := public.next_active_room_user(p_room_id, v_uid);
  v_deadline := case when v_next is not null then now() + make_interval(secs => v_timeout) else null end;

  update public.game_states
     set version       = v_gs.version + 1,
         turn_user_id  = v_next,
         turn_deadline = v_deadline,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'last_action', jsonb_build_object(
             'type', v_act,
             'user_id', v_uid,
             'payload', coalesce(p_payload, '{}'::jsonb),
             'forced_by_timeout', false,
             'at', now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'turn_user_id',  v_next,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- ---------- 6. Authoritative 15-second timeout & AFK enforcement -------------
-- If `now() >= turn_deadline`, forces a neutral action for the timed-out player,
-- sets their status to 'afk' via `force_afk()`, and advances the turn so an
-- unresponsive player never delays the room. Idempotent under concurrent calls.
create or replace function public.claim_turn_timeout(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_caller   uuid := (select auth.uid());
  v_room     public.rooms;
  v_gs       public.game_states;
  v_timed_u  uuid;
  v_neutral  text;
  v_next     uuid;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
  v_phase    text;
begin
  -- Allow either a seated room member or service_role (v_caller is null for service_role).
  if v_caller is not null and not public.is_room_member(p_room_id) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  if v_gs.turn_user_id is null or v_gs.turn_deadline is null or now() < v_gs.turn_deadline then
    return jsonb_build_object(
      'expired',       false,
      'version',       v_gs.version,
      'turn_user_id',  v_gs.turn_user_id,
      'turn_deadline', v_gs.turn_deadline,
      'server_now',    now()
    );
  end if;

  v_timed_u := v_gs.turn_user_id;

  -- 1) Mark the timed-out player AFK so they cannot stall future turns.
  perform public.force_afk(p_room_id, v_timed_u);

  -- 2) Determine the game-specific neutral action.
  v_neutral := case v_room.game_type
    when 'poker'     then 'check_fold'
    when 'blackjack' then 'stand'
    else                  'skip'
  end;

  -- 3) Advance to the next active player (excluding the now-AFK player).
  v_next := public.next_active_room_user(p_room_id, v_timed_u);
  if v_next is not null then
    v_deadline := now() + make_interval(secs => v_timeout);
    v_phase := v_gs.phase;
  else
    v_deadline := null;
    v_phase := 'awaiting_players';
  end if;

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = v_phase,
         turn_user_id  = v_next,
         turn_deadline = v_deadline,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'last_action', jsonb_build_object(
             'type', v_neutral,
             'user_id', v_timed_u,
             'forced_by_timeout', true,
             'at', now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'expired',        true,
    'timed_out_user', v_timed_u,
    'forced_action',  v_neutral,
    'version',        v_gs.version + 1,
    'turn_user_id',   v_next,
    'turn_deadline',  v_deadline,
    'server_now',     now()
  );
end;
$$;

-- ---------- 7. Grants (required by Migration 7 default-deny lockdown) --------
grant execute on function
  public.get_server_time()
  to anon, authenticated, service_role;

grant execute on function
  public.use_interactive_emote(uuid, uuid, uuid),
  public.start_turn_cycle(uuid),
  public.perform_turn_action(uuid, text, jsonb),
  public.claim_turn_timeout(uuid)
  to authenticated, service_role;

grant execute on function
  public.next_active_room_user(uuid, uuid)
  to service_role;



-- =============================================================================
-- FILE: 20261030000011_blackjack_engine.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 7 / Migration 11 â€” Blackjack Authoritative Engine
-- =============================================================================
-- Security & Anti-Cheat guarantees:
--   1. Server-only secrets table (`public.game_server_secrets`) holds the 6-deck
--      shuffled shoe and the unrevealed dealer hole card. RLS is enabled with
--      ZERO client policies and all privileges revoked from `anon`/`authenticated`.
--      Clients can NEVER inspect future cards or the dealer's face-down hole card.
--   2. Every bet, double-down, push refund, 1:1 win, and 3:2 Blackjack payout is
--      executed exclusively on the server via `public.apply_balance_delta()` with
--      deterministic idempotency keys.
--   3. 15-second turn deadline enforcement (`claim_turn_timeout`) automatically
--      marks a timed-out player AFK (`status = 'afk'`) and either skips their
--      unplaced bet (during `'betting'`) or forces `'stand'` (during `'playing'`),
--      then advances the hand or triggers dealer settlement so the room never stalls.
-- =============================================================================

-- ---------- 1. Server-only secret state (shoe & hidden dealer hole card) ------
create table if not exists public.game_server_secrets (
  room_id          uuid primary key references public.rooms(id) on delete cascade,
  shoe             jsonb not null default '[]'::jsonb,
  dealer_hole_card jsonb,
  secret_data      jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);

alter table public.game_server_secrets enable row level security;
-- Intentionally NO RLS policies for anon/authenticated: strictly server-only.
revoke all on table public.game_server_secrets from public, anon, authenticated;
grant all on table public.game_server_secrets to service_role;

-- ---------- 2. Blackjack Shoe & Hand Evaluation Helpers -----------------------
create or replace function public.bj_build_shoe(p_decks int default 6)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('rank', r.rank, 'suit', s.suit)
      order by gen_random_uuid()
    ),
    '[]'::jsonb
  )
  from generate_series(1, greatest(1, coalesce(p_decks, 6))) as d(deck_no)
  cross join (values ('S'), ('H'), ('D'), ('C')) as s(suit)
  cross join (
    values ('A'), ('2'), ('3'), ('4'), ('5'), ('6'), ('7'),
           ('8'), ('9'), ('10'), ('J'), ('Q'), ('K')
  ) as r(rank);
$$;

create or replace function public.bj_hand_eval(p_cards jsonb)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_card   jsonb;
  v_rank   text;
  v_total  int := 0;
  v_aces   int := 0;
  v_count  int := coalesce(jsonb_array_length(p_cards), 0);
begin
  for v_card in select value from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb))
  loop
    v_rank := v_card ->> 'rank';
    if v_rank = 'A' then
      v_total := v_total + 11;
      v_aces  := v_aces + 1;
    elsif v_rank in ('K', 'Q', 'J', '10') then
      v_total := v_total + 10;
    else
      v_total := v_total + coalesce(v_rank::int, 0);
    end if;
  end loop;

  while v_total > 21 and v_aces > 0 loop
    v_total := v_total - 10;
    v_aces  := v_aces - 1;
  end loop;

  return jsonb_build_object(
    'total',        v_total,
    'is_soft',      (v_aces > 0),
    'is_blackjack', (v_count = 2 and v_total = 21),
    'is_bust',      (v_total > 21)
  );
end;
$$;

-- ---------- 3. Dealer Turn & Atomic Settlement (`bj_settle_round`) ------------
create or replace function public.bj_settle_round(
  p_room_id      uuid,
  p_round        int,
  p_hands        jsonb,
  p_dealer_cards jsonb,
  p_shoe         jsonb,
  p_last_action  jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs            public.game_states;
  v_room          public.rooms;
  v_shoe          jsonb := coalesce(p_shoe, '[]'::jsonb);
  v_dealer_cards  jsonb := coalesce(p_dealer_cards, '[]'::jsonb);
  v_dealer_eval   jsonb;
  v_any_live_hand boolean := false;
  v_uid_text      text;
  v_hand          jsonb;
  v_settled_hands jsonb := '{}'::jsonb;
  v_bet           bigint;
  v_status        text;
  v_p_total       int;
  v_p_bj          boolean;
  v_d_total       int;
  v_d_bj          boolean;
  v_d_bust        boolean;
  v_outcome       text;
  v_payout        bigint;
  v_net           bigint;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  select * into v_gs from public.game_states where room_id = p_room_id for update;

  -- Check if at least one participating player did not bust and does not have a natural blackjack
  -- (if everyone busted, dealer only reveals hole card without needing to hit).
  for v_uid_text, v_hand in select key, value from jsonb_each(coalesce(p_hands, '{}'::jsonb))
  loop
    if coalesce((v_hand ->> 'bet')::bigint, 0) > 0
       and coalesce(v_hand ->> 'status', '') not in ('bust', 'skipped_afk')
    then
      v_any_live_hand := true;
    end if;
  end loop;

  v_dealer_eval := public.bj_hand_eval(v_dealer_cards);

  -- Standard Casino S17 rule: Dealer draws until total >= 17 (stands on all 17s).
  while v_any_live_hand and (v_dealer_eval ->> 'total')::int < 17 loop
    if jsonb_array_length(v_shoe) < 1 then
      v_shoe := public.bj_build_shoe(6);
    end if;
    v_dealer_cards := v_dealer_cards || jsonb_build_array(v_shoe -> 0);
    v_shoe := v_shoe - 0;
    v_dealer_eval := public.bj_hand_eval(v_dealer_cards);
  end loop;

  v_d_total := (v_dealer_eval ->> 'total')::int;
  v_d_bj    := (v_dealer_eval ->> 'is_blackjack')::boolean;
  v_d_bust  := (v_dealer_eval ->> 'is_bust')::boolean;

  -- Settle each player's hand and credit winnings/refunds via `apply_balance_delta`.
  for v_uid_text, v_hand in select key, value from jsonb_each(coalesce(p_hands, '{}'::jsonb))
  loop
    v_bet     := coalesce((v_hand ->> 'bet')::bigint, 0);
    v_status  := coalesce(v_hand ->> 'status', 'skipped_afk');
    v_p_total := coalesce((v_hand ->> 'total')::int, 0);
    v_p_bj    := coalesce((v_hand ->> 'is_blackjack')::boolean, false);
    v_outcome := null;
    v_payout  := 0;
    v_net     := 0;

    if v_bet > 0 then
      if v_status = 'bust' or v_p_total > 21 then
        v_outcome := 'bust';
        v_payout  := 0;
        v_net     := -v_bet;
      elsif v_d_bj and v_p_bj then
        v_outcome := 'push';
        v_payout  := v_bet;
        v_net     := 0;
      elsif v_d_bj then
        v_outcome := 'lose';
        v_payout  := 0;
        v_net     := -v_bet;
      elsif v_p_bj then
        -- Natural Blackjack pays 3:2 (total return = bet + floor(bet * 1.5))
        v_outcome := 'blackjack';
        v_payout  := v_bet + ((v_bet * 3) / 2);
        v_net     := (v_bet * 3) / 2;
      elsif v_d_bust or v_p_total > v_d_total then
        v_outcome := 'win';
        v_payout  := v_bet * 2;
        v_net     := v_bet;
      elsif v_p_total = v_d_total then
        v_outcome := 'push';
        v_payout  := v_bet;
        v_net     := 0;
      else
        v_outcome := 'lose';
        v_payout  := 0;
        v_net     := -v_bet;
      end if;

      if v_payout > 0 then
        perform public.apply_balance_delta(
          v_uid_text::uuid,
          v_payout,
          case when v_outcome = 'push' then 'game_refund' else 'game_win' end,
          jsonb_build_object(
            'game',    'blackjack',
            'room_id', p_room_id,
            'round',   p_round,
            'outcome', v_outcome,
            'bet',     v_bet,
            'payout',  v_payout
          ),
          p_room_id,
          format('bj:%s:r%s:%s:settle', p_room_id, p_round, v_uid_text)
        );
      end if;
    end if;

    v_settled_hands := v_settled_hands || jsonb_build_object(
      v_uid_text,
      v_hand || jsonb_build_object(
        'outcome', v_outcome,
        'payout',  v_payout,
        'net',     v_net
      )
    );
  end loop;

  -- Persist remaining shoe and clear dealer_hole_card since it is now public.
  insert into public.game_server_secrets (room_id, shoe, dealer_hole_card, updated_at)
  values (p_room_id, v_shoe, null, now())
  on conflict (room_id) do update
    set shoe             = excluded.shoe,
        dealer_hole_card = null,
        updated_at       = now();

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'settled',
         turn_user_id  = null,
         turn_deadline = null,
         state         = jsonb_build_object(
           'round_number',   p_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        greatest(v_room.min_bet, 50),
           'shoe_remaining', jsonb_array_length(v_shoe),
           'dealer',         jsonb_build_object(
             'cards',        v_dealer_cards,
             'hole_hidden',  false,
             'total',        v_d_total,
             'is_soft',      (v_dealer_eval ->> 'is_soft')::boolean,
             'is_blackjack', v_d_bj,
             'is_bust',      v_d_bust
           ),
           'hands',          v_settled_hands,
           'last_action',    p_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',    p_room_id,
    'version',    v_gs.version + 1,
    'phase',      'settled',
    'server_now', now()
  );
end;
$$;

-- ---------- 4. Advance Player Turn or Trigger Settlement ----------------------
create or replace function public.bj_advance_or_settle(
  p_room_id     uuid,
  p_round       int,
  p_hands       jsonb,
  p_last_action jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs          public.game_states;
  v_sec         public.game_server_secrets;
  v_next_user   uuid;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_dealer_up   jsonb;
  v_dealer_full jsonb;
begin
  select * into v_gs from public.game_states where room_id = p_room_id for update;

  -- Find the first player (by seat order) whose hand is still in 'playing' status.
  select (value ->> 'user_id')::uuid into v_next_user
    from jsonb_each(coalesce(p_hands, '{}'::jsonb))
   where value ->> 'status' = 'playing'
   order by coalesce((value ->> 'seat')::int, 0) asc
   limit 1;

  if v_next_user is not null then
    v_deadline := now() + make_interval(secs => v_timeout);

    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'playing',
           turn_user_id  = v_next_user,
           turn_deadline = v_deadline,
           state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
             'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
             'hands',       p_hands,
             'last_action', p_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object(
      'room_id',       p_room_id,
      'version',       v_gs.version + 1,
      'phase',         'playing',
      'turn_user_id',  v_next_user,
      'turn_deadline', v_deadline,
      'server_now',    now()
    );
  end if;

  -- All players have completed their actions -> reveal dealer hole card and settle!
  select * into v_sec from public.game_server_secrets where room_id = p_room_id for update;
  v_dealer_up := coalesce(v_gs.state #> '{dealer,cards}', '[]'::jsonb);
  if v_sec.dealer_hole_card is not null then
    v_dealer_full := v_dealer_up || jsonb_build_array(v_sec.dealer_hole_card);
  else
    v_dealer_full := v_dealer_up;
  end if;

  return public.bj_settle_round(
    p_room_id,
    p_round,
    p_hands,
    v_dealer_full,
    coalesce(v_sec.shoe, '[]'::jsonb),
    p_last_action
  );
end;
$$;

-- ---------- 5. Deal Initial Cards Once Betting Completes ----------------------
create or replace function public.bj_deal_initial_cards(
  p_room_id     uuid,
  p_round       int,
  p_hands       jsonb,
  p_last_action jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs            public.game_states;
  v_room          public.rooms;
  v_sec           public.game_server_secrets;
  v_shoe          jsonb;
  v_dealt_hands   jsonb := '{}'::jsonb;
  v_rec           record;
  v_hand          jsonb;
  v_p_cards       jsonb;
  v_p_eval        jsonb;
  v_p_status      text;
  v_dealer_up     jsonb;
  v_dealer_hole   jsonb;
  v_dealer_up_ev  jsonb;
  v_any_bet       boolean := false;
  v_first_playing uuid;
  v_timeout       int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline      timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  select * into v_gs from public.game_states where room_id = p_room_id for update;

  -- Check if at least one player placed a bet.
  for v_rec in
    select key as uid_text, value as h
      from jsonb_each(coalesce(p_hands, '{}'::jsonb))
     order by coalesce((value ->> 'seat')::int, 0) asc
  loop
    if coalesce((v_rec.h ->> 'bet')::bigint, 0) > 0 then
      v_any_bet := true;
    end if;
  end loop;

  if not v_any_bet then
    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'lobby',
           turn_user_id  = null,
           turn_deadline = null,
           state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
             'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
             'hands',       p_hands,
             'last_action', p_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object(
      'room_id',    p_room_id,
      'version',    v_gs.version + 1,
      'phase',      'lobby',
      'server_now', now()
    );
  end if;

  -- Load or build a fresh 6-deck (312-card) shoe if < 52 cards remain.
  select * into v_sec from public.game_server_secrets where room_id = p_room_id for update;
  if not found or jsonb_array_length(coalesce(v_sec.shoe, '[]'::jsonb)) < 52 then
    v_shoe := public.bj_build_shoe(6);
  else
    v_shoe := v_sec.shoe;
  end if;

  -- Deal 2 cards to each player who placed a bet (ordered by seat).
  for v_rec in
    select key as uid_text, value as h
      from jsonb_each(coalesce(p_hands, '{}'::jsonb))
     order by coalesce((value ->> 'seat')::int, 0) asc
  loop
    v_hand := v_rec.h;
    if coalesce((v_hand ->> 'bet')::bigint, 0) > 0 then
      v_p_cards := jsonb_build_array(v_shoe -> 0, v_shoe -> 1);
      v_shoe    := (v_shoe - 0) - 0;
      v_p_eval  := public.bj_hand_eval(v_p_cards);
      v_p_status := case
        when (v_p_eval ->> 'is_blackjack')::boolean then 'blackjack'
        else 'playing'
      end;

      v_dealt_hands := v_dealt_hands || jsonb_build_object(
        v_rec.uid_text,
        v_hand || jsonb_build_object(
          'cards',        v_p_cards,
          'total',        (v_p_eval ->> 'total')::int,
          'is_soft',      (v_p_eval ->> 'is_soft')::boolean,
          'is_blackjack', (v_p_eval ->> 'is_blackjack')::boolean,
          'status',       v_p_status,
          'outcome',      null,
          'payout',       0,
          'net',          0
        )
      );
    else
      v_dealt_hands := v_dealt_hands || jsonb_build_object(v_rec.uid_text, v_hand);
    end if;
  end loop;

  -- Deal 1 face-up card and 1 secret hole card to the House dealer.
  v_dealer_up    := v_shoe -> 0;
  v_dealer_hole  := v_shoe -> 1;
  v_shoe         := (v_shoe - 0) - 0;
  v_dealer_up_ev := public.bj_hand_eval(jsonb_build_array(v_dealer_up));

  -- Store remaining shoe and secret dealer hole card in `game_server_secrets`.
  insert into public.game_server_secrets (room_id, shoe, dealer_hole_card, updated_at)
  values (p_room_id, v_shoe, v_dealer_hole, now())
  on conflict (room_id) do update
    set shoe             = excluded.shoe,
        dealer_hole_card = excluded.dealer_hole_card,
        updated_at       = now();

  -- Find first player who needs to act ('playing').
  select (value ->> 'user_id')::uuid into v_first_playing
    from jsonb_each(v_dealt_hands)
   where value ->> 'status' = 'playing'
   order by coalesce((value ->> 'seat')::int, 0) asc
   limit 1;

  -- If all betting players hit a Natural Blackjack on the initial deal, settle immediately!
  if v_first_playing is null then
    return public.bj_settle_round(
      p_room_id,
      p_round,
      v_dealt_hands,
      jsonb_build_array(v_dealer_up, v_dealer_hole),
      v_shoe,
      p_last_action
    );
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_first_playing,
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',   p_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        greatest(v_room.min_bet, 50),
           'shoe_remaining', jsonb_array_length(v_shoe),
           'dealer',         jsonb_build_object(
             'cards',        jsonb_build_array(v_dealer_up),
             'hole_hidden',  true,
             'total',        (v_dealer_up_ev ->> 'total')::int,
             'is_soft',      (v_dealer_up_ev ->> 'is_soft')::boolean,
             'is_blackjack', false,
             'is_bust',      false
           ),
           'hands',          v_dealt_hands,
           'last_action',    p_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'playing',
    'turn_user_id',  v_first_playing,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- ---------- 6. Public RPC: Start a Blackjack Round (`blackjack_start_round`) --
create or replace function public.blackjack_start_round(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.require_uid();
  v_room     public.rooms;
  v_gs       public.game_states;
  v_round    int;
  v_hands    jsonb := '{}'::jsonb;
  v_seat     record;
  v_first    uuid;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' then
    raise exception 'room_not_found';
  end if;
  if v_room.game_type <> 'blackjack' then
    raise exception 'invalid_action';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = v_uid
  ) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if v_gs.phase not in ('lobby', 'settled', 'awaiting_players') then
    raise exception 'round_already_active';
  end if;

  -- Activate caller and promote any spectating seats for the new round.
  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;

  for v_seat in
    select user_id, seat
      from public.room_players
     where room_id = p_room_id and status = 'active'
     order by seat asc
  loop
    if v_first is null then
      v_first := v_seat.user_id;
    end if;
    v_hands := v_hands || jsonb_build_object(
      v_seat.user_id::text,
      jsonb_build_object(
        'user_id',      v_seat.user_id,
        'seat',         v_seat.seat,
        'bet',          0,
        'cards',        '[]'::jsonb,
        'total',        0,
        'is_soft',      false,
        'is_blackjack', false,
        'status',       'betting',
        'outcome',      null,
        'payout',       0,
        'net',          0
      )
    );
  end loop;

  if v_first is null then
    raise exception 'no_active_players';
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'betting',
         turn_user_id  = v_first,
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',   v_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        greatest(v_room.min_bet, 50),
           'shoe_remaining', coalesce((v_gs.state ->> 'shoe_remaining')::int, 312),
           'dealer',         jsonb_build_object(
             'cards',        '[]'::jsonb,
             'hole_hidden',  false,
             'total',        0,
             'is_soft',      false,
             'is_blackjack', false,
             'is_bust',      false
           ),
           'hands',          v_hands,
           'last_action',    jsonb_build_object(
             'type',              'betting_opened',
             'user_id',           v_uid,
             'forced_by_timeout', false,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'betting',
    'turn_user_id',  v_first,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- ---------- 7. Public RPC: Place Bet & Deal (`blackjack_place_bet`) -----------
-- Can be called during `'betting'` OR directly from `'lobby'`/`'settled'` to
-- start a new round and place the caller's bet in one seamless click.
create or replace function public.blackjack_place_bet(
  p_room_id uuid,
  p_amount  bigint
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_uid();
  v_room        public.rooms;
  v_gs          public.game_states;
  v_min_bet     bigint;
  v_round       int;
  v_hands       jsonb;
  v_my_hand     jsonb;
  v_my_seat     smallint;
  v_next_bettor uuid;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_last_action jsonb;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' then
    raise exception 'room_not_found';
  end if;
  if v_room.game_type <> 'blackjack' then
    raise exception 'invalid_action';
  end if;

  select seat into v_my_seat
    from public.room_players
   where room_id = p_room_id and user_id = v_uid;
  if not found then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  v_min_bet := greatest(v_room.min_bet, 50);
  if p_amount is null or p_amount < v_min_bet or p_amount > 1000000 then
    raise exception 'invalid_bet_amount';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;

  -- If the round hasn't entered 'betting' yet, initialize 'betting' state inline.
  if v_gs.phase in ('lobby', 'settled', 'awaiting_players') then
    update public.room_players
       set status = 'active', afk_since = null, last_seen_at = now()
     where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

    v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;
    v_hands := '{}'::jsonb;

    for v_my_seat in
      select seat from public.room_players where room_id = p_room_id and status = 'active' order by seat asc
    loop
      null;
    end loop;

    select jsonb_object_agg(
      rp.user_id::text,
      jsonb_build_object(
        'user_id',      rp.user_id,
        'seat',         rp.seat,
        'bet',          0,
        'cards',        '[]'::jsonb,
        'total',        0,
        'is_soft',      false,
        'is_blackjack', false,
        'status',       'betting',
        'outcome',      null,
        'payout',       0,
        'net',          0
      )
    ) into v_hands
    from public.room_players rp
    where rp.room_id = p_room_id and rp.status = 'active';

    update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';
  elsif v_gs.phase = 'betting' then
    -- Check if the current turn_deadline expired before this call arrived.
    if v_gs.turn_user_id is not null
       and v_gs.turn_user_id is distinct from v_uid
       and v_gs.turn_deadline is not null
       and now() > v_gs.turn_deadline
    then
      perform public.claim_turn_timeout(p_room_id);
      select * into v_gs from public.game_states where room_id = p_room_id for update;
      if v_gs.phase <> 'betting' then
        return jsonb_build_object('room_id', p_room_id, 'phase', v_gs.phase, 'version', v_gs.version);
      end if;
    end if;

    v_round := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_hands := coalesce(v_gs.state -> 'hands', '{}'::jsonb);

    -- Allow an active/AFK seated player to join the betting phase if not yet in `v_hands`.
    update public.room_players
       set status = 'active', afk_since = null, last_seen_at = now()
     where room_id = p_room_id and user_id = v_uid;

    if not (v_hands ? v_uid::text) then
      select seat into v_my_seat from public.room_players where room_id = p_room_id and user_id = v_uid;
      v_hands := v_hands || jsonb_build_object(
        v_uid::text,
        jsonb_build_object(
          'user_id',      v_uid,
          'seat',         v_my_seat,
          'bet',          0,
          'cards',        '[]'::jsonb,
          'total',        0,
          'is_soft',      false,
          'is_blackjack', false,
          'status',       'betting',
          'outcome',      null,
          'payout',       0,
          'net',          0
        )
      );
    end if;
  else
    raise exception 'round_already_active';
  end if;

  v_my_hand := v_hands -> v_uid::text;
  if v_my_hand is null or coalesce(v_my_hand ->> 'status', '') not in ('betting', 'skipped_afk') then
    raise exception 'bet_already_placed';
  end if;

  -- Deduct the bet atomically via `apply_balance_delta`.
  perform public.apply_balance_delta(
    v_uid,
    -p_amount,
    'game_bet',
    jsonb_build_object(
      'game',    'blackjack',
      'room_id', p_room_id,
      'round',   v_round,
      'bet',     p_amount
    ),
    p_room_id,
    format('bj:%s:r%s:%s:bet', p_room_id, v_round, v_uid)
  );

  v_hands := jsonb_set(
    v_hands,
    array[v_uid::text],
    v_my_hand || jsonb_build_object(
      'bet',    p_amount,
      'status', 'bet_placed'
    )
  );

  v_last_action := jsonb_build_object(
    'type',              'bet',
    'user_id',           v_uid,
    'payload',           jsonb_build_object('amount', p_amount),
    'forced_by_timeout', false,
    'at',                now()
  );

  -- Check if any active player still has `status = 'betting'`.
  select (value ->> 'user_id')::uuid into v_next_bettor
    from jsonb_each(v_hands)
   where value ->> 'status' = 'betting'
   order by coalesce((value ->> 'seat')::int, 0) asc
   limit 1;

  if v_next_bettor is null then
    -- All active players have bet -> deal initial cards immediately!
    return public.bj_deal_initial_cards(p_room_id, v_round, v_hands, v_last_action);
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'betting',
         turn_user_id  = v_next_bettor,
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',   v_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        v_min_bet,
           'shoe_remaining', coalesce((v_gs.state ->> 'shoe_remaining')::int, 312),
           'dealer',         jsonb_build_object(
             'cards',        '[]'::jsonb,
             'hole_hidden',  false,
             'total',        0,
             'is_soft',      false,
             'is_blackjack', false,
             'is_bust',      false
           ),
           'hands',          v_hands,
           'last_action',    v_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'betting',
    'turn_user_id',  v_next_bettor,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- ---------- 8. Public RPC: Player Turn Action (`blackjack_action`) ------------
-- Actions: 'hit', 'stand', 'double'
create or replace function public.blackjack_action(
  p_room_id uuid,
  p_action  text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_uid();
  v_room        public.rooms;
  v_gs          public.game_states;
  v_sec         public.game_server_secrets;
  v_act         text := lower(trim(coalesce(p_action, '')));
  v_round       int;
  v_hands       jsonb;
  v_my_hand     jsonb;
  v_cards       jsonb;
  v_eval        jsonb;
  v_bet         bigint;
  v_shoe        jsonb;
  v_status      text;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_last_action jsonb;
begin
  if v_act not in ('hit', 'stand', 'double') then
    raise exception 'invalid_action';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.game_type <> 'blackjack' then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found or v_gs.phase <> 'playing' then
    raise exception 'invalid_action';
  end if;

  if v_gs.turn_user_id is distinct from v_uid then
    raise exception 'not_your_turn';
  end if;

  -- If the 15-second turn clock already expired, enforce timeout instead.
  if v_gs.turn_deadline is not null and now() > v_gs.turn_deadline then
    return public.claim_turn_timeout(p_room_id);
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;

  v_round   := coalesce((v_gs.state ->> 'round_number')::int, 1);
  v_hands   := coalesce(v_gs.state -> 'hands', '{}'::jsonb);
  v_my_hand := v_hands -> v_uid::text;

  if v_my_hand is null or (v_my_hand ->> 'status') <> 'playing' then
    raise exception 'invalid_action';
  end if;

  v_cards := coalesce(v_my_hand -> 'cards', '[]'::jsonb);
  v_bet   := coalesce((v_my_hand ->> 'bet')::bigint, 0);

  v_last_action := jsonb_build_object(
    'type',              v_act,
    'user_id',           v_uid,
    'forced_by_timeout', false,
    'at',                now()
  );

  if v_act = 'stand' then
    v_hands := jsonb_set(
      v_hands,
      array[v_uid::text],
      v_my_hand || jsonb_build_object('status', 'stood')
    );
    return public.bj_advance_or_settle(p_room_id, v_round, v_hands, v_last_action);
  end if;

  -- Both 'hit' and 'double' draw 1 card from the secret shoe.
  select * into v_sec from public.game_server_secrets where room_id = p_room_id for update;
  v_shoe := coalesce(v_sec.shoe, '[]'::jsonb);
  if jsonb_array_length(v_shoe) < 1 then
    v_shoe := public.bj_build_shoe(6);
  end if;

  if v_act = 'double' then
    if jsonb_array_length(v_cards) <> 2 then
      raise exception 'double_only_on_two_cards';
    end if;

    -- Deduct the additional equal bet via `apply_balance_delta`.
    perform public.apply_balance_delta(
      v_uid,
      -v_bet,
      'game_bet',
      jsonb_build_object(
        'game',    'blackjack',
        'room_id', p_room_id,
        'round',   v_round,
        'action',  'double',
        'bet',     v_bet
      ),
      p_room_id,
      format('bj:%s:r%s:%s:double', p_room_id, v_round, v_uid)
    );

    v_bet   := v_bet * 2;
    v_cards := v_cards || jsonb_build_array(v_shoe -> 0);
    v_shoe  := v_shoe - 0;
    v_eval  := public.bj_hand_eval(v_cards);

    update public.game_server_secrets
       set shoe = v_shoe, updated_at = now()
     where room_id = p_room_id;

    v_status := case
      when (v_eval ->> 'is_bust')::boolean then 'bust'
      else 'doubled'
    end;

    v_hands := jsonb_set(
      v_hands,
      array[v_uid::text],
      v_my_hand || jsonb_build_object(
        'bet',     v_bet,
        'cards',   v_cards,
        'total',   (v_eval ->> 'total')::int,
        'is_soft', (v_eval ->> 'is_soft')::boolean,
        'status',  v_status
      )
    );

    return public.bj_advance_or_settle(p_room_id, v_round, v_hands, v_last_action);
  end if;

  -- v_act = 'hit'
  v_cards := v_cards || jsonb_build_array(v_shoe -> 0);
  v_shoe  := v_shoe - 0;
  v_eval  := public.bj_hand_eval(v_cards);

  update public.game_server_secrets
     set shoe = v_shoe, updated_at = now()
   where room_id = p_room_id;

  if (v_eval ->> 'is_bust')::boolean then
    v_status := 'bust';
  elsif (v_eval ->> 'total')::int >= 21 then
    v_status := 'stood';
  else
    v_status := 'playing';
  end if;

  v_hands := jsonb_set(
    v_hands,
    array[v_uid::text],
    v_my_hand || jsonb_build_object(
      'cards',   v_cards,
      'total',   (v_eval ->> 'total')::int,
      'is_soft', (v_eval ->> 'is_soft')::boolean,
      'status',  v_status
    )
  );

  -- If the player busted or reached 21, advance to the next player (or dealer settlement).
  if v_status <> 'playing' then
    return public.bj_advance_or_settle(p_room_id, v_round, v_hands, v_last_action);
  end if;

  -- Player still has < 21 -> remains their turn with a fresh 15-second deadline!
  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         turn_user_id  = v_uid,
         turn_deadline = v_deadline,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'shoe_remaining', jsonb_array_length(v_shoe),
           'hands',          v_hands,
           'last_action',    v_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'playing',
    'turn_user_id',  v_uid,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- ---------- 9. Upgrade `claim_turn_timeout` with full Blackjack integration ---
create or replace function public.claim_turn_timeout(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_caller      uuid := (select auth.uid());
  v_room        public.rooms;
  v_gs          public.game_states;
  v_timed_u     uuid;
  v_neutral     text;
  v_next        uuid;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_phase       text;
  v_round       int;
  v_hands       jsonb;
  v_timed_hand  jsonb;
  v_last_action jsonb;
begin
  if v_caller is not null and not public.is_room_member(p_room_id) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  if v_gs.turn_user_id is null or v_gs.turn_deadline is null or now() < v_gs.turn_deadline then
    return jsonb_build_object(
      'expired',       false,
      'version',       v_gs.version,
      'turn_user_id',  v_gs.turn_user_id,
      'turn_deadline', v_gs.turn_deadline,
      'server_now',    now()
    );
  end if;

  v_timed_u := v_gs.turn_user_id;

  -- 1) Mark the timed-out player AFK so they cannot delay the room.
  perform public.force_afk(p_room_id, v_timed_u);

  -- 2) Blackjack-specific state machine timeout handling:
  if v_room.game_type = 'blackjack' and v_gs.phase in ('betting', 'playing') then
    v_round      := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_hands      := coalesce(v_gs.state -> 'hands', '{}'::jsonb);
    v_timed_hand := v_hands -> v_timed_u::text;

    if v_gs.phase = 'betting' then
      if v_timed_hand is not null then
        v_hands := jsonb_set(
          v_hands,
          array[v_timed_u::text],
          v_timed_hand || jsonb_build_object('status', 'skipped_afk')
        );
      end if;

      v_last_action := jsonb_build_object(
        'type',              'skip_bet',
        'user_id',           v_timed_u,
        'forced_by_timeout', true,
        'at',                now()
      );

      select (value ->> 'user_id')::uuid into v_next
        from jsonb_each(v_hands)
       where value ->> 'status' = 'betting'
       order by coalesce((value ->> 'seat')::int, 0) asc
       limit 1;

      if v_next is not null then
        v_deadline := now() + make_interval(secs => v_timeout);
        update public.game_states
           set version       = v_gs.version + 1,
               turn_user_id  = v_next,
               turn_deadline = v_deadline,
               state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
                 'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
                 'hands',       v_hands,
                 'last_action', v_last_action
               )
         where room_id = p_room_id;

        return jsonb_build_object(
          'expired',        true,
          'timed_out_user', v_timed_u,
          'forced_action',  'skip_bet',
          'version',        v_gs.version + 1,
          'turn_user_id',   v_next,
          'turn_deadline',  v_deadline,
          'server_now',     now()
        );
      end if;

      -- All remaining players have bet (or were skipped) -> deal cards or return to lobby!
      return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet')
             || public.bj_deal_initial_cards(p_room_id, v_round, v_hands, v_last_action);
    end if;

    -- v_gs.phase = 'playing': force neutral action 'stand' on the timed-out player's hand!
    if v_timed_hand is not null then
      v_hands := jsonb_set(
        v_hands,
        array[v_timed_u::text],
        v_timed_hand || jsonb_build_object('status', 'stood')
      );
    end if;

    v_last_action := jsonb_build_object(
      'type',              'stand',
      'user_id',           v_timed_u,
      'forced_by_timeout', true,
      'at',                now()
    );

    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'stand')
           || public.bj_advance_or_settle(p_room_id, v_round, v_hands, v_last_action);
  end if;

  -- 3) Generic turn cycle fallback for non-Blackjack rooms:
  v_neutral := case v_room.game_type
    when 'poker'     then 'check_fold'
    when 'blackjack' then 'stand'
    else                  'skip'
  end;

  v_next := public.next_active_room_user(p_room_id, v_timed_u);
  if v_next is not null then
    v_deadline := now() + make_interval(secs => v_timeout);
    v_phase := v_gs.phase;
  else
    v_deadline := null;
    v_phase := 'awaiting_players';
  end if;

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = v_phase,
         turn_user_id  = v_next,
         turn_deadline = v_deadline,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'last_action', jsonb_build_object(
             'type',              v_neutral,
             'user_id',           v_timed_u,
             'forced_by_timeout', true,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'expired',        true,
    'timed_out_user', v_timed_u,
    'forced_action',  v_neutral,
    'version',        v_gs.version + 1,
    'turn_user_id',   v_next,
    'turn_deadline',  v_deadline,
    'server_now',     now()
  );
end;
$$;

-- ---------- 10. Grants --------------------------------------------------------
grant execute on function
  public.bj_hand_eval(jsonb),
  public.blackjack_start_round(uuid),
  public.blackjack_place_bet(uuid, bigint),
  public.blackjack_action(uuid, text),
  public.claim_turn_timeout(uuid)
  to authenticated, service_role;

grant execute on function
  public.bj_build_shoe(int),
  public.bj_settle_round(uuid, int, jsonb, jsonb, jsonb, jsonb),
  public.bj_advance_or_settle(uuid, int, jsonb, jsonb),
  public.bj_deal_initial_cards(uuid, int, jsonb, jsonb)
  to service_role;



-- =============================================================================
-- FILE: 20261030000012_roulette_slots_engine.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 8 / Migration 12 â€” Inflation Control Games:
--   1. Classic European Single-Zero Roulette (97.30% RTP / 2.70% House Edge)
--   2. Strict Vintage 3-Reel Mechanical Slots (94.53% RTP / 5.47% House Edge)
-- =============================================================================
-- Security & Anti-Cheat guarantees:
--   * Both games are enabled in `public.game_catalog`.
--   * All random outcomes (European wheel pocket 0..36 and 3Ã—20-stop reel spins)
--     are drawn server-side using CSPRNG (`gen_random_uuid()` byte extraction
--     with rejection sampling so there is zero modulo bias).
--   * All bets and payouts are recorded atomically in the append-only wallet
--     ledger via `public.apply_balance_delta()` with deterministic idempotency keys.
-- =============================================================================

-- ---------- 1. Enable Roulette & Slots in `game_catalog` ---------------------
update public.game_catalog
   set is_enabled = true
 where slug in ('roulette', 'slots');

-- ---------- 2. Unbiased CSPRNG Integer Helper (`csprng_int`) -----------------
-- Returns a uniformly distributed random integer in `[0, p_max_exclusive - 1]`
-- using rejection sampling over random UUID bytes (zero modulo bias).
create or replace function public.csprng_int(p_max_exclusive int)
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_limit int;
  v_bytes bytea;
  v_b     int;
  i       int;
begin
  if p_max_exclusive is null or p_max_exclusive <= 1 then
    return 0;
  end if;
  if p_max_exclusive > 256 then
    raise exception 'csprng_range_unsupported';
  end if;

  v_limit := (256 / p_max_exclusive) * p_max_exclusive;

  loop
    v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    for i in 0..15 loop
      v_b := get_byte(v_bytes, i);
      if v_b < v_limit then
        return v_b % p_max_exclusive;
      end if;
    end loop;
  end loop;
end;
$$;

-- =============================================================================
-- PART A: EUROPEAN SINGLE-ZERO ROULETTE (37 pockets, 97.30% RTP)
-- =============================================================================

create or replace function public.roulette_number_color(p_num int)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_num = 0 then 'green'
    when p_num in (1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36) then 'red'
    else 'black'
  end;
$$;

-- Returns the total return multiplier (including stake) for a single Roulette bet
-- when `p_win_num` (0..36) hits, or 0 if the bet lost.
-- Every bet type has expected return = 36/37 â‰ˆ 97.297% (2.703% House Edge).
create or replace function public.roulette_bet_multiplier(
  p_kind    text,
  p_target  int,
  p_win_num int
)
returns int
language plpgsql immutable
set search_path = ''
as $$
declare
  v_color text := public.roulette_number_color(p_win_num);
begin
  case p_kind
    when 'straight' then
      return case when p_target = p_win_num then 36 else 0 end;
    when 'red' then
      return case when v_color = 'red' then 2 else 0 end;
    when 'black' then
      return case when v_color = 'black' then 2 else 0 end;
    when 'even' then
      return case when p_win_num > 0 and (p_win_num % 2) = 0 then 2 else 0 end;
    when 'odd' then
      return case when p_win_num > 0 and (p_win_num % 2) = 1 then 2 else 0 end;
    when 'low' then
      return case when p_win_num between 1 and 18 then 2 else 0 end;
    when 'high' then
      return case when p_win_num between 19 and 36 then 2 else 0 end;
    when 'dozen_1' then
      return case when p_win_num between 1 and 12 then 3 else 0 end;
    when 'dozen_2' then
      return case when p_win_num between 13 and 24 then 3 else 0 end;
    when 'dozen_3' then
      return case when p_win_num between 25 and 36 then 3 else 0 end;
    when 'col_1' then
      return case when p_win_num > 0 and (p_win_num % 3) = 1 then 3 else 0 end;
    when 'col_2' then
      return case when p_win_num > 0 and (p_win_num % 3) = 2 then 3 else 0 end;
    when 'col_3' then
      return case when p_win_num > 0 and (p_win_num % 3) = 0 then 3 else 0 end;
    else
      return 0;
  end case;
end;
$$;

-- Internal: Execute the wheel spin once all active players have placed their bets
-- (or timed out). Settles all winning wagers atomically via `apply_balance_delta`.
create or replace function public.roulette_execute_spin(
  p_room_id     uuid,
  p_round       int,
  p_tickets     jsonb,
  p_last_action jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs              public.game_states;
  v_room            public.rooms;
  v_any_bet         boolean := false;
  v_win_num         int;
  v_win_color       text;
  v_uid_text        text;
  v_ticket          jsonb;
  v_bet_item        jsonb;
  v_evaluated_bets  jsonb;
  v_settled_tickets jsonb := '{}'::jsonb;
  v_total_wager     bigint;
  v_total_payout    bigint;
  v_item_amt        bigint;
  v_mult            int;
  v_item_payout     bigint;
  v_history         jsonb;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  select * into v_gs from public.game_states where room_id = p_room_id for update;

  for v_uid_text, v_ticket in select key, value from jsonb_each(coalesce(p_tickets, '{}'::jsonb))
  loop
    if coalesce((v_ticket ->> 'total_bet')::bigint, 0) > 0 then
      v_any_bet := true;
    end if;
  end loop;

  if not v_any_bet then
    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'lobby',
           turn_user_id  = null,
           turn_deadline = null,
           state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
             'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
             'tickets',     p_tickets,
             'last_action', p_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object(
      'room_id',    p_room_id,
      'version',    v_gs.version + 1,
      'phase',      'lobby',
      'server_now', now()
    );
  end if;

  -- Draw winning pocket 0..36 with zero modulo bias.
  v_win_num   := public.csprng_int(37);
  v_win_color := public.roulette_number_color(v_win_num);

  -- Evaluate each player's bet slip and credit payouts via `apply_balance_delta`.
  for v_uid_text, v_ticket in select key, value from jsonb_each(coalesce(p_tickets, '{}'::jsonb))
  loop
    v_total_wager    := coalesce((v_ticket ->> 'total_bet')::bigint, 0);
    v_total_payout   := 0;
    v_evaluated_bets := '[]'::jsonb;

    if v_total_wager > 0 then
      for v_bet_item in select value from jsonb_array_elements(coalesce(v_ticket -> 'bets', '[]'::jsonb))
      loop
        v_item_amt := coalesce((v_bet_item ->> 'amount')::bigint, 0);
        v_mult := public.roulette_bet_multiplier(
          v_bet_item ->> 'kind',
          (v_bet_item ->> 'number')::int,
          v_win_num
        );
        v_item_payout := v_item_amt * v_mult;
        v_total_payout := v_total_payout + v_item_payout;

        v_evaluated_bets := v_evaluated_bets || jsonb_build_array(
          v_bet_item || jsonb_build_object(
            'multiplier', v_mult,
            'payout',     v_item_payout,
            'won',        (v_item_payout > 0)
          )
        );
      end loop;

      if v_total_payout > 0 then
        perform public.apply_balance_delta(
          v_uid_text::uuid,
          v_total_payout,
          'game_win',
          jsonb_build_object(
            'game',           'roulette',
            'room_id',        p_room_id,
            'round',          p_round,
            'winning_number', v_win_num,
            'winning_color',  v_win_color,
            'total_bet',      v_total_wager,
            'payout',         v_total_payout
          ),
          p_room_id,
          format('rl:%s:r%s:%s:settle', p_room_id, p_round, v_uid_text)
        );
      end if;
    end if;

    v_settled_tickets := v_settled_tickets || jsonb_build_object(
      v_uid_text,
      v_ticket || jsonb_build_object(
        'bets',   v_evaluated_bets,
        'payout', v_total_payout,
        'net',    v_total_payout - v_total_wager
      )
    );
  end loop;

  -- Prepend winning number to history (keep last 12 spins).
  v_history := jsonb_build_array(
    jsonb_build_object('number', v_win_num, 'color', v_win_color, 'round', p_round)
  );
  if jsonb_typeof(v_gs.state -> 'history') = 'array' then
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_history
      from (
        select value as elem
          from jsonb_array_elements(v_history || (v_gs.state -> 'history'))
         limit 12
      ) sub;
  end if;

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'settled',
         turn_user_id  = null,
         turn_deadline = null,
         state         = jsonb_build_object(
           'round_number',   p_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        greatest(v_room.min_bet, 50),
           'winning_number', v_win_num,
           'winning_color',  v_win_color,
           'history',        v_history,
           'tickets',        v_settled_tickets,
           'last_action',    p_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',        p_room_id,
    'version',        v_gs.version + 1,
    'phase',          'settled',
    'winning_number', v_win_num,
    'winning_color',  v_win_color,
    'server_now',     now()
  );
end;
$$;

-- Public RPC: Open a 15-second Roulette betting phase for all seated players.
create or replace function public.roulette_start_round(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.require_uid();
  v_room     public.rooms;
  v_gs       public.game_states;
  v_round    int;
  v_tickets  jsonb := '{}'::jsonb;
  v_seat     record;
  v_first    uuid;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'roulette' then
    raise exception 'room_not_found';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = v_uid
  ) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if v_gs.phase not in ('lobby', 'settled', 'awaiting_players') then
    raise exception 'round_already_active';
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;

  for v_seat in
    select user_id, seat
      from public.room_players
     where room_id = p_room_id and status = 'active'
     order by seat asc
  loop
    if v_first is null then
      v_first := v_seat.user_id;
    end if;
    v_tickets := v_tickets || jsonb_build_object(
      v_seat.user_id::text,
      jsonb_build_object(
        'user_id',   v_seat.user_id,
        'seat',      v_seat.seat,
        'status',    'betting',
        'total_bet', 0,
        'bets',      '[]'::jsonb,
        'payout',    0,
        'net',       0
      )
    );
  end loop;

  if v_first is null then
    raise exception 'no_active_players';
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'betting',
         turn_user_id  = v_first,
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',   v_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        greatest(v_room.min_bet, 50),
           'winning_number', v_gs.state -> 'winning_number',
           'winning_color',  v_gs.state -> 'winning_color',
           'history',        coalesce(v_gs.state -> 'history', '[]'::jsonb),
           'tickets',        v_tickets,
           'last_action',    jsonb_build_object(
             'type',              'betting_opened',
             'user_id',           v_uid,
             'forced_by_timeout', false,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'betting',
    'turn_user_id',  v_first,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- Public RPC: Place Roulette Bets & Spin Wheel (`roulette_place_bets`)
-- Accepts an array of bets: `[{"kind": "straight", "number": 17, "amount": 100}, {"kind": "red", "amount": 250}]`.
-- Can be called in `'lobby'`/`'settled'` (starts round & spins immediately if solo) or during `'betting'`.
create or replace function public.roulette_place_bets(
  p_room_id uuid,
  p_bets    jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_uid();
  v_room        public.rooms;
  v_gs          public.game_states;
  v_min_bet     bigint;
  v_round       int;
  v_tickets     jsonb;
  v_my_ticket   jsonb;
  v_my_seat     smallint;
  v_clean_bets  jsonb := '[]'::jsonb;
  v_total_bet   bigint := 0;
  v_item        jsonb;
  v_kind        text;
  v_num         int;
  v_amt         bigint;
  v_next_bettor uuid;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_last_action jsonb;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'roulette' then
    raise exception 'room_not_found';
  end if;

  select seat into v_my_seat
    from public.room_players
   where room_id = p_room_id and user_id = v_uid;
  if not found then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  if p_bets is null or jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) not between 1 and 40 then
    raise exception 'invalid_bet_amount';
  end if;

  -- Validate every individual bet entry on the slip.
  for v_item in select value from jsonb_array_elements(p_bets)
  loop
    v_kind := lower(trim(coalesce(v_item ->> 'kind', '')));
    v_amt  := coalesce((v_item ->> 'amount')::bigint, 0);
    if v_amt <= 0 or v_amt > 1000000 then
      raise exception 'invalid_bet_amount';
    end if;

    if v_kind = 'straight' then
      v_num := (v_item ->> 'number')::int;
      if v_num is null or v_num not between 0 and 36 then
        raise exception 'invalid_action';
      end if;
      v_clean_bets := v_clean_bets || jsonb_build_array(
        jsonb_build_object('kind', 'straight', 'number', v_num, 'amount', v_amt)
      );
    elsif v_kind in (
      'red', 'black', 'even', 'odd', 'low', 'high',
      'dozen_1', 'dozen_2', 'dozen_3', 'col_1', 'col_2', 'col_3'
    ) then
      v_clean_bets := v_clean_bets || jsonb_build_array(
        jsonb_build_object('kind', v_kind, 'number', null, 'amount', v_amt)
      );
    else
      raise exception 'invalid_action';
    end if;

    v_total_bet := v_total_bet + v_amt;
  end loop;

  v_min_bet := greatest(v_room.min_bet, 50);
  if v_total_bet < v_min_bet or v_total_bet > 1000000 then
    raise exception 'invalid_bet_amount';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;

  if v_gs.phase in ('lobby', 'settled', 'awaiting_players') then
    update public.room_players
       set status = 'active', afk_since = null, last_seen_at = now()
     where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

    v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;

    select jsonb_object_agg(
      rp.user_id::text,
      jsonb_build_object(
        'user_id',   rp.user_id,
        'seat',      rp.seat,
        'status',    'betting',
        'total_bet', 0,
        'bets',      '[]'::jsonb,
        'payout',    0,
        'net',       0
      )
    ) into v_tickets
    from public.room_players rp
    where rp.room_id = p_room_id and rp.status = 'active';

    update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';
  elsif v_gs.phase = 'betting' then
    if v_gs.turn_user_id is not null
       and v_gs.turn_user_id is distinct from v_uid
       and v_gs.turn_deadline is not null
       and now() > v_gs.turn_deadline
    then
      perform public.claim_turn_timeout(p_room_id);
      select * into v_gs from public.game_states where room_id = p_room_id for update;
      if v_gs.phase <> 'betting' then
        return jsonb_build_object('room_id', p_room_id, 'phase', v_gs.phase, 'version', v_gs.version);
      end if;
    end if;

    v_round   := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_tickets := coalesce(v_gs.state -> 'tickets', '{}'::jsonb);

    update public.room_players
       set status = 'active', afk_since = null, last_seen_at = now()
     where room_id = p_room_id and user_id = v_uid;

    if not (v_tickets ? v_uid::text) then
      v_tickets := v_tickets || jsonb_build_object(
        v_uid::text,
        jsonb_build_object(
          'user_id',   v_uid,
          'seat',      v_my_seat,
          'status',    'betting',
          'total_bet', 0,
          'bets',      '[]'::jsonb,
          'payout',    0,
          'net',       0
        )
      );
    end if;
  else
    raise exception 'round_already_active';
  end if;

  v_my_ticket := v_tickets -> v_uid::text;
  if v_my_ticket is null or coalesce(v_my_ticket ->> 'status', '') not in ('betting', 'skipped_afk') then
    raise exception 'bet_already_placed';
  end if;

  -- Deduct the total Roulette bet slip atomically via `apply_balance_delta`.
  perform public.apply_balance_delta(
    v_uid,
    -v_total_bet,
    'game_bet',
    jsonb_build_object(
      'game',      'roulette',
      'room_id',   p_room_id,
      'round',     v_round,
      'total_bet', v_total_bet,
      'bet_count', jsonb_array_length(v_clean_bets)
    ),
    p_room_id,
    format('rl:%s:r%s:%s:bet', p_room_id, v_round, v_uid)
  );

  v_tickets := jsonb_set(
    v_tickets,
    array[v_uid::text],
    v_my_ticket || jsonb_build_object(
      'status',    'bet_placed',
      'total_bet', v_total_bet,
      'bets',      v_clean_bets
    )
  );

  v_last_action := jsonb_build_object(
    'type',              'spin_bet',
    'user_id',           v_uid,
    'payload',           jsonb_build_object('total_bet', v_total_bet),
    'forced_by_timeout', false,
    'at',                now()
  );

  -- Check if any other active player at the table still has `status = 'betting'`.
  select (value ->> 'user_id')::uuid into v_next_bettor
    from jsonb_each(v_tickets)
   where value ->> 'status' = 'betting'
   order by coalesce((value ->> 'seat')::int, 0) asc
   limit 1;

  if v_next_bettor is null then
    -- All active players have locked in their bets -> spin the wheel immediately!
    return public.roulette_execute_spin(p_room_id, v_round, v_tickets, v_last_action);
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'betting',
         turn_user_id  = v_next_bettor,
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',   v_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',        v_min_bet,
           'winning_number', v_gs.state -> 'winning_number',
           'winning_color',  v_gs.state -> 'winning_color',
           'history',        coalesce(v_gs.state -> 'history', '[]'::jsonb),
           'tickets',        v_tickets,
           'last_action',    v_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'betting',
    'turn_user_id',  v_next_bettor,
    'turn_deadline', v_deadline,
    'server_now',    now()
  );
end;
$$;

-- =============================================================================
-- PART B: STRICT VINTAGE 3-REEL MECHANICAL SLOTS (94.53% RTP / 5.47% House Edge)
-- =============================================================================
-- Each of the 3 reels has 20 weighted stops (20^3 = 8,000 equiprobable combinations):
--    Stop  0        (1 stop)  -> 'crown'   (Imperial Crown)    3x = 250x (1 * 250   = 250)
--    Stops 1..2     (2 stops) -> 'seven'   (Gold Seven)        3x = 80x  (8 * 80    = 640)
--    Stops 3..5     (3 stops) -> 'diamond' (Burgundy Diamond)  3x = 35x  (27 * 35   = 945)
--    Stops 6..9     (4 stops) -> 'bell'    (Liberty Bell)      3x = 18x  (64 * 18   = 1152)
--    Stops 10..14   (5 stops) -> 'bar'     (Bullion BAR)       3x = 10x  (125 * 10  = 1250)
--    Stops 15..19   (5 stops) -> 'cherry'  (Vintage Cherry)    3x = 8x   (125 * 8   = 1000)
--    Any 2 Cherries                        (3 * 25 * 15 = 1125)   = 2x   (1125 * 2  = 2250)
--    Reel 1 Cherry only                    (5 * 15 * 15 = 1125)   = 1x   (1125 * 1  = 1125)
-- Total Expected Return = 7,562 / 8,000 = 94.525% RTP (5.475% House Edge).

create or replace function public.slots_stop_symbol(p_stop int)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_stop = 0 then 'crown'
    when p_stop between 1 and 2 then 'seven'
    when p_stop between 3 and 5 then 'diamond'
    when p_stop between 6 and 9 then 'bell'
    when p_stop between 10 and 14 then 'bar'
    else 'cherry'
  end;
$$;

create or replace function public.slots_spin(
  p_room_id uuid,
  p_bet     bigint
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid        uuid := public.require_uid();
  v_room       public.rooms;
  v_gs         public.game_states;
  v_min_bet    bigint;
  v_round      int;
  v_stop1      int;
  v_stop2      int;
  v_stop3      int;
  v_sym1       text;
  v_sym2       text;
  v_sym3       text;
  v_cherries   int := 0;
  v_multiplier int := 0;
  v_tier       text := 'no_win';
  v_payout     bigint := 0;
  v_net        bigint;
  v_history    jsonb;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'slots' then
    raise exception 'room_not_found';
  end if;

  if not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = v_uid
  ) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  v_min_bet := greatest(v_room.min_bet, 50);
  if p_bet is null or p_bet < v_min_bet or p_bet > 100000 then
    raise exception 'invalid_bet_amount';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;

  -- 1) Deduct the spin wager atomically via `apply_balance_delta`.
  perform public.apply_balance_delta(
    v_uid,
    -p_bet,
    'game_bet',
    jsonb_build_object(
      'game',    'slots',
      'room_id', p_room_id,
      'round',   v_round,
      'bet',     p_bet
    ),
    p_room_id,
    format('sl:%s:r%s:%s:bet', p_room_id, v_round, v_uid)
  );

  -- 2) Draw 3 independent CSPRNG reel stops in 0..19 (zero modulo bias).
  v_stop1 := public.csprng_int(20);
  v_stop2 := public.csprng_int(20);
  v_stop3 := public.csprng_int(20);

  v_sym1 := public.slots_stop_symbol(v_stop1);
  v_sym2 := public.slots_stop_symbol(v_stop2);
  v_sym3 := public.slots_stop_symbol(v_stop3);

  -- 3) Evaluate paytable (94.53% RTP).
  if v_sym1 = v_sym2 and v_sym2 = v_sym3 then
    case v_sym1
      when 'crown'   then v_multiplier := 250; v_tier := 'grand_jackpot';
      when 'seven'   then v_multiplier := 80;  v_tier := 'triple_seven';
      when 'diamond' then v_multiplier := 35;  v_tier := 'triple_diamond';
      when 'bell'    then v_multiplier := 18;  v_tier := 'triple_bell';
      when 'bar'     then v_multiplier := 10;  v_tier := 'triple_bar';
      when 'cherry'  then v_multiplier := 8;   v_tier := 'triple_cherry';
    end case;
  else
    if v_sym1 = 'cherry' then v_cherries := v_cherries + 1; end if;
    if v_sym2 = 'cherry' then v_cherries := v_cherries + 1; end if;
    if v_sym3 = 'cherry' then v_cherries := v_cherries + 1; end if;

    if v_cherries = 2 then
      v_multiplier := 2;
      v_tier       := 'double_cherry';
    elsif v_sym1 = 'cherry' then
      v_multiplier := 1;
      v_tier       := 'single_cherry';
    end if;
  end if;

  v_payout := p_bet * v_multiplier;
  v_net    := v_payout - p_bet;

  -- 4) Credit any winning payout atomically via `apply_balance_delta`.
  if v_payout > 0 then
    perform public.apply_balance_delta(
      v_uid,
      v_payout,
      case when v_multiplier = 1 then 'game_refund' else 'game_win' end,
      jsonb_build_object(
        'game',       'slots',
        'room_id',    p_room_id,
        'round',      v_round,
        'reels',      jsonb_build_array(v_sym1, v_sym2, v_sym3),
        'tier',       v_tier,
        'multiplier', v_multiplier,
        'bet',        p_bet,
        'payout',     v_payout
      ),
      p_room_id,
      format('sl:%s:r%s:%s:settle', p_room_id, v_round, v_uid)
    );
  end if;

  -- Keep last 10 spins in history.
  v_history := jsonb_build_array(
    jsonb_build_object(
      'round',      v_round,
      'reels',      jsonb_build_array(v_sym1, v_sym2, v_sym3),
      'bet',        p_bet,
      'multiplier', v_multiplier,
      'payout',     v_payout,
      'net',        v_net,
      'tier',       v_tier
    )
  );
  if jsonb_typeof(v_gs.state -> 'history') = 'array' then
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
      into v_history
      from (
        select value as elem
          from jsonb_array_elements(v_history || (v_gs.state -> 'history'))
         limit 10
      ) sub;
  end if;

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'settled',
         turn_user_id  = null,
         turn_deadline = null,
         state         = jsonb_build_object(
           'round_number', v_round,
           'turn_number',  coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'min_bet',      v_min_bet,
           'rtp_percent',  94.53,
           'reels',        jsonb_build_array(v_sym1, v_sym2, v_sym3),
           'stops',        jsonb_build_array(v_stop1, v_stop2, v_stop3),
           'bet',          p_bet,
           'multiplier',   v_multiplier,
           'payout',       v_payout,
           'net',          v_net,
           'tier',         v_tier,
           'history',      v_history,
           'last_action',  jsonb_build_object(
             'type',              'slot_spin',
             'user_id',           v_uid,
             'payload',           jsonb_build_object('bet', p_bet, 'multiplier', v_multiplier, 'payout', v_payout),
             'forced_by_timeout', false,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',    p_room_id,
    'version',    v_gs.version + 1,
    'round',      v_round,
    'reels',      jsonb_build_array(v_sym1, v_sym2, v_sym3),
    'multiplier', v_multiplier,
    'payout',     v_payout,
    'net',        v_net,
    'tier',       v_tier,
    'server_now', now()
  );
end;
$$;

-- =============================================================================
-- PART C: UPGRADE `claim_turn_timeout` TO INCLUDE ROULETTE BETTING TIMEOUTS
-- =============================================================================
create or replace function public.claim_turn_timeout(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_caller      uuid := (select auth.uid());
  v_room        public.rooms;
  v_gs          public.game_states;
  v_timed_u     uuid;
  v_neutral     text;
  v_next        uuid;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_phase       text;
  v_round       int;
  v_hands       jsonb;
  v_timed_hand  jsonb;
  v_tickets     jsonb;
  v_timed_tkt   jsonb;
  v_last_action jsonb;
begin
  if v_caller is not null and not public.is_room_member(p_room_id) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  if v_gs.turn_user_id is null or v_gs.turn_deadline is null or now() < v_gs.turn_deadline then
    return jsonb_build_object(
      'expired',       false,
      'version',       v_gs.version,
      'turn_user_id',  v_gs.turn_user_id,
      'turn_deadline', v_gs.turn_deadline,
      'server_now',    now()
    );
  end if;

  v_timed_u := v_gs.turn_user_id;

  -- 1) Mark the timed-out player AFK so they cannot delay the room.
  perform public.force_afk(p_room_id, v_timed_u);

  -- 2) Blackjack timeout handling:
  if v_room.game_type = 'blackjack' and v_gs.phase in ('betting', 'playing') then
    v_round      := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_hands      := coalesce(v_gs.state -> 'hands', '{}'::jsonb);
    v_timed_hand := v_hands -> v_timed_u::text;

    if v_gs.phase = 'betting' then
      if v_timed_hand is not null then
        v_hands := jsonb_set(
          v_hands,
          array[v_timed_u::text],
          v_timed_hand || jsonb_build_object('status', 'skipped_afk')
        );
      end if;

      v_last_action := jsonb_build_object(
        'type',              'skip_bet',
        'user_id',           v_timed_u,
        'forced_by_timeout', true,
        'at',                now()
      );

      select (value ->> 'user_id')::uuid into v_next
        from jsonb_each(v_hands)
       where value ->> 'status' = 'betting'
       order by coalesce((value ->> 'seat')::int, 0) asc
       limit 1;

      if v_next is not null then
        v_deadline := now() + make_interval(secs => v_timeout);
        update public.game_states
           set version       = v_gs.version + 1,
               turn_user_id  = v_next,
               turn_deadline = v_deadline,
               state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
                 'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
                 'hands',       v_hands,
                 'last_action', v_last_action
               )
         where room_id = p_room_id;

        return jsonb_build_object(
          'expired',        true,
          'timed_out_user', v_timed_u,
          'forced_action',  'skip_bet',
          'version',        v_gs.version + 1,
          'turn_user_id',   v_next,
          'turn_deadline',  v_deadline,
          'server_now',     now()
        );
      end if;

      return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet')
             || public.bj_deal_initial_cards(p_room_id, v_round, v_hands, v_last_action);
    end if;

    if v_timed_hand is not null then
      v_hands := jsonb_set(
        v_hands,
        array[v_timed_u::text],
        v_timed_hand || jsonb_build_object('status', 'stood')
      );
    end if;

    v_last_action := jsonb_build_object(
      'type',              'stand',
      'user_id',           v_timed_u,
      'forced_by_timeout', true,
      'at',                now()
    );

    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'stand')
           || public.bj_advance_or_settle(p_room_id, v_round, v_hands, v_last_action);
  end if;

  -- 3) Roulette betting timeout handling:
  if v_room.game_type = 'roulette' and v_gs.phase = 'betting' then
    v_round     := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_tickets   := coalesce(v_gs.state -> 'tickets', '{}'::jsonb);
    v_timed_tkt := v_tickets -> v_timed_u::text;

    if v_timed_tkt is not null then
      v_tickets := jsonb_set(
        v_tickets,
        array[v_timed_u::text],
        v_timed_tkt || jsonb_build_object('status', 'skipped_afk')
      );
    end if;

    v_last_action := jsonb_build_object(
      'type',              'skip_bet',
      'user_id',           v_timed_u,
      'forced_by_timeout', true,
      'at',                now()
    );

    select (value ->> 'user_id')::uuid into v_next
      from jsonb_each(v_tickets)
     where value ->> 'status' = 'betting'
     order by coalesce((value ->> 'seat')::int, 0) asc
     limit 1;

    if v_next is not null then
      v_deadline := now() + make_interval(secs => v_timeout);
      update public.game_states
         set version       = v_gs.version + 1,
             turn_user_id  = v_next,
             turn_deadline = v_deadline,
             state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
               'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
               'tickets',     v_tickets,
               'last_action', v_last_action
             )
       where room_id = p_room_id;

      return jsonb_build_object(
        'expired',        true,
        'timed_out_user', v_timed_u,
        'forced_action',  'skip_bet',
        'version',        v_gs.version + 1,
        'turn_user_id',   v_next,
        'turn_deadline',  v_deadline,
        'server_now',     now()
      );
    end if;

    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet')
           || public.roulette_execute_spin(p_room_id, v_round, v_tickets, v_last_action);
  end if;

  -- 4) Generic fallback for other room types:
  v_neutral := case v_room.game_type
    when 'poker'     then 'check_fold'
    when 'blackjack' then 'stand'
    else                  'skip'
  end;

  v_next := public.next_active_room_user(p_room_id, v_timed_u);
  if v_next is not null then
    v_deadline := now() + make_interval(secs => v_timeout);
    v_phase := v_gs.phase;
  else
    v_deadline := null;
    v_phase := 'awaiting_players';
  end if;

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = v_phase,
         turn_user_id  = v_next,
         turn_deadline = v_deadline,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'last_action', jsonb_build_object(
             'type',              v_neutral,
             'user_id',           v_timed_u,
             'forced_by_timeout', true,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'expired',        true,
    'timed_out_user', v_timed_u,
    'forced_action',  v_neutral,
    'version',        v_gs.version + 1,
    'turn_user_id',   v_next,
    'turn_deadline',  v_deadline,
    'server_now',     now()
  );
end;
$$;

-- ---------- Grants ------------------------------------------------------------
grant execute on function
  public.roulette_number_color(int),
  public.roulette_bet_multiplier(text, int, int),
  public.roulette_start_round(uuid),
  public.roulette_place_bets(uuid, jsonb),
  public.slots_stop_symbol(int),
  public.slots_spin(uuid, bigint),
  public.claim_turn_timeout(uuid)
  to authenticated, service_role;

grant execute on function
  public.csprng_int(int),
  public.roulette_execute_spin(uuid, int, jsonb, jsonb)
  to service_role;



-- =============================================================================
-- FILE: 20261030000013_scaling_games_engine.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Step 9 / Migration 13 â€” Scaling Games Engine:
--   1. Texas Hold'em Poker (`poker`, 2â€“9 players, private hole cards in `game_private_states`)
--   2. Classic 36-Card Durak (`durak`, 2â€“6 players, private hands in `game_private_states`)
--   3. Classic Chess (`chess`, 2 players, server-validated piece movement & king capture)
--   4. Classic Checkers (`checkers`, 2 players, server-validated jumps, crowning & multi-jumps)
-- =============================================================================
-- Security & Anti-Cheat guarantees:
--   * Enables `poker`, `durak`, `chess`, and `checkers` in `public.game_catalog`.
--   * Private cards (`hole_cards` in Poker and `hand` in Durak) live strictly in
--     `public.game_private_states` (RLS: owner SELECT only), while the unrevealed
--     deck/talon lives in `public.game_server_secrets` (no client policies).
--   * All blinds, stakes, bets, calls, raises, and payouts execute server-side
--     via `public.apply_balance_delta()` with deterministic idempotency keys.
--   * `public.claim_turn_timeout()` enforces the 15-second turn clock across all
--     4 games (Check/Fold in Poker, Pass/Take in Durak, Timeout Forfeit in Chess/Checkers)
--     and marks the timed-out player AFK (`status = 'afk'`).
-- =============================================================================

-- ---------- 1. Enable all remaining games in `game_catalog` ------------------
update public.game_catalog
   set is_enabled = true
 where slug in ('poker', 'durak', 'chess', 'checkers');

-- ---------- 2. Card Rank Numeric Value Helper (`card_rank_val`) --------------
create or replace function public.card_rank_val(p_rank text)
returns int
language sql immutable
set search_path = ''
as $$
  select case p_rank
    when 'A'  then 14
    when 'K'  then 13
    when 'Q'  then 12
    when 'J'  then 11
    when '10' then 10
    else coalesce(p_rank::int, 2)
  end;
$$;

-- =============================================================================
-- PART A: TEXAS HOLD'EM POKER (`poker`, 2â€“9 Players)
-- =============================================================================

-- Evaluates a 5-to-7 card Texas Hold'em hand and returns `{score: bigint, label: text}`.
-- Higher `score` always beats lower `score`; equal `score` is an exact tie (split pot).
create or replace function public.poker_eval_7(p_cards jsonb)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_ranks        int[];
  v_flush_suit   text;
  v_flush_ranks  int[];
  v_uniq_ranks   int[];
  v_str_high     int := 0;
  v_sf_high      int := 0;
  v_quads        int[];
  v_trips        int[];
  v_pairs        int[];
  v_singles      int[];
  v_k1           int := 0;
  v_k2           int := 0;
  v_k3           int := 0;
  v_k4           int := 0;
  v_k5           int := 0;
  v_cat          int := 0;
  v_label        text := 'High Card';
  v_score        bigint;
  i              int;
begin
  -- All card rank values sorted descending.
  select coalesce(array_agg(public.card_rank_val(value ->> 'rank') order by public.card_rank_val(value ->> 'rank') desc), array[]::int[])
    into v_ranks
    from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb));

  -- Distinct rank values descending (for straight detection).
  select coalesce(array_agg(r order by r desc), array[]::int[])
    into v_uniq_ranks
    from (select distinct unnest(v_ranks) as r) u;

  if 14 = any(v_uniq_ranks) then
    v_uniq_ranks := array_append(v_uniq_ranks, 1); -- Ace-low wheel straight (A-2-3-4-5)
  end if;

  if coalesce(array_length(v_uniq_ranks, 1), 0) >= 5 then
    for i in 1..(array_length(v_uniq_ranks, 1) - 4) loop
      if v_uniq_ranks[i] - v_uniq_ranks[i + 4] = 4 then
        v_str_high := v_uniq_ranks[i];
        exit;
      end if;
    end loop;
  end if;

  -- Check if any suit has >= 5 cards (Flush / Straight Flush).
  select value ->> 'suit'
    into v_flush_suit
    from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb))
   group by value ->> 'suit'
  having count(*) >= 5
   limit 1;

  if v_flush_suit is not null then
    select array_agg(public.card_rank_val(value ->> 'rank') order by public.card_rank_val(value ->> 'rank') desc)
      into v_flush_ranks
      from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb))
     where (value ->> 'suit') = v_flush_suit;

    declare
      v_f_uniq int[];
    begin
      select array_agg(r order by r desc) into v_f_uniq from (select distinct unnest(v_flush_ranks) as r) u;
      if 14 = any(v_f_uniq) then
        v_f_uniq := array_append(v_f_uniq, 1);
      end if;
      if coalesce(array_length(v_f_uniq, 1), 0) >= 5 then
        for i in 1..(array_length(v_f_uniq, 1) - 4) loop
          if v_f_uniq[i] - v_f_uniq[i + 4] = 4 then
            v_sf_high := v_f_uniq[i];
            exit;
          end if;
        end loop;
      end if;
    end;
  end if;

  -- Group ranks by multiplicity (4, 3, 2, 1).
  select coalesce(array_agg(r order by r desc), array[]::int[]) into v_quads
    from (select unnest(v_ranks) as r group by r having count(*) = 4) q;
  select coalesce(array_agg(r order by r desc), array[]::int[]) into v_trips
    from (select unnest(v_ranks) as r group by r having count(*) = 3) t;
  select coalesce(array_agg(r order by r desc), array[]::int[]) into v_pairs
    from (select unnest(v_ranks) as r group by r having count(*) = 2) p;
  select coalesce(array_agg(r order by r desc), array[]::int[]) into v_singles
    from (select unnest(v_ranks) as r group by r having count(*) = 1) s;

  if v_sf_high > 0 then
    v_cat   := 8;
    v_label := case when v_sf_high = 14 then 'Royal Flush' else 'Straight Flush' end;
    v_k1    := v_sf_high;
  elsif coalesce(array_length(v_quads, 1), 0) >= 1 then
    v_cat   := 7;
    v_label := 'Four of a Kind';
    v_k1    := v_quads[1];
    select max(r) into v_k2 from unnest(v_ranks) as r where r <> v_k1;
  elsif coalesce(array_length(v_trips, 1), 0) >= 1
    and (coalesce(array_length(v_trips, 1), 0) >= 2 or coalesce(array_length(v_pairs, 1), 0) >= 1)
  then
    v_cat   := 6;
    v_label := 'Full House';
    v_k1    := v_trips[1];
    v_k2    := case when coalesce(array_length(v_trips, 1), 0) >= 2 then v_trips[2] else v_pairs[1] end;
  elsif v_flush_suit is not null then
    v_cat   := 5;
    v_label := 'Flush';
    v_k1    := coalesce(v_flush_ranks[1], 0);
    v_k2    := coalesce(v_flush_ranks[2], 0);
    v_k3    := coalesce(v_flush_ranks[3], 0);
    v_k4    := coalesce(v_flush_ranks[4], 0);
    v_k5    := coalesce(v_flush_ranks[5], 0);
  elsif v_str_high > 0 then
    v_cat   := 4;
    v_label := 'Straight';
    v_k1    := v_str_high;
  elsif coalesce(array_length(v_trips, 1), 0) >= 1 then
    v_cat   := 3;
    v_label := 'Three of a Kind';
    v_k1    := v_trips[1];
    v_k2    := coalesce(v_singles[1], 0);
    v_k3    := coalesce(v_singles[2], 0);
  elsif coalesce(array_length(v_pairs, 1), 0) >= 2 then
    v_cat   := 2;
    v_label := 'Two Pair';
    v_k1    := v_pairs[1];
    v_k2    := v_pairs[2];
    select max(r) into v_k3 from unnest(v_ranks) as r where r <> v_k1 and r <> v_k2;
  elsif coalesce(array_length(v_pairs, 1), 0) = 1 then
    v_cat   := 1;
    v_label := 'One Pair';
    v_k1    := v_pairs[1];
    v_k2    := coalesce(v_singles[1], 0);
    v_k3    := coalesce(v_singles[2], 0);
    v_k4    := coalesce(v_singles[3], 0);
  else
    v_cat   := 0;
    v_label := 'High Card';
    v_k1    := coalesce(v_singles[1], 0);
    v_k2    := coalesce(v_singles[2], 0);
    v_k3    := coalesce(v_singles[3], 0);
    v_k4    := coalesce(v_singles[4], 0);
    v_k5    := coalesce(v_singles[5], 0);
  end if;

  v_score := (v_cat::bigint * 10000000000::bigint)
           + (coalesce(v_k1, 0)::bigint * 100000000::bigint)
           + (coalesce(v_k2, 0)::bigint * 1000000::bigint)
           + (coalesce(v_k3, 0)::bigint * 10000::bigint)
           + (coalesce(v_k4, 0)::bigint * 100::bigint)
           + coalesce(v_k5, 0)::bigint;

  return jsonb_build_object('score', v_score, 'label', v_label);
end;
$$;

-- Internal: Settle a Texas Hold'em hand (either by fold victory or 7-card showdown).
create or replace function public.poker_settle_hand(
  p_room_id     uuid,
  p_round       int,
  p_pot         bigint,
  p_community   jsonb,
  p_players     jsonb,
  p_last_action jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs            public.game_states;
  v_sec           public.game_server_secrets;
  v_shoe          jsonb;
  v_comm          jsonb := coalesce(p_community, '[]'::jsonb);
  v_contenders    int := 0;
  v_sole_winner   uuid;
  v_best_score    bigint := -1;
  v_winners       uuid[] := array[]::uuid[];
  v_rec           record;
  v_priv          jsonb;
  v_hole          jsonb;
  v_eval          jsonb;
  v_score         bigint;
  v_out_players   jsonb := '{}'::jsonb;
  v_share         bigint;
  v_rem           bigint;
  v_idx           int := 0;
  v_win_uid       uuid;
  v_payout        bigint;
begin
  select * into v_gs from public.game_states where room_id = p_room_id for update;

  for v_rec in
    select key as uid_text, value as p
      from jsonb_each(coalesce(p_players, '{}'::jsonb))
     order by coalesce((value ->> 'seat')::int, 0) asc
  loop
    if (v_rec.p ->> 'status') <> 'folded' then
      v_contenders  := v_contenders + 1;
      v_sole_winner := v_rec.uid_text::uuid;
    end if;
  end loop;

  -- Case 1: Everyone else folded -> sole remaining player wins without needing to show cards.
  if v_contenders = 1 then
    if p_pot > 0 then
      perform public.apply_balance_delta(
        v_sole_winner,
        p_pot,
        'game_win',
        jsonb_build_object(
          'game',    'poker',
          'room_id', p_room_id,
          'round',   p_round,
          'reason',  'opponents_folded',
          'payout',  p_pot
        ),
        p_room_id,
        format('pk:%s:r%s:%s:win', p_room_id, p_round, v_sole_winner)
      );
    end if;

    for v_rec in select key as uid_text, value as p from jsonb_each(coalesce(p_players, '{}'::jsonb))
    loop
      v_payout := case when v_rec.uid_text::uuid = v_sole_winner then p_pot else 0 end;
      v_out_players := v_out_players || jsonb_build_object(
        v_rec.uid_text,
        v_rec.p || jsonb_build_object(
          'payout',     v_payout,
          'net',        v_payout - coalesce((v_rec.p ->> 'total_bet')::bigint, 0),
          'is_winner',  (v_rec.uid_text::uuid = v_sole_winner),
          'hand_label', case when v_rec.uid_text::uuid = v_sole_winner then 'Uncontested Pot' else null end
        )
      );
    end loop;

    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'settled',
           turn_user_id  = null,
           turn_deadline = null,
           state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
             'turn_number',     coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
             'street',          'showdown',
             'pot',             p_pot,
             'community_cards', v_comm,
             'players',         v_out_players,
             'last_action',     p_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object('room_id', p_room_id, 'phase', 'settled', 'version', v_gs.version + 1);
  end if;

  -- Case 2: Showdown -> deal any remaining community cards up to 5.
  select * into v_sec from public.game_server_secrets where room_id = p_room_id for update;
  v_shoe := coalesce(v_sec.shoe, '[]'::jsonb);
  while jsonb_array_length(v_comm) < 5 and jsonb_array_length(v_shoe) > 0 loop
    v_comm := v_comm || jsonb_build_array(v_shoe -> 0);
    v_shoe := v_shoe - 0;
  end loop;

  -- Evaluate each contender's 7-card hand (`hole_cards` + `v_comm`).
  for v_rec in
    select key as uid_text, value as p
      from jsonb_each(coalesce(p_players, '{}'::jsonb))
     order by coalesce((value ->> 'seat')::int, 0) asc
  loop
    if (v_rec.p ->> 'status') <> 'folded' then
      select data into v_priv
        from public.game_private_states
       where room_id = p_room_id and user_id = v_rec.uid_text::uuid;

      v_hole  := coalesce(v_priv -> 'hole_cards', '[]'::jsonb);
      v_eval  := public.poker_eval_7(v_hole || v_comm);
      v_score := (v_eval ->> 'score')::bigint;

      if v_score > v_best_score then
        v_best_score := v_score;
        v_winners    := array[v_rec.uid_text::uuid];
      elsif v_score = v_best_score then
        v_winners    := array_append(v_winners, v_rec.uid_text::uuid);
      end if;

      v_out_players := v_out_players || jsonb_build_object(
        v_rec.uid_text,
        v_rec.p || jsonb_build_object(
          'revealed_cards', v_hole,
          'hand_label',     v_eval ->> 'label',
          'hand_score',     v_score
        )
      );
    else
      v_out_players := v_out_players || jsonb_build_object(v_rec.uid_text, v_rec.p);
    end if;
  end loop;

  -- Distribute pot among winner(s).
  if coalesce(array_length(v_winners, 1), 0) > 0 and p_pot > 0 then
    v_share := p_pot / array_length(v_winners, 1);
    v_rem   := p_pot - (v_share * array_length(v_winners, 1));

    foreach v_win_uid in array v_winners loop
      v_idx    := v_idx + 1;
      v_payout := v_share + case when v_idx = 1 then v_rem else 0 end;

      if v_payout > 0 then
        perform public.apply_balance_delta(
          v_win_uid,
          v_payout,
          case when array_length(v_winners, 1) > 1 and v_payout = coalesce((v_out_players #>> array[v_win_uid::text, 'total_bet'])::bigint, 0)
            then 'game_refund'
            else 'game_win'
          end,
          jsonb_build_object(
            'game',    'poker',
            'room_id', p_room_id,
            'round',   p_round,
            'Reason',  'showdown',
            'payout',  v_payout
          ),
          p_room_id,
          format('pk:%s:r%s:%s:win', p_room_id, p_round, v_win_uid)
        );
      end if;

      v_out_players := jsonb_set(
        v_out_players,
        array[v_win_uid::text],
        (v_out_players -> v_win_uid::text) || jsonb_build_object(
          'payout',    v_payout,
          'net',       v_payout - coalesce((v_out_players #>> array[v_win_uid::text, 'total_bet'])::bigint, 0),
          'is_winner', true
        )
      );
    end loop;
  end if;

  -- Fill payout = 0 and net for non-winners.
  for v_rec in select key as uid_text, value as p from jsonb_each(v_out_players)
  loop
    if not coalesce((v_rec.p ->> 'is_winner')::boolean, false) then
      v_out_players := jsonb_set(
        v_out_players,
        array[v_rec.uid_text],
        v_rec.p || jsonb_build_object(
          'payout',    0,
          'net',       -coalesce((v_rec.p ->> 'total_bet')::bigint, 0),
          'is_winner', false
        )
      );
    end if;
  end loop;

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'settled',
         turn_user_id  = null,
         turn_deadline = null,
         state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number',     coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'street',          'showdown',
           'pot',             p_pot,
           'community_cards', v_comm,
           'players',         v_out_players,
           'last_action',     p_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'phase', 'settled', 'version', v_gs.version + 1);
end;
$$;

-- Internal: Advance Texas Hold'em action to next player, next street, or showdown.
create or replace function public.poker_advance_state(
  p_room_id     uuid,
  p_actor_uid   uuid,
  p_last_action jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs            public.game_states;
  v_sec           public.game_server_secrets;
  v_state         jsonb;
  v_round         int;
  v_street        text;
  v_pot           bigint;
  v_cur_bet       bigint;
  v_min_raise     bigint;
  v_comm          jsonb;
  v_players       jsonb;
  v_live_count    int := 0;
  v_actor_seat    int := 0;
  v_next_uid      uuid;
  v_rec           record;
  v_shoe          jsonb;
  v_dealer_seat   int;
  v_timeout       int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline      timestamptz;
begin
  select * into v_gs from public.game_states where room_id = p_room_id for update;
  v_state       := coalesce(v_gs.state, '{}'::jsonb);
  v_round       := coalesce((v_state ->> 'round_number')::int, 1);
  v_street      := coalesce(v_state ->> 'street', 'preflop');
  v_pot         := coalesce((v_state ->> 'pot')::bigint, 0);
  v_cur_bet     := coalesce((v_state ->> 'current_bet')::bigint, 0);
  v_min_raise   := coalesce((v_state ->> 'min_raise')::bigint, 50);
  v_comm        := coalesce(v_state -> 'community_cards', '[]'::jsonb);
  v_players     := coalesce(v_state -> 'players', '{}'::jsonb);
  v_dealer_seat := coalesce((v_state ->> 'dealer_seat')::int, 0);

  -- Count non-folded players.
  for v_rec in select key as uid_text, value as p from jsonb_each(v_players)
  loop
    if (v_rec.p ->> 'status') <> 'folded' then
      v_live_count := v_live_count + 1;
    end if;
    if v_rec.uid_text::uuid = p_actor_uid then
      v_actor_seat := coalesce((v_rec.p ->> 'seat')::int, 0);
    end if;
  end loop;

  if v_live_count <= 1 then
    return public.poker_settle_hand(p_room_id, v_round, v_pot, v_comm, v_players, p_last_action);
  end if;

  -- Find next clockwise active player who still needs to act on this street
  -- (`acted = false` OR `street_bet < v_cur_bet`).
  select (value ->> 'user_id')::uuid into v_next_uid
    from jsonb_each(v_players)
   where (value ->> 'status') = 'active'
     and (not coalesce((value ->> 'acted')::boolean, false)
          or coalesce((value ->> 'street_bet')::bigint, 0) < v_cur_bet)
     and coalesce((value ->> 'seat')::int, 0) > v_actor_seat
   order by coalesce((value ->> 'seat')::int, 0) asc
   limit 1;

  if v_next_uid is null then
    select (value ->> 'user_id')::uuid into v_next_uid
      from jsonb_each(v_players)
     where (value ->> 'status') = 'active'
       and (not coalesce((value ->> 'acted')::boolean, false)
            or coalesce((value ->> 'street_bet')::bigint, 0) < v_cur_bet)
     order by coalesce((value ->> 'seat')::int, 0) asc
     limit 1;
  end if;

  if v_next_uid is not null then
    v_deadline := now() + make_interval(secs => v_timeout);
    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'playing',
           turn_user_id  = v_next_uid,
           turn_deadline = v_deadline,
           state         = v_state || jsonb_build_object(
             'turn_number', coalesce((v_state ->> 'turn_number')::int, 0) + 1,
             'players',     v_players,
             'last_action', p_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object(
      'room_id',       p_room_id,
      'version',       v_gs.version + 1,
      'phase',         'playing',
      'turn_user_id',  v_next_uid,
      'turn_deadline', v_deadline
    );
  end if;

  -- Street is complete! If on 'river', settle via 7-card Showdown.
  if v_street = 'river' then
    return public.poker_settle_hand(p_room_id, v_round, v_pot, v_comm, v_players, p_last_action);
  end if;

  -- Deal next street ('flop' = 3 cards, 'turn' = 1 card, 'river' = 1 card).
  select * into v_sec from public.game_server_secrets where room_id = p_room_id for update;
  v_shoe := coalesce(v_sec.shoe, '[]'::jsonb);

  if v_street = 'preflop' then
    v_street := 'flop';
    v_comm   := v_comm || jsonb_build_array(v_shoe -> 0, v_shoe -> 1, v_shoe -> 2);
    v_shoe   := ((v_shoe - 0) - 0) - 0;
  elsif v_street = 'flop' then
    v_street := 'turn';
    v_comm   := v_comm || jsonb_build_array(v_shoe -> 0);
    v_shoe   := v_shoe - 0;
  else
    v_street := 'river';
    v_comm   := v_comm || jsonb_build_array(v_shoe -> 0);
    v_shoe   := v_shoe - 0;
  end if;

  update public.game_server_secrets
     set shoe = v_shoe, updated_at = now()
   where room_id = p_room_id;

  -- Reset `street_bet = 0` and `acted = false` for all active players on the new street.
  for v_rec in select key as uid_text, value as p from jsonb_each(v_players)
  loop
    v_players := jsonb_set(
      v_players,
      array[v_rec.uid_text],
      v_rec.p || jsonb_build_object('street_bet', 0, 'acted', false)
    );
  end loop;

  -- First active seat after dealer_seat acts first post-flop.
  select (value ->> 'user_id')::uuid into v_next_uid
    from jsonb_each(v_players)
   where (value ->> 'status') = 'active'
     and coalesce((value ->> 'seat')::int, 0) > v_dealer_seat
   order by coalesce((value ->> 'seat')::int, 0) asc
   limit 1;

  if v_next_uid is null then
    select (value ->> 'user_id')::uuid into v_next_uid
      from jsonb_each(v_players)
     where (value ->> 'status') = 'active'
     order by coalesce((value ->> 'seat')::int, 0) asc
     limit 1;
  end if;

  if v_next_uid is null then
    return public.poker_settle_hand(p_room_id, v_round, v_pot, v_comm, v_players, p_last_action);
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_next_uid,
         turn_deadline = v_deadline,
         state         = v_state || jsonb_build_object(
           'turn_number',     coalesce((v_state ->> 'turn_number')::int, 0) + 1,
           'street',          v_street,
           'current_bet',     0,
           'min_raise',       v_min_raise,
           'community_cards', v_comm,
           'players',         v_players,
           'last_action',     p_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'playing',
    'street',        v_street,
    'turn_user_id',  v_next_uid,
    'turn_deadline', v_deadline
  );
end;
$$;

-- Public RPC: Start a Texas Hold'em Hand (`poker_start_hand`)
create or replace function public.poker_start_hand(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_uid();
  v_room        public.rooms;
  v_gs          public.game_states;
  v_round       int;
  v_bb          bigint;
  v_sb          bigint;
  v_seats       record;
  v_seat_list   uuid[] := array[]::uuid[];
  v_seat_nums   int[]  := array[]::int[];
  v_count       int;
  v_dealer_idx  int;
  v_sb_idx      int;
  v_bb_idx      int;
  v_utg_idx     int;
  v_shoe        jsonb;
  v_players     jsonb := '{}'::jsonb;
  v_pot         bigint := 0;
  v_i           int;
  v_p_uid       uuid;
  v_p_seat      int;
  v_blind       bigint;
  v_hole        jsonb;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'poker' then
    raise exception 'room_not_found';
  end if;

  if not exists (select 1 from public.room_players where room_id = p_room_id and user_id = v_uid) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if v_gs.phase = 'playing' then
    raise exception 'round_already_active';
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

  for v_seats in
    select user_id, seat
      from public.room_players
     where room_id = p_room_id and status = 'active'
     order by seat asc
  loop
    v_seat_list := array_append(v_seat_list, v_seats.user_id);
    v_seat_nums := array_append(v_seat_nums, v_seats.seat::int);
  end loop;

  v_count := coalesce(array_length(v_seat_list, 1), 0);
  if v_count < 2 then
    raise exception 'no_active_players';
  end if;

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;
  v_bb    := greatest(v_room.min_bet, 100);
  v_sb    := greatest(v_bb / 2, 50);

  v_dealer_idx := ((v_round - 1) % v_count) + 1;
  if v_count = 2 then
    -- Heads-up: Dealer posts Small Blind and acts first preflop.
    v_sb_idx  := v_dealer_idx;
    v_bb_idx  := (v_dealer_idx % v_count) + 1;
    v_utg_idx := v_sb_idx;
  else
    v_sb_idx  := (v_dealer_idx % v_count) + 1;
    v_bb_idx  := (v_sb_idx % v_count) + 1;
    v_utg_idx := (v_bb_idx % v_count) + 1;
  end if;

  -- Build and shuffle a fresh 52-card deck.
  v_shoe := public.bj_build_shoe(1);

  for v_i in 1..v_count loop
    v_p_uid  := v_seat_list[v_i];
    v_p_seat := v_seat_nums[v_i];
    v_blind  := case
      when v_i = v_sb_idx then v_sb
      when v_i = v_bb_idx then v_bb
      else 0
    end;

    if v_blind > 0 then
      perform public.apply_balance_delta(
        v_p_uid,
        -v_blind,
        'game_bet',
        jsonb_build_object(
          'game',    'poker',
          'room_id', p_room_id,
          'round',   v_round,
          'blind',   case when v_i = v_sb_idx then 'sb' else 'bb' end,
          'amount',  v_blind
        ),
        p_room_id,
        format('pk:%s:r%s:%s:blind', p_room_id, v_round, v_p_uid)
      );
      v_pot := v_pot + v_blind;
    end if;

    -- Deal 2 private hole cards into `game_private_states`.
    v_hole := jsonb_build_array(v_shoe -> 0, v_shoe -> 1);
    v_shoe := (v_shoe - 0) - 0;

    insert into public.game_private_states (room_id, user_id, data, updated_at)
    values (p_room_id, v_p_uid, jsonb_build_object('hole_cards', v_hole, 'round', v_round), now())
    on conflict (room_id, user_id) do update
      set data       = excluded.data,
          updated_at = now();

    v_players := v_players || jsonb_build_object(
      v_p_uid::text,
      jsonb_build_object(
        'user_id',        v_p_uid,
        'seat',           v_p_seat,
        'status',         'active',
        'street_bet',     v_blind,
        'total_bet',      v_blind,
        'acted',          false,
        'is_dealer',      (v_i = v_dealer_idx),
        'is_sb',          (v_i = v_sb_idx),
        'is_bb',          (v_i = v_bb_idx),
        'revealed_cards', null,
        'hand_label',     null,
        'payout',         0,
        'net',            0,
        'is_winner',      false
      )
    );
  end loop;

  insert into public.game_server_secrets (room_id, shoe, dealer_hole_card, updated_at)
  values (p_room_id, v_shoe, null, now())
  on conflict (room_id) do update
    set shoe             = excluded.shoe,
        dealer_hole_card = null,
        updated_at       = now();

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_seat_list[v_utg_idx],
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',    v_round,
           'turn_number',     coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'street',          'preflop',
           'pot',             v_pot,
           'current_bet',     v_bb,
           'min_raise',       v_bb,
           'small_blind',     v_sb,
           'big_blind',       v_bb,
           'dealer_seat',     v_seat_nums[v_dealer_idx],
           'community_cards', '[]'::jsonb,
           'players',         v_players,
           'last_action',     jsonb_build_object(
             'type',              'hand_dealt',
             'user_id',           v_uid,
             'forced_by_timeout', false,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object(
    'room_id',       p_room_id,
    'version',       v_gs.version + 1,
    'phase',         'playing',
    'turn_user_id',  v_seat_list[v_utg_idx],
    'turn_deadline', v_deadline
  );
end;
$$;

-- Public RPC: Texas Hold'em Player Action (`poker_action`: 'fold', 'check', 'call', 'raise')
create or replace function public.poker_action(
  p_room_id uuid,
  p_action  text,
  p_amount  bigint default 0
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_uid();
  v_room        public.rooms;
  v_gs          public.game_states;
  v_act         text := lower(trim(coalesce(p_action, '')));
  v_state       jsonb;
  v_round       int;
  v_street      text;
  v_pot         bigint;
  v_cur_bet     bigint;
  v_min_raise   bigint;
  v_players     jsonb;
  v_me          jsonb;
  v_my_street   bigint;
  v_my_total    bigint;
  v_delta       bigint;
  v_target_bet  bigint;
  v_rec         record;
  v_last_action jsonb;
begin
  if v_act not in ('fold', 'check', 'call', 'raise') then
    raise exception 'invalid_action';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.game_type <> 'poker' then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found or v_gs.phase <> 'playing' then
    raise exception 'invalid_action';
  end if;

  if v_gs.turn_user_id is distinct from v_uid then
    raise exception 'not_your_turn';
  end if;

  if v_gs.turn_deadline is not null and now() > v_gs.turn_deadline then
    return public.claim_turn_timeout(p_room_id);
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;

  v_state     := coalesce(v_gs.state, '{}'::jsonb);
  v_round     := coalesce((v_state ->> 'round_number')::int, 1);
  v_street    := coalesce(v_state ->> 'street', 'preflop');
  v_pot       := coalesce((v_state ->> 'pot')::bigint, 0);
  v_cur_bet   := coalesce((v_state ->> 'current_bet')::bigint, 0);
  v_min_raise := coalesce((v_state ->> 'min_raise')::bigint, 100);
  v_players   := coalesce(v_state -> 'players', '{}'::jsonb);
  v_me        := v_players -> v_uid::text;

  if v_me is null or (v_me ->> 'status') <> 'active' then
    raise exception 'invalid_action';
  end if;

  v_my_street := coalesce((v_me ->> 'street_bet')::bigint, 0);
  v_my_total  := coalesce((v_me ->> 'total_bet')::bigint, 0);

  if v_act = 'fold' then
    v_players := jsonb_set(
      v_players,
      array[v_uid::text],
      v_me || jsonb_build_object('status', 'folded', 'acted', true)
    );
  elsif v_act = 'check' then
    if v_my_street < v_cur_bet then
      raise exception 'invalid_action';
    end if;
    v_players := jsonb_set(
      v_players,
      array[v_uid::text],
      v_me || jsonb_build_object('acted', true)
    );
  elsif v_act = 'call' then
    v_delta := greatest(0, v_cur_bet - v_my_street);
    if v_delta > 0 then
      perform public.apply_balance_delta(
        v_uid,
        -v_delta,
        'game_bet',
        jsonb_build_object(
          'game',    'poker',
          'room_id', p_room_id,
          'round',   v_round,
          'street',  v_street,
          'action',  'call',
          'amount',  v_delta
        ),
        p_room_id,
        format('pk:%s:r%s:%s:t%s:call', p_room_id, v_round, v_uid, coalesce((v_state ->> 'turn_number')::int, 0))
      );
      v_pot := v_pot + v_delta;
    end if;

    v_players := jsonb_set(
      v_players,
      array[v_uid::text],
      v_me || jsonb_build_object(
        'street_bet', v_my_street + v_delta,
        'total_bet',  v_my_total + v_delta,
        'acted',      true
      )
    );
  else
    -- v_act = 'raise': `p_amount` is the new total street_bet (or raise-to amount).
    v_target_bet := greatest(coalesce(p_amount, 0), v_cur_bet + v_min_raise);
    v_delta      := v_target_bet - v_my_street;
    if v_delta <= 0 or v_delta > 1000000 then
      raise exception 'invalid_bet_amount';
    end if;

    perform public.apply_balance_delta(
      v_uid,
      -v_delta,
      'game_bet',
      jsonb_build_object(
        'game',    'poker',
        'room_id', p_room_id,
        'round',   v_round,
        'street',  v_street,
        'action',  'raise',
        'amount',  v_delta
      ),
      p_room_id,
      format('pk:%s:r%s:%s:t%s:raise', p_room_id, v_round, v_uid, coalesce((v_state ->> 'turn_number')::int, 0))
    );

    v_min_raise := greatest(v_min_raise, v_target_bet - v_cur_bet);
    v_cur_bet   := v_target_bet;
    v_pot       := v_pot + v_delta;

    -- Other active players must act again facing the raise.
    for v_rec in select key as uid_text, value as p from jsonb_each(v_players)
    loop
      if v_rec.uid_text::uuid = v_uid then
        v_players := jsonb_set(
          v_players,
          array[v_rec.uid_text],
          v_rec.p || jsonb_build_object(
            'street_bet', v_target_bet,
            'total_bet',  v_my_total + v_delta,
            'acted',      true
          )
        );
      elsif (v_rec.p ->> 'status') = 'active' then
        v_players := jsonb_set(
          v_players,
          array[v_rec.uid_text],
          v_rec.p || jsonb_build_object('acted', false)
        );
      end if;
    end loop;
  end if;

  update public.game_states
     set state = v_state || jsonb_build_object(
       'pot',         v_pot,
       'current_bet', v_cur_bet,
       'min_raise',   v_min_raise,
       'players',     v_players
     )
   where room_id = p_room_id;

  v_last_action := jsonb_build_object(
    'type',              v_act,
    'user_id',           v_uid,
    'payload',           jsonb_build_object('amount', coalesce(v_delta, 0)),
    'forced_by_timeout', false,
    'at',                now()
  );

  return public.poker_advance_state(p_room_id, v_uid, v_last_action);
end;
$$;

-- =============================================================================
-- PART B: CLASSIC 36-CARD DURAK (`durak`, 2â€“6 Players)
-- =============================================================================

create or replace function public.durak_build_deck()
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('rank', r.rank, 'suit', s.suit)
      order by gen_random_uuid()
    ),
    '[]'::jsonb
  )
  from (values ('S'), ('H'), ('D'), ('C')) as s(suit)
  cross join (values ('6'), ('7'), ('8'), ('9'), ('10'), ('J'), ('Q'), ('K'), ('A')) as r(rank);
$$;

create or replace function public.durak_can_beat(
  p_attack  jsonb,
  p_defense jsonb,
  p_trump   text
)
returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when (p_defense ->> 'suit') = (p_attack ->> 'suit') then
      public.card_rank_val(p_defense ->> 'rank') > public.card_rank_val(p_attack ->> 'rank')
    when (p_defense ->> 'suit') = p_trump and (p_attack ->> 'suit') <> p_trump then
      true
    else
      false
  end;
$$;

-- Public RPC: Start a 36-Card Durak Match (`durak_start_game`)
create or replace function public.durak_start_game(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid        uuid := public.require_uid();
  v_room       public.rooms;
  v_gs         public.game_states;
  v_round      int;
  v_stake      bigint;
  v_pot        bigint := 0;
  v_seat_rec   record;
  v_uids       uuid[] := array[]::uuid[];
  v_seats      int[]  := array[]::int[];
  v_count      int;
  v_deck       jsonb;
  v_trump_card jsonb;
  v_trump_suit text;
  v_players    jsonb := '{}'::jsonb;
  v_hand       jsonb;
  v_i          int;
  v_j          int;
  v_timeout    int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline   timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'durak' then
    raise exception 'room_not_found';
  end if;

  if not exists (select 1 from public.room_players where room_id = p_room_id and user_id = v_uid) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if v_gs.phase = 'playing' then
    raise exception 'round_already_active';
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

  for v_seat_rec in
    select user_id, seat
      from public.room_players
     where room_id = p_room_id and status = 'active'
     order by seat asc
  loop
    v_uids  := array_append(v_uids, v_seat_rec.user_id);
    v_seats := array_append(v_seats, v_seat_rec.seat::int);
  end loop;

  v_count := coalesce(array_length(v_uids, 1), 0);
  if v_count < 2 then
    raise exception 'no_active_players';
  end if;

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;
  v_stake := greatest(v_room.min_bet, 100);
  v_deck  := public.durak_build_deck();

  for v_i in 1..v_count loop
    perform public.apply_balance_delta(
      v_uids[v_i],
      -v_stake,
      'game_bet',
      jsonb_build_object('game', 'durak', 'room_id', p_room_id, 'round', v_round, 'stake', v_stake),
      p_room_id,
      format('dk:%s:r%s:%s:stake', p_room_id, v_round, v_uids[v_i])
    );
    v_pot := v_pot + v_stake;

    v_hand := '[]'::jsonb;
    for v_j in 1..6 loop
      v_hand := v_hand || jsonb_build_array(v_deck -> 0);
      v_deck := v_deck - 0;
    end loop;

    insert into public.game_private_states (room_id, user_id, data, updated_at)
    values (p_room_id, v_uids[v_i], jsonb_build_object('hand', v_hand, 'round', v_round), now())
    on conflict (room_id, user_id) do update
      set data       = excluded.data,
          updated_at = now();

    v_players := v_players || jsonb_build_object(
      v_uids[v_i]::text,
      jsonb_build_object(
        'user_id',    v_uids[v_i],
        'seat',       v_seats[v_i],
        'card_count', 6,
        'stake',      v_stake,
        'payout',     0,
        'is_winner',  false
      )
    );
  end loop;

  -- Bottom card of the remaining talon defines the trump suit.
  v_trump_card := v_deck -> (jsonb_array_length(v_deck) - 1);
  v_trump_suit := v_trump_card ->> 'suit';

  insert into public.game_server_secrets (room_id, shoe, dealer_hole_card, updated_at)
  values (p_room_id, v_deck, null, now())
  on conflict (room_id) do update
    set shoe       = excluded.shoe,
        updated_at = now();

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_uids[1],
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number',   v_round,
           'turn_number',    coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'pot',            v_pot,
           'stake',          v_stake,
           'deck_remaining', jsonb_array_length(v_deck),
           'trump_card',     v_trump_card,
           'trump_suit',     v_trump_suit,
           'attacker_id',    v_uids[1],
           'defender_id',    v_uids[2],
           'bout_subphase',  'attacking',
           'table_pairs',    '[]'::jsonb,
           'players',        v_players,
           'winner_id',      null,
           'last_action',    jsonb_build_object(
             'type',              'durak_started',
             'user_id',           v_uid,
             'forced_by_timeout', false,
             'at',                now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'phase', 'playing');
end;
$$;

-- Internal: Refill Durak hands up to 6 cards from `game_server_secrets.shoe` and check for winner.
create or replace function public.durak_finish_bout(
  p_room_id      uuid,
  p_defender_took boolean,
  p_last_action  jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gs            public.game_states;
  v_sec           public.game_server_secrets;
  v_state         jsonb;
  v_round         int;
  v_pot           bigint;
  v_deck          jsonb;
  v_attacker      uuid;
  v_defender      uuid;
  v_pairs         jsonb;
  v_players       jsonb;
  v_pair          jsonb;
  v_def_priv      jsonb;
  v_def_hand      jsonb;
  v_order         uuid[];
  v_u             uuid;
  v_u_priv        jsonb;
  v_u_hand        jsonb;
  v_winner        uuid;
  v_next_attacker uuid;
  v_next_defender uuid;
  v_uids          uuid[] := array[]::uuid[];
  v_rec           record;
  v_idx           int;
  v_timeout       int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline      timestamptz;
begin
  select * into v_gs from public.game_states where room_id = p_room_id for update;
  select * into v_sec from public.game_server_secrets where room_id = p_room_id for update;

  v_state    := coalesce(v_gs.state, '{}'::jsonb);
  v_round    := coalesce((v_state ->> 'round_number')::int, 1);
  v_pot      := coalesce((v_state ->> 'pot')::bigint, 0);
  v_attacker := (v_state ->> 'attacker_id')::uuid;
  v_defender := (v_state ->> 'defender_id')::uuid;
  v_pairs    := coalesce(v_state -> 'table_pairs', '[]'::jsonb);
  v_players  := coalesce(v_state -> 'players', '{}'::jsonb);
  v_deck     := coalesce(v_sec.shoe, '[]'::jsonb);

  -- If defender took (`p_defender_took = true`), move all table cards into defender's hand.
  if p_defender_took then
    select data into v_def_priv from public.game_private_states where room_id = p_room_id and user_id = v_defender for update;
    v_def_hand := coalesce(v_def_priv -> 'hand', '[]'::jsonb);
    for v_pair in select value from jsonb_array_elements(v_pairs)
    loop
      if v_pair -> 'attack' is not null and jsonb_typeof(v_pair -> 'attack') = 'object' then
        v_def_hand := v_def_hand || jsonb_build_array(v_pair -> 'attack');
      end if;
      if v_pair -> 'defense' is not null and jsonb_typeof(v_pair -> 'defense') = 'object' then
        v_def_hand := v_def_hand || jsonb_build_array(v_pair -> 'defense');
      end if;
    end loop;
    update public.game_private_states
       set data = v_def_priv || jsonb_build_object('hand', v_def_hand), updated_at = now()
     where room_id = p_room_id and user_id = v_defender;
  end if;

  -- Draw order: attacker first, then defender (and any other players).
  v_order := array[v_attacker, v_defender];
  for v_rec in
    select key::uuid as u
      from jsonb_each(v_players)
     order by coalesce((value ->> 'seat')::int, 0) asc
  loop
    v_uids := array_append(v_uids, v_rec.u);
    if not (v_rec.u = any(v_order)) then
      v_order := array_append(v_order, v_rec.u);
    end if;
  end loop;

  foreach v_u in array v_order loop
    select data into v_u_priv from public.game_private_states where room_id = p_room_id and user_id = v_u for update;
    v_u_hand := coalesce(v_u_priv -> 'hand', '[]'::jsonb);
    while jsonb_array_length(v_u_hand) < 6 and jsonb_array_length(v_deck) > 0 loop
      v_u_hand := v_u_hand || jsonb_build_array(v_deck -> 0);
      v_deck   := v_deck - 0;
    end loop;

    update public.game_private_states
       set data = v_u_priv || jsonb_build_object('hand', v_u_hand), updated_at = now()
     where room_id = p_room_id and user_id = v_u;

    v_players := jsonb_set(
      v_players,
      array[v_u::text, 'card_count'],
      to_jsonb(jsonb_array_length(v_u_hand))
    );

    if jsonb_array_length(v_deck) = 0 and jsonb_array_length(v_u_hand) = 0 and v_winner is null then
      v_winner := v_u;
    end if;
  end loop;

  update public.game_server_secrets
     set shoe = v_deck, updated_at = now()
   where room_id = p_room_id;

  -- If someone emptied their hand with an empty talon, they win the Durak prize pool!
  if v_winner is not null then
    if v_pot > 0 then
      perform public.apply_balance_delta(
        v_winner,
        v_pot,
        'game_win',
        jsonb_build_object('game', 'durak', 'room_id', p_room_id, 'round', v_round, 'payout', v_pot),
        p_room_id,
        format('dk:%s:r%s:%s:win', p_room_id, v_round, v_winner)
      );
    end if;

    v_players := jsonb_set(
      v_players,
      array[v_winner::text],
      (v_players -> v_winner::text) || jsonb_build_object('payout', v_pot, 'is_winner', true)
    );

    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'settled',
           turn_user_id  = null,
           turn_deadline = null,
           state         = v_state || jsonb_build_object(
             'turn_number',    coalesce((v_state ->> 'turn_number')::int, 0) + 1,
             'deck_remaining', 0,
             'table_pairs',    '[]'::jsonb,
             'players',        v_players,
             'winner_id',      v_winner,
             'last_action',    p_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object('room_id', p_room_id, 'phase', 'settled', 'winner_id', v_winner);
  end if;

  -- Determine next attacker & defender:
  -- If defender defended (`not p_defender_took`), defender becomes next attacker.
  -- If defender took (`p_defender_took`), the player after defender becomes next attacker.
  v_idx := array_position(v_uids, v_defender);
  if not p_defender_took then
    v_next_attacker := v_defender;
    v_next_defender := v_uids[(v_idx % array_length(v_uids, 1)) + 1];
  else
    v_next_attacker := v_uids[(v_idx % array_length(v_uids, 1)) + 1];
    v_idx           := array_position(v_uids, v_next_attacker);
    v_next_defender := v_uids[(v_idx % array_length(v_uids, 1)) + 1];
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_next_attacker,
         turn_deadline = v_deadline,
         state         = v_state || jsonb_build_object(
           'turn_number',    coalesce((v_state ->> 'turn_number')::int, 0) + 1,
           'deck_remaining', jsonb_array_length(v_deck),
           'attacker_id',    v_next_attacker,
           'defender_id',    v_next_defender,
           'bout_subphase',  'attacking',
           'table_pairs',    '[]'::jsonb,
           'players',        v_players,
           'last_action',    p_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'phase', 'playing', 'version', v_gs.version + 1);
end;
$$;

-- Public RPC: Durak Action (`durak_action`: 'attack', 'defend', 'bito', 'take')
create or replace function public.durak_action(
  p_room_id uuid,
  p_action  text,
  p_card    jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_uid();
  v_room        public.rooms;
  v_gs          public.game_states;
  v_act         text := lower(trim(coalesce(p_action, '')));
  v_state       jsonb;
  v_attacker    uuid;
  v_defender    uuid;
  v_subphase    text;
  v_trump       text;
  v_pairs       jsonb;
  v_players     jsonb;
  v_priv        jsonb;
  v_hand        jsonb;
  v_new_hand    jsonb := '[]'::jsonb;
  v_found_card  boolean := false;
  v_c           jsonb;
  v_rank_ok     boolean := false;
  v_pair        jsonb;
  v_open_attack jsonb;
  v_last_action jsonb;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
begin
  if v_act not in ('attack', 'defend', 'bito', 'take') then
    raise exception 'invalid_action';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.game_type <> 'durak' then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found or v_gs.phase <> 'playing' then
    raise exception 'invalid_action';
  end if;

  if v_gs.turn_user_id is distinct from v_uid then
    raise exception 'not_your_turn';
  end if;

  if v_gs.turn_deadline is not null and now() > v_gs.turn_deadline then
    return public.claim_turn_timeout(p_room_id);
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;

  v_state    := coalesce(v_gs.state, '{}'::jsonb);
  v_attacker := (v_state ->> 'attacker_id')::uuid;
  v_defender := (v_state ->> 'defender_id')::uuid;
  v_subphase := coalesce(v_state ->> 'bout_subphase', 'attacking');
  v_trump    := coalesce(v_state ->> 'trump_suit', 'S');
  v_pairs    := coalesce(v_state -> 'table_pairs', '[]'::jsonb);
  v_players  := coalesce(v_state -> 'players', '{}'::jsonb);

  v_last_action := jsonb_build_object(
    'type',              v_act,
    'user_id',           v_uid,
    'payload',           coalesce(p_card, '{}'::jsonb),
    'forced_by_timeout', false,
    'at',                now()
  );

  if v_act = 'bito' then
    if v_uid <> v_attacker or v_subphase <> 'attacking' or jsonb_array_length(v_pairs) = 0 then
      raise exception 'invalid_action';
    end if;
    return public.durak_finish_bout(p_room_id, false, v_last_action);
  end if;

  if v_act = 'take' then
    if v_uid <> v_defender or v_subphase <> 'defending' then
      raise exception 'invalid_action';
    end if;
    return public.durak_finish_bout(p_room_id, true, v_last_action);
  end if;

  -- Both 'attack' and 'defend' require removing `p_card` from the caller's private hand.
  select data into v_priv from public.game_private_states where room_id = p_room_id and user_id = v_uid for update;
  v_hand := coalesce(v_priv -> 'hand', '[]'::jsonb);

  for v_c in select value from jsonb_array_elements(v_hand)
  loop
    if not v_found_card
       and (v_c ->> 'rank') = (p_card ->> 'rank')
       and (v_c ->> 'suit') = (p_card ->> 'suit')
    then
      v_found_card := true;
    else
      v_new_hand := v_new_hand || jsonb_build_array(v_c);
    end if;
  end loop;

  if not v_found_card then
    raise exception 'invalid_action';
  end if;

  if v_act = 'attack' then
    if v_uid <> v_attacker or v_subphase <> 'attacking' or jsonb_array_length(v_pairs) >= 6 then
      raise exception 'invalid_action';
    end if;

    -- After the first card of a bout, any additional attack card must match a rank already on the table.
    if jsonb_array_length(v_pairs) > 0 then
      for v_pair in select value from jsonb_array_elements(v_pairs)
      loop
        if (v_pair #>> '{attack,rank}') = (p_card ->> 'rank')
           or (v_pair #>> '{defense,rank}') = (p_card ->> 'rank')
        then
          v_rank_ok := true;
        end if;
      end loop;
      if not v_rank_ok then
        raise exception 'invalid_action';
      end if;
    end if;

    update public.game_private_states
       set data = v_priv || jsonb_build_object('hand', v_new_hand), updated_at = now()
     where room_id = p_room_id and user_id = v_uid;

    v_pairs := v_pairs || jsonb_build_array(jsonb_build_object('attack', p_card, 'defense', null));
    v_players := jsonb_set(v_players, array[v_uid::text, 'card_count'], to_jsonb(jsonb_array_length(v_new_hand)));

    -- If talon is empty and attacker just played their final card, attacker wins immediately!
    if coalesce((v_state ->> 'deck_remaining')::int, 0) = 0 and jsonb_array_length(v_new_hand) = 0 then
      return public.durak_finish_bout(p_room_id, false, v_last_action);
    end if;

    v_deadline := now() + make_interval(secs => v_timeout);

    update public.game_states
       set version       = v_gs.version + 1,
           turn_user_id  = v_defender,
           turn_deadline = v_deadline,
           state         = v_state || jsonb_build_object(
             'turn_number',   coalesce((v_state ->> 'turn_number')::int, 0) + 1,
             'bout_subphase', 'defending',
             'table_pairs',   v_pairs,
             'players',       v_players,
             'last_action',   v_last_action
           )
     where room_id = p_room_id;

    return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'turn_user_id', v_defender);
  end if;

  -- v_act = 'defend'
  if v_uid <> v_defender or v_subphase <> 'defending' or jsonb_array_length(v_pairs) = 0 then
    raise exception 'invalid_action';
  end if;

  v_open_attack := v_pairs #> array[(jsonb_array_length(v_pairs) - 1)::text, 'attack'];
  if not public.durak_can_beat(v_open_attack, p_card, v_trump) then
    raise exception 'invalid_action';
  end if;

  update public.game_private_states
     set data = v_priv || jsonb_build_object('hand', v_new_hand), updated_at = now()
   where room_id = p_room_id and user_id = v_uid;

  v_pairs := jsonb_set(
    v_pairs,
    array[(jsonb_array_length(v_pairs) - 1)::text, 'defense'],
    p_card
  );
  v_players := jsonb_set(v_players, array[v_uid::text, 'card_count'], to_jsonb(jsonb_array_length(v_new_hand)));

  -- If defender emptied their hand, or all 6 pairs were defended, or attacker has 0 cards left, finish bout!
  if jsonb_array_length(v_new_hand) = 0
     or jsonb_array_length(v_pairs) >= 6
     or coalesce((v_players #>> array[v_attacker::text, 'card_count'])::int, 0) = 0
  then
    update public.game_states
       set state = v_state || jsonb_build_object('table_pairs', v_pairs, 'players', v_players)
     where room_id = p_room_id;
    return public.durak_finish_bout(p_room_id, false, v_last_action);
  end if;

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         turn_user_id  = v_attacker,
         turn_deadline = v_deadline,
         state         = v_state || jsonb_build_object(
           'turn_number',   coalesce((v_state ->> 'turn_number')::int, 0) + 1,
           'bout_subphase', 'attacking',
           'table_pairs',   v_pairs,
           'players',       v_players,
           'last_action',   v_last_action
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'turn_user_id', v_attacker);
end;
$$;

-- =============================================================================
-- PART C: CLASSIC 8Ã—8 CHESS (`chess`, 2 Players)
-- =============================================================================

create or replace function public.chess_initial_board()
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_array(
    jsonb_build_array('bR','bN','bB','bQ','bK','bB','bN','bR'),
    jsonb_build_array('bP','bP','bP','bP','bP','bP','bP','bP'),
    jsonb_build_array(null,null,null,null,null,null,null,null),
    jsonb_build_array(null,null,null,null,null,null,null,null),
    jsonb_build_array(null,null,null,null,null,null,null,null),
    jsonb_build_array(null,null,null,null,null,null,null,null),
    jsonb_build_array('wP','wP','wP','wP','wP','wP','wP','wP'),
    jsonb_build_array('wR','wN','wB','wQ','wK','wB','wN','wR')
  );
$$;

create or replace function public.chess_start_game(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.require_uid();
  v_room     public.rooms;
  v_gs       public.game_states;
  v_round    int;
  v_stake    bigint;
  v_pot      bigint;
  v_uids     uuid[] := array[]::uuid[];
  v_rec      record;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'chess' then
    raise exception 'room_not_found';
  end if;

  if not exists (select 1 from public.room_players where room_id = p_room_id and user_id = v_uid) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if v_gs.phase = 'playing' then
    raise exception 'round_already_active';
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

  for v_rec in
    select user_id from public.room_players where room_id = p_room_id and status = 'active' order by seat asc limit 2
  loop
    v_uids := array_append(v_uids, v_rec.user_id);
  end loop;

  if coalesce(array_length(v_uids, 1), 0) < 2 then
    raise exception 'no_active_players';
  end if;

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;
  v_stake := greatest(v_room.min_bet, 100);
  v_pot   := v_stake * 2;

  perform public.apply_balance_delta(
    v_uids[1], -v_stake, 'game_bet',
    jsonb_build_object('game', 'chess', 'room_id', p_room_id, 'round', v_round, 'color', 'w'),
    p_room_id, format('ch:%s:r%s:%s:stake', p_room_id, v_round, v_uids[1])
  );
  perform public.apply_balance_delta(
    v_uids[2], -v_stake, 'game_bet',
    jsonb_build_object('game', 'chess', 'room_id', p_room_id, 'round', v_round, 'color', 'b'),
    p_room_id, format('ch:%s:r%s:%s:stake', p_room_id, v_round, v_uids[2])
  );

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_uids[1],
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number', v_round,
           'turn_number',  1,
           'pot',          v_pot,
           'stake',        v_stake,
           'white_id',     v_uids[1],
           'black_id',     v_uids[2],
           'turn_color',   'w',
           'board',        public.chess_initial_board(),
           'captured_w',   '[]'::jsonb,
           'captured_b',   '[]'::jsonb,
           'winner_id',    null,
           'win_reason',   null,
           'last_move',    null,
           'last_action',  jsonb_build_object(
             'type', 'chess_started', 'user_id', v_uid, 'forced_by_timeout', false, 'at', now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'phase', 'playing');
end;
$$;

create or replace function public.chess_move(
  p_room_id   uuid,
  p_from_row  int,
  p_from_col  int,
  p_to_row    int,
  p_to_col    int,
  p_promotion text default 'Q'
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid        uuid := public.require_uid();
  v_gs         public.game_states;
  v_state      jsonb;
  v_round      int;
  v_pot        bigint;
  v_white      uuid;
  v_black      uuid;
  v_color      text;
  v_board      jsonb;
  v_piece      text;
  v_target     text;
  v_ptype      text;
  v_dr         int;
  v_dc         int;
  v_step_r     int;
  v_step_c     int;
  v_cur_r      int;
  v_cur_c      int;
  v_promo      text;
  v_next_uid   uuid;
  v_next_color text;
  v_cap_w      jsonb;
  v_cap_b      jsonb;
  v_timeout    int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline   timestamptz;
begin
  if p_from_row not between 0 and 7 or p_from_col not between 0 and 7
     or p_to_row not between 0 and 7 or p_to_col not between 0 and 7
     or (p_from_row = p_to_row and p_from_col = p_to_col)
  then
    raise exception 'invalid_action';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found or v_gs.phase <> 'playing' then
    raise exception 'invalid_action';
  end if;

  if v_gs.turn_user_id is distinct from v_uid then
    raise exception 'not_your_turn';
  end if;

  if v_gs.turn_deadline is not null and now() > v_gs.turn_deadline then
    return public.claim_turn_timeout(p_room_id);
  end if;

  v_state := coalesce(v_gs.state, '{}'::jsonb);
  v_round := coalesce((v_state ->> 'round_number')::int, 1);
  v_pot   := coalesce((v_state ->> 'pot')::bigint, 0);
  v_white := (v_state ->> 'white_id')::uuid;
  v_black := (v_state ->> 'black_id')::uuid;
  v_color := coalesce(v_state ->> 'turn_color', 'w');
  v_board := v_state -> 'board';
  v_cap_w := coalesce(v_state -> 'captured_w', '[]'::jsonb);
  v_cap_b := coalesce(v_state -> 'captured_b', '[]'::jsonb);

  v_piece  := v_board #>> array[p_from_row::text, p_from_col::text];
  v_target := v_board #>> array[p_to_row::text, p_to_col::text];

  if v_piece is null or substr(v_piece, 1, 1) <> v_color then
    raise exception 'invalid_action';
  end if;
  if v_target is not null and substr(v_target, 1, 1) = v_color then
    raise exception 'invalid_action';
  end if;

  v_ptype := substr(v_piece, 2, 1);
  v_dr    := p_to_row - p_from_row;
  v_dc    := p_to_col - p_from_col;

  -- Geometry & path-clearance validation per piece type:
  if v_ptype = 'P' then
    if v_color = 'w' then
      if v_dc = 0 and v_dr = -1 and v_target is null then
        null;
      elsif v_dc = 0 and v_dr = -2 and p_from_row = 6 and v_target is null
        and (v_board #>> array['5', p_from_col::text]) is null
      then
        null;
      elsif abs(v_dc) = 1 and v_dr = -1 and v_target is not null then
        null;
      else
        raise exception 'invalid_action';
      end if;
    else
      if v_dc = 0 and v_dr = 1 and v_target is null then
        null;
      elsif v_dc = 0 and v_dr = 2 and p_from_row = 1 and v_target is null
        and (v_board #>> array['2', p_from_col::text]) is null
      then
        null;
      elsif abs(v_dc) = 1 and v_dr = 1 and v_target is not null then
        null;
      else
        raise exception 'invalid_action';
      end if;
    end if;
  elsif v_ptype = 'N' then
    if not ((abs(v_dr) = 2 and abs(v_dc) = 1) or (abs(v_dr) = 1 and abs(v_dc) = 2)) then
      raise exception 'invalid_action';
    end if;
  elsif v_ptype = 'K' then
    if greatest(abs(v_dr), abs(v_dc)) <> 1 then
      raise exception 'invalid_action';
    end if;
  elsif v_ptype in ('R', 'B', 'Q') then
    if v_ptype = 'R' and v_dr <> 0 and v_dc <> 0 then
      raise exception 'invalid_action';
    end if;
    if v_ptype = 'B' and abs(v_dr) <> abs(v_dc) then
      raise exception 'invalid_action';
    end if;
    if v_ptype = 'Q' and v_dr <> 0 and v_dc <> 0 and abs(v_dr) <> abs(v_dc) then
      raise exception 'invalid_action';
    end if;

    v_step_r := case when v_dr = 0 then 0 when v_dr > 0 then 1 else -1 end;
    v_step_c := case when v_dc = 0 then 0 when v_dc > 0 then 1 else -1 end;
    v_cur_r  := p_from_row + v_step_r;
    v_cur_c  := p_from_col + v_step_c;
    while v_cur_r <> p_to_row or v_cur_c <> p_to_col loop
      if (v_board #>> array[v_cur_r::text, v_cur_c::text]) is not null then
        raise exception 'invalid_action';
      end if;
      v_cur_r := v_cur_r + v_step_r;
      v_cur_c := v_cur_c + v_step_c;
    end loop;
  end if;

  -- Pawn promotion on back rank.
  v_promo := upper(trim(coalesce(p_promotion, 'Q')));
  if v_promo not in ('Q', 'R', 'B', 'N') then
    v_promo := 'Q';
  end if;
  if v_ptype = 'P' and (p_to_row = 0 or p_to_row = 7) then
    v_piece := v_color || v_promo;
  end if;

  if v_target is not null then
    if v_color = 'w' then
      v_cap_w := v_cap_w || jsonb_build_array(v_target);
    else
      v_cap_b := v_cap_b || jsonb_build_array(v_target);
    end if;
  end if;

  v_board := jsonb_set(v_board, array[p_from_row::text, p_from_col::text], 'null'::jsonb);
  v_board := jsonb_set(v_board, array[p_to_row::text, p_to_col::text], to_jsonb(v_piece));

  -- Check if opponent's King was captured -> Victory!
  if v_target in ('wK', 'bK') then
    if v_pot > 0 then
      perform public.apply_balance_delta(
        v_uid, v_pot, 'game_win',
        jsonb_build_object('game', 'chess', 'room_id', p_room_id, 'round', v_round, 'payout', v_pot),
        p_room_id, format('ch:%s:r%s:%s:win', p_room_id, v_round, v_uid)
      );
    end if;

    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'settled',
           turn_user_id  = null,
           turn_deadline = null,
           state         = v_state || jsonb_build_object(
             'turn_number', coalesce((v_state ->> 'turn_number')::int, 0) + 1,
             'board',       v_board,
             'captured_w',  v_cap_w,
             'captured_b',  v_cap_b,
             'winner_id',   v_uid,
             'win_reason',  'king_captured',
             'last_move',   jsonb_build_object('from', jsonb_build_array(p_from_row, p_from_col), 'to', jsonb_build_array(p_to_row, p_to_col), 'piece', v_piece),
             'last_action', jsonb_build_object('type', 'chess_win', 'user_id', v_uid, 'forced_by_timeout', false, 'at', now())
           )
     where room_id = p_room_id;

    return jsonb_build_object('room_id', p_room_id, 'phase', 'settled', 'winner_id', v_uid);
  end if;

  v_next_color := case when v_color = 'w' then 'b' else 'w' end;
  v_next_uid   := case when v_color = 'w' then v_black else v_white end;
  v_deadline   := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         turn_user_id  = v_next_uid,
         turn_deadline = v_deadline,
         state         = v_state || jsonb_build_object(
           'turn_number', coalesce((v_state ->> 'turn_number')::int, 0) + 1,
           'turn_color',  v_next_color,
           'board',       v_board,
           'captured_w',  v_cap_w,
           'captured_b',  v_cap_b,
           'last_move',   jsonb_build_object('from', jsonb_build_array(p_from_row, p_from_col), 'to', jsonb_build_array(p_to_row, p_to_col), 'piece', v_piece),
           'last_action', jsonb_build_object('type', 'chess_move', 'user_id', v_uid, 'forced_by_timeout', false, 'at', now())
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'turn_user_id', v_next_uid);
end;
$$;

-- =============================================================================
-- PART D: CLASSIC 8Ã—8 CHECKERS / DRAUGHTS (`checkers`, 2 Players)
-- =============================================================================

create or replace function public.checkers_initial_board()
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_array(
    jsonb_build_array(null,'b',null,'b',null,'b',null,'b'),
    jsonb_build_array('b',null,'b',null,'b',null,'b',null),
    jsonb_build_array(null,'b',null,'b',null,'b',null,'b'),
    jsonb_build_array(null,null,null,null,null,null,null,null),
    jsonb_build_array(null,null,null,null,null,null,null,null),
    jsonb_build_array('r',null,'r',null,'r',null,'r',null),
    jsonb_build_array(null,'r',null,'r',null,'r',null,'r'),
    jsonb_build_array('r',null,'r',null,'r',null,'r',null)
  );
$$;

create or replace function public.checkers_start_game(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.require_uid();
  v_room     public.rooms;
  v_gs       public.game_states;
  v_round    int;
  v_stake    bigint;
  v_pot      bigint;
  v_uids     uuid[] := array[]::uuid[];
  v_rec      record;
  v_timeout  int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline timestamptz;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status = 'closed' or v_room.game_type <> 'checkers' then
    raise exception 'room_not_found';
  end if;

  if not exists (select 1 from public.room_players where room_id = p_room_id and user_id = v_uid) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if v_gs.phase = 'playing' then
    raise exception 'round_already_active';
  end if;

  update public.room_players
     set status = 'active', afk_since = null, last_seen_at = now()
   where room_id = p_room_id and (user_id = v_uid or status = 'spectating');

  for v_rec in
    select user_id from public.room_players where room_id = p_room_id and status = 'active' order by seat asc limit 2
  loop
    v_uids := array_append(v_uids, v_rec.user_id);
  end loop;

  if coalesce(array_length(v_uids, 1), 0) < 2 then
    raise exception 'no_active_players';
  end if;

  v_round := coalesce((v_gs.state ->> 'round_number')::int, 0) + 1;
  v_stake := greatest(v_room.min_bet, 100);
  v_pot   := v_stake * 2;

  perform public.apply_balance_delta(
    v_uids[1], -v_stake, 'game_bet',
    jsonb_build_object('game', 'checkers', 'room_id', p_room_id, 'round', v_round, 'color', 'r'),
    p_room_id, format('ck:%s:r%s:%s:stake', p_room_id, v_round, v_uids[1])
  );
  perform public.apply_balance_delta(
    v_uids[2], -v_stake, 'game_bet',
    jsonb_build_object('game', 'checkers', 'room_id', p_room_id, 'round', v_round, 'color', 'b'),
    p_room_id, format('ck:%s:r%s:%s:stake', p_room_id, v_round, v_uids[2])
  );

  v_deadline := now() + make_interval(secs => v_timeout);

  update public.rooms set status = 'playing' where id = p_room_id and status = 'waiting';

  update public.game_states
     set version       = v_gs.version + 1,
         phase         = 'playing',
         turn_user_id  = v_uids[1],
         turn_deadline = v_deadline,
         state         = jsonb_build_object(
           'round_number', v_round,
           'turn_number',  1,
           'pot',          v_pot,
           'stake',        v_stake,
           'red_id',       v_uids[1],
           'black_id',     v_uids[2],
           'turn_color',   'r',
           'board',        public.checkers_initial_board(),
           'red_left',     12,
           'black_left',   12,
           'winner_id',    null,
           'win_reason',   null,
           'last_move',    null,
           'last_action',  jsonb_build_object(
             'type', 'checkers_started', 'user_id', v_uid, 'forced_by_timeout', false, 'at', now()
           )
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'phase', 'playing');
end;
$$;

create or replace function public.checkers_move(
  p_room_id  uuid,
  p_from_row int,
  p_from_col int,
  p_to_row   int,
  p_to_col   int
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid        uuid := public.require_uid();
  v_gs         public.game_states;
  v_state      jsonb;
  v_round      int;
  v_pot        bigint;
  v_red        uuid;
  v_black      uuid;
  v_color      text;
  v_board      jsonb;
  v_piece      text;
  v_target     text;
  v_mid_piece  text;
  v_dr         int;
  v_dc         int;
  v_red_left   int;
  v_black_left int;
  v_next_color text;
  v_next_uid   uuid;
  v_timeout    int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline   timestamptz;
begin
  if p_from_row not between 0 and 7 or p_from_col not between 0 and 7
     or p_to_row not between 0 and 7 or p_to_col not between 0 and 7
  then
    raise exception 'invalid_action';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found or v_gs.phase <> 'playing' then
    raise exception 'invalid_action';
  end if;

  if v_gs.turn_user_id is distinct from v_uid then
    raise exception 'not_your_turn';
  end if;

  if v_gs.turn_deadline is not null and now() > v_gs.turn_deadline then
    return public.claim_turn_timeout(p_room_id);
  end if;

  v_state      := coalesce(v_gs.state, '{}'::jsonb);
  v_round      := coalesce((v_state ->> 'round_number')::int, 1);
  v_pot        := coalesce((v_state ->> 'pot')::bigint, 0);
  v_red        := (v_state ->> 'red_id')::uuid;
  v_black      := (v_state ->> 'black_id')::uuid;
  v_color      := coalesce(v_state ->> 'turn_color', 'r');
  v_board      := v_state -> 'board';
  v_red_left   := coalesce((v_state ->> 'red_left')::int, 12);
  v_black_left := coalesce((v_state ->> 'black_left')::int, 12);

  v_piece  := v_board #>> array[p_from_row::text, p_from_col::text];
  v_target := v_board #>> array[p_to_row::text, p_to_col::text];

  if v_piece is null or lower(v_piece) <> v_color or v_target is not null then
    raise exception 'invalid_action';
  end if;

  v_dr := p_to_row - p_from_row;
  v_dc := p_to_col - p_from_col;

  if abs(v_dr) <> abs(v_dc) or abs(v_dr) not in (1, 2) then
    raise exception 'invalid_action';
  end if;

  -- Non-king pieces ('r' and 'b') can only move/jump forward ('r' moves up: v_dr < 0; 'b' moves down: v_dr > 0).
  if v_piece = 'r' and v_dr > 0 then
    raise exception 'invalid_action';
  end if;
  if v_piece = 'b' and v_dr < 0 then
    raise exception 'invalid_action';
  end if;

  if abs(v_dr) = 2 then
    v_mid_piece := v_board #>> array[((p_from_row + p_to_row) / 2)::text, ((p_from_col + p_to_col) / 2)::text];
    if v_mid_piece is null or lower(v_mid_piece) = v_color then
      raise exception 'invalid_action';
    end if;
    v_board := jsonb_set(
      v_board,
      array[((p_from_row + p_to_row) / 2)::text, ((p_from_col + p_to_col) / 2)::text],
      'null'::jsonb
    );
    if v_color = 'r' then
      v_black_left := greatest(0, v_black_left - 1);
    else
      v_red_left := greatest(0, v_red_left - 1);
    end if;
  end if;

  -- Crown King when reaching the far row.
  if v_piece = 'r' and p_to_row = 0 then
    v_piece := 'R';
  elsif v_piece = 'b' and p_to_row = 7 then
    v_piece := 'B';
  end if;

  v_board := jsonb_set(v_board, array[p_from_row::text, p_from_col::text], 'null'::jsonb);
  v_board := jsonb_set(v_board, array[p_to_row::text, p_to_col::text], to_jsonb(v_piece));

  -- Check if all opponent checkers have been captured -> Victory!
  if v_red_left = 0 or v_black_left = 0 then
    if v_pot > 0 then
      perform public.apply_balance_delta(
        v_uid, v_pot, 'game_win',
        jsonb_build_object('game', 'checkers', 'room_id', p_room_id, 'round', v_round, 'payout', v_pot),
        p_room_id, format('ck:%s:r%s:%s:win', p_room_id, v_round, v_uid)
      );
    end if;

    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'settled',
           turn_user_id  = null,
           turn_deadline = null,
           state         = v_state || jsonb_build_object(
             'turn_number', coalesce((v_state ->> 'turn_number')::int, 0) + 1,
             'board',       v_board,
             'red_left',    v_red_left,
             'black_left',  v_black_left,
             'winner_id',   v_uid,
             'win_reason',  'all_captured',
             'last_move',   jsonb_build_object('from', jsonb_build_array(p_from_row, p_from_col), 'to', jsonb_build_array(p_to_row, p_to_col), 'piece', v_piece),
             'last_action', jsonb_build_object('type', 'checkers_win', 'user_id', v_uid, 'forced_by_timeout', false, 'at', now())
           )
     where room_id = p_room_id;

    return jsonb_build_object('room_id', p_room_id, 'phase', 'settled', 'winner_id', v_uid);
  end if;

  v_next_color := case when v_color = 'r' then 'b' else 'r' end;
  v_next_uid   := case when v_color = 'r' then v_black else v_red end;
  v_deadline   := now() + make_interval(secs => v_timeout);

  update public.game_states
     set version       = v_gs.version + 1,
         turn_user_id  = v_next_uid,
         turn_deadline = v_deadline,
         state         = v_state || jsonb_build_object(
           'turn_number', coalesce((v_state ->> 'turn_number')::int, 0) + 1,
           'turn_color',  v_next_color,
           'board',       v_board,
           'red_left',    v_red_left,
           'black_left',  v_black_left,
           'last_move',   jsonb_build_object('from', jsonb_build_array(p_from_row, p_from_col), 'to', jsonb_build_array(p_to_row, p_to_col), 'piece', v_piece),
           'last_action', jsonb_build_object('type', 'checkers_move', 'user_id', v_uid, 'forced_by_timeout', false, 'at', now())
         )
   where room_id = p_room_id;

  return jsonb_build_object('room_id', p_room_id, 'version', v_gs.version + 1, 'turn_user_id', v_next_uid);
end;
$$;

-- =============================================================================
-- PART E: UPGRADE `claim_turn_timeout` FOR ALL 7 GAMES
-- =============================================================================
create or replace function public.claim_turn_timeout(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_caller      uuid := (select auth.uid());
  v_room        public.rooms;
  v_gs          public.game_states;
  v_timed_u     uuid;
  v_neutral     text;
  v_next        uuid;
  v_timeout     int := coalesce(public.cfg_int('turn_timeout_seconds')::int, 15);
  v_deadline    timestamptz;
  v_phase       text;
  v_round       int;
  v_hands       jsonb;
  v_timed_hand  jsonb;
  v_tickets     jsonb;
  v_timed_tkt   jsonb;
  v_players     jsonb;
  v_timed_p     jsonb;
  v_cur_bet     bigint;
  v_my_street   bigint;
  v_pot         bigint;
  v_opp_uid     uuid;
  v_last_action jsonb;
begin
  if v_caller is not null and not public.is_room_member(p_room_id) then
    raise exception 'not_in_room' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_gs from public.game_states where room_id = p_room_id for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  if v_gs.turn_user_id is null or v_gs.turn_deadline is null or now() < v_gs.turn_deadline then
    return jsonb_build_object(
      'expired',       false,
      'version',       v_gs.version,
      'turn_user_id',  v_gs.turn_user_id,
      'turn_deadline', v_gs.turn_deadline,
      'server_now',    now()
    );
  end if;

  v_timed_u := v_gs.turn_user_id;

  -- 1) Mark the timed-out player AFK so they cannot delay the room.
  perform public.force_afk(p_room_id, v_timed_u);

  -- 2) Blackjack timeout handling:
  if v_room.game_type = 'blackjack' and v_gs.phase in ('betting', 'playing') then
    v_round      := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_hands      := coalesce(v_gs.state -> 'hands', '{}'::jsonb);
    v_timed_hand := v_hands -> v_timed_u::text;

    if v_gs.phase = 'betting' then
      if v_timed_hand is not null then
        v_hands := jsonb_set(v_hands, array[v_timed_u::text], v_timed_hand || jsonb_build_object('status', 'skipped_afk'));
      end if;
      v_last_action := jsonb_build_object('type', 'skip_bet', 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now());

      select (value ->> 'user_id')::uuid into v_next
        from jsonb_each(v_hands) where value ->> 'status' = 'betting' order by coalesce((value ->> 'seat')::int, 0) asc limit 1;

      if v_next is not null then
        v_deadline := now() + make_interval(secs => v_timeout);
        update public.game_states
           set version = v_gs.version + 1, turn_user_id = v_next, turn_deadline = v_deadline,
               state = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object('turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1, 'hands', v_hands, 'last_action', v_last_action)
         where room_id = p_room_id;
        return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet', 'version', v_gs.version + 1);
      end if;
      return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet')
             || public.bj_deal_initial_cards(p_room_id, v_round, v_hands, v_last_action);
    end if;

    if v_timed_hand is not null then
      v_hands := jsonb_set(v_hands, array[v_timed_u::text], v_timed_hand || jsonb_build_object('status', 'stood'));
    end if;
    v_last_action := jsonb_build_object('type', 'stand', 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now());
    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'stand')
           || public.bj_advance_or_settle(p_room_id, v_round, v_hands, v_last_action);
  end if;

  -- 3) Roulette betting timeout handling:
  if v_room.game_type = 'roulette' and v_gs.phase = 'betting' then
    v_round     := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_tickets   := coalesce(v_gs.state -> 'tickets', '{}'::jsonb);
    v_timed_tkt := v_tickets -> v_timed_u::text;

    if v_timed_tkt is not null then
      v_tickets := jsonb_set(v_tickets, array[v_timed_u::text], v_timed_tkt || jsonb_build_object('status', 'skipped_afk'));
    end if;
    v_last_action := jsonb_build_object('type', 'skip_bet', 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now());

    select (value ->> 'user_id')::uuid into v_next
      from jsonb_each(v_tickets) where value ->> 'status' = 'betting' order by coalesce((value ->> 'seat')::int, 0) asc limit 1;

    if v_next is not null then
      v_deadline := now() + make_interval(secs => v_timeout);
      update public.game_states
         set version = v_gs.version + 1, turn_user_id = v_next, turn_deadline = v_deadline,
             state = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object('turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1, 'tickets', v_tickets, 'last_action', v_last_action)
       where room_id = p_room_id;
      return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet', 'version', v_gs.version + 1);
    end if;
    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'skip_bet')
           || public.roulette_execute_spin(p_room_id, v_round, v_tickets, v_last_action);
  end if;

  -- 4) Texas Hold'em Poker timeout handling: Check if free, otherwise Fold!
  if v_room.game_type = 'poker' and v_gs.phase = 'playing' then
    v_players   := coalesce(v_gs.state -> 'players', '{}'::jsonb);
    v_timed_p   := v_players -> v_timed_u::text;
    v_cur_bet   := coalesce((v_gs.state ->> 'current_bet')::bigint, 0);
    v_my_street := coalesce((v_timed_p ->> 'street_bet')::bigint, 0);

    if v_my_street >= v_cur_bet then
      v_neutral := 'check';
      v_players := jsonb_set(v_players, array[v_timed_u::text], v_timed_p || jsonb_build_object('acted', true));
    else
      v_neutral := 'fold';
      v_players := jsonb_set(v_players, array[v_timed_u::text], v_timed_p || jsonb_build_object('status', 'folded', 'acted', true));
    end if;

    update public.game_states
       set state = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object('players', v_players)
     where room_id = p_room_id;

    v_last_action := jsonb_build_object('type', v_neutral, 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now());
    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', v_neutral)
           || public.poker_advance_state(p_room_id, v_timed_u, v_last_action);
  end if;

  -- 5) Durak timeout handling: Defender auto-takes (`take`), Attacker auto-passes (`bito` / ends bout)
  if v_room.game_type = 'durak' and v_gs.phase = 'playing' then
    if coalesce(v_gs.state ->> 'bout_subphase', 'attacking') = 'defending' then
      v_last_action := jsonb_build_object('type', 'take', 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now());
      return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'take')
             || public.durak_finish_bout(p_room_id, true, v_last_action);
    else
      v_last_action := jsonb_build_object('type', 'bito', 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now());
      return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'bito')
             || public.durak_finish_bout(p_room_id, false, v_last_action);
    end if;
  end if;

  -- 6) Chess & Checkers timeout handling: award match pot to the non-timed-out opponent!
  if v_room.game_type in ('chess', 'checkers') and v_gs.phase = 'playing' then
    v_round := coalesce((v_gs.state ->> 'round_number')::int, 1);
    v_pot   := coalesce((v_gs.state ->> 'pot')::bigint, 0);
    if v_room.game_type = 'chess' then
      v_opp_uid := case
        when v_timed_u = (v_gs.state ->> 'white_id')::uuid then (v_gs.state ->> 'black_id')::uuid
        else (v_gs.state ->> 'white_id')::uuid
      end;
    else
      v_opp_uid := case
        when v_timed_u = (v_gs.state ->> 'red_id')::uuid then (v_gs.state ->> 'black_id')::uuid
        else (v_gs.state ->> 'red_id')::uuid
      end;
    end if;

    if v_opp_uid is not null and v_pot > 0 then
      perform public.apply_balance_delta(
        v_opp_uid, v_pot, 'game_win',
        jsonb_build_object('game', v_room.game_type, 'room_id', p_room_id, 'round', v_round, 'reason', 'opponent_timeout', 'payout', v_pot),
        p_room_id, format('%s:%s:r%s:%s:win', v_room.game_type, p_room_id, v_round, v_opp_uid)
      );
    end if;

    update public.game_states
       set version       = v_gs.version + 1,
           phase         = 'settled',
           turn_user_id  = null,
           turn_deadline = null,
           state         = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
             'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
             'winner_id',   v_opp_uid,
             'win_reason',  'timeout_forfeit',
             'last_action', jsonb_build_object('type', 'timeout_forfeit', 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now())
           )
     where room_id = p_room_id;

    return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', 'timeout_forfeit', 'winner_id', v_opp_uid);
  end if;

  -- 7) Generic fallback:
  v_neutral := 'skip';
  v_next    := public.next_active_room_user(p_room_id, v_timed_u);
  v_deadline := case when v_next is not null then now() + make_interval(secs => v_timeout) else null end;
  v_phase    := case when v_next is not null then v_gs.phase else 'awaiting_players' end;

  update public.game_states
     set version = v_gs.version + 1, phase = v_phase, turn_user_id = v_next, turn_deadline = v_deadline,
         state = coalesce(v_gs.state, '{}'::jsonb) || jsonb_build_object(
           'turn_number', coalesce((v_gs.state ->> 'turn_number')::int, 0) + 1,
           'last_action', jsonb_build_object('type', v_neutral, 'user_id', v_timed_u, 'forced_by_timeout', true, 'at', now())
         )
   where room_id = p_room_id;

  return jsonb_build_object('expired', true, 'timed_out_user', v_timed_u, 'forced_action', v_neutral, 'version', v_gs.version + 1);
end;
$$;

-- ---------- Grants ------------------------------------------------------------
grant execute on function
  public.card_rank_val(text),
  public.poker_eval_7(jsonb),
  public.poker_start_hand(uuid),
  public.poker_action(uuid, text, bigint),
  public.durak_can_beat(jsonb, jsonb, text),
  public.durak_start_game(uuid),
  public.durak_action(uuid, text, jsonb),
  public.chess_initial_board(),
  public.chess_start_game(uuid),
  public.chess_move(uuid, int, int, int, int, text),
  public.checkers_initial_board(),
  public.checkers_start_game(uuid),
  public.checkers_move(uuid, int, int, int, int),
  public.claim_turn_timeout(uuid)
  to authenticated, service_role;

grant execute on function
  public.poker_settle_hand(uuid, int, bigint, jsonb, jsonb, jsonb),
  public.poker_advance_state(uuid, uuid, jsonb),
  public.durak_build_deck(),
  public.durak_finish_bout(uuid, boolean, jsonb)
  to service_role;



-- =============================================================================
-- FILE: 20261030000014_recovery_phrase_auth.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Migration 14 â€” Username + Password + Recovery Phrase Auth Fix
-- =============================================================================
-- Fixes "Database error saving new user" during registration on Supabase:
-- 1. Ensures `public.profiles` has `recovery_phrase_hash text` and `avatar_id`
--    with a safe default ('fox'), and ensures `public.avatars` is seeded.
-- 2. Replaces `public.handle_new_user()` so GoTrue signups cleanly insert
--    (id, username, avatar_id, recovery_phrase_hash) into `public.profiles`,
--    provision `public.user_roles` and `public.wallets`, and grant the 10x
--    starting balance without failing on search_path or auth.users permissions.
-- 3. Restores `EXECUTE` and schema privileges for `supabase_auth_admin`
--    (stripped by `REVOKE EXECUTE ... FROM public` in Migration 7).
-- 4. Auto-confirms new accounts via `public.auto_confirm_kafkasino_user()`.
-- 5. Provides `public.reset_password_with_recovery(p_username, p_recovery_digest, p_new_password)`.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 1. Ensure `public.profiles` & `public.avatars` schema ------------
alter table public.profiles
  add column if not exists recovery_phrase_hash text;

alter table public.profiles
  alter column avatar_id set default 'fox';

insert into public.avatars (id, display_name, image_path, sort_order) values
  ('fox',      'The Barrister â€” Fox',        'avatars/fox.jpg',      1),
  ('owl',      'The Professor â€” Owl',        'avatars/owl.jpg',      2),
  ('bear',     'The Executive â€” Bear',       'avatars/bear.jpg',     3),
  ('wolf',     'The Detective â€” Wolf',       'avatars/wolf.jpg',     4),
  ('lion',     'The Chairman â€” Lion',        'avatars/lion.jpg',     5),
  ('raccoon',  'The Accountant â€” Raccoon',   'avatars/raccoon.jpg',  6),
  ('elephant', 'The Diplomat â€” Elephant',    'avatars/elephant.jpg', 7),
  ('penguin',  'The MaÃ®tre d'' â€” Penguin',   'avatars/penguin.jpg',  8),
  ('eagle',    'The Captain â€” Eagle',        'avatars/eagle.jpg',    9),
  ('panther',  'The Gentleman â€” Panther',    'avatars/panther.jpg', 10)
on conflict (id) do nothing;

insert into public.app_config (key, value, description) values
  ('daily_bonus_amount',   '1000'::jsonb,
     'Chips granted by the daily bonus. Starting balance is ALWAYS exactly 10x this value.'),
  ('bonus_reset_hour',     '3'::jsonb,
     'Local hour (0-23) at which the daily bonus resets.'),
  ('bonus_timezone',       '"Europe/Berlin"'::jsonb,
     'IANA timezone used for the daily bonus reset.'),
  ('turn_timeout_seconds', '15'::jsonb,
     'Seconds a player has to act before the server forces a neutral action and marks them AFK.')
on conflict (key) do nothing;

-- ---------- 2. Server-only Recovery Secrets & Brute-Force Throttle -----------
create table if not exists public.user_recovery_secrets (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  recovery_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.user_recovery_secrets enable row level security;
revoke all on table public.user_recovery_secrets from public, anon, authenticated;
grant all on table public.user_recovery_secrets to postgres, service_role, supabase_auth_admin;

create table if not exists public.recovery_attempts (
  id           bigint generated always as identity primary key,
  username_key text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists recovery_attempts_lookup_idx
  on public.recovery_attempts (username_key, attempted_at desc);

alter table public.recovery_attempts enable row level security;
revoke all on table public.recovery_attempts from public, anon, authenticated;
grant all on table public.recovery_attempts to postgres, service_role, supabase_auth_admin;

-- ---------- 3. Auto-confirm accounts on signup -------------------------------
create or replace function public.auto_confirm_kafkasino_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  return new;
end;
$$;

drop trigger if exists on_auth_user_auto_confirm on auth.users;
create trigger on_auth_user_auto_confirm
  before insert on auth.users
  for each row execute function public.auto_confirm_kafkasino_user();

update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, now())
 where email_confirmed_at is null;

-- ---------- 4. Fault-Tolerant `handle_new_user()` Signup Trigger -------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public, extensions
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
  -- 1. Resolve username from metadata, or derive from internal email, or fallback to player_<id>
  if v_username is null and new.email is not null then
    v_email_local := split_part(new.email, '@', 1);
    v_email_local := regexp_replace(v_email_local, '^u\.|\.u$', '', 'g');
    v_email_local := regexp_replace(v_email_local, '[^A-Za-z0-9_]', '', 'g');
    if v_email_local ~ '^[A-Za-z0-9_]{3,20}$' then
      v_username := v_email_local;
    end if;
  end if;

  if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    v_username := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  -- If the username is already taken by another user, raise a clear error code
  if exists (
    select 1 from public.profiles
     where lower(username) = lower(v_username)
       and id <> new.id
  ) then
    raise exception 'username_taken';
  end if;

  -- 2. Ensure avatar exists in `public.avatars` (fallback to 'fox' if unknown)
  insert into public.avatars (id, display_name, image_path, sort_order)
  values ('fox', 'The Barrister â€” Fox', 'avatars/fox.jpg', 1)
  on conflict (id) do nothing;

  if not exists (select 1 from public.avatars where id = v_avatar) then
    v_avatar := 'fox';
  end if;

  -- 3. Insert into `public.profiles` (storing raw username, avatar_id, and recovery_phrase_hash)
  insert into public.profiles (id, username, avatar_id, recovery_phrase_hash)
  values (new.id, v_username, v_avatar, v_recovery_hash)
  on conflict (id) do update
    set username             = excluded.username,
        avatar_id            = excluded.avatar_id,
        recovery_phrase_hash = coalesce(excluded.recovery_phrase_hash, public.profiles.recovery_phrase_hash),
        updated_at           = now();

  -- 4. Also store bcrypt-salted hash in `public.user_recovery_secrets` if recovery hash was provided
  if v_recovery_hash is not null and char_length(v_recovery_hash) >= 16 then
    begin
      insert into public.user_recovery_secrets (user_id, recovery_hash, updated_at)
      values (new.id, extensions.crypt(v_recovery_hash, extensions.gen_salt('bf', 10)), now())
      on conflict (user_id) do update
        set recovery_hash = excluded.recovery_hash,
            updated_at    = now();
    exception when others then
      -- Fallback to storing the pre-hashed SHA-256 hex digest if pgcrypto is in a different schema
      insert into public.user_recovery_secrets (user_id, recovery_hash, updated_at)
      values (new.id, v_recovery_hash, now())
      on conflict (user_id) do update
        set recovery_hash = excluded.recovery_hash,
            updated_at    = now();
    end;
  end if;

  -- 5. Provision role and wallet
  insert into public.user_roles (user_id, role)
  values (new.id, 'player')
  on conflict (user_id, role) do nothing;

  insert into public.wallets (user_id, balance)
  values (new.id, 0)
  on conflict (user_id) do nothing;

  -- 6. Award 10x starting balance
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

-- Backfill `recovery_phrase_hash` on any existing profiles from user metadata
update public.profiles p
   set recovery_phrase_hash = coalesce(
         p.recovery_phrase_hash,
         nullif(trim(u.raw_user_meta_data ->> 'recovery_phrase_hash'), ''),
         nullif(trim(u.raw_user_meta_data ->> 'recovery_digest'), '')
       )
  from auth.users u
 where u.id = p.id
   and p.recovery_phrase_hash is null
   and coalesce(
         nullif(trim(u.raw_user_meta_data ->> 'recovery_phrase_hash'), ''),
         nullif(trim(u.raw_user_meta_data ->> 'recovery_digest'), '')
       ) is not null;

-- Helper RPC to persist recovery phrase hash for the signed-in user
create or replace function public.save_recovery_phrase_hash(p_recovery_hash text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_hash text := nullif(trim(p_recovery_hash), '');
begin
  if v_uid is null or v_hash is null then
    return;
  end if;

  update public.profiles
     set recovery_phrase_hash = v_hash,
         updated_at           = now()
   where id = v_uid;

  begin
    insert into public.user_recovery_secrets (user_id, recovery_hash, updated_at)
    values (v_uid, extensions.crypt(v_hash, extensions.gen_salt('bf', 10)), now())
    on conflict (user_id) do update
      set recovery_hash = excluded.recovery_hash,
          updated_at    = now();
  exception when others then
    insert into public.user_recovery_secrets (user_id, recovery_hash, updated_at)
    values (v_uid, v_hash, now())
    on conflict (user_id) do update
      set recovery_hash = excluded.recovery_hash,
          updated_at    = now();
  end;
end;
$$;

revoke all on function public.save_recovery_phrase_hash(text) from public;
grant execute on function public.save_recovery_phrase_hash(text)
  to authenticated, service_role, postgres;

-- ---------- 5. Keep synthetic email synced when username is updated ----------
create or replace function public.update_profile(p_username text default null, p_avatar_id text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid   uuid := public.require_uid();
  v_name  text := nullif(trim(p_username), '');
  v_local text;
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

  if v_name is not null then
    v_local := case
      when lower(v_name) ~ '^[a-z0-9].*[a-z0-9]$' then lower(v_name)
      else 'u.' || lower(v_name) || '.u'
    end;
    begin
      update auth.users
         set email              = v_local || '@kafkasino.com',
             raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{username}', to_jsonb(v_name)),
             updated_at         = now()
       where id = v_uid;
    exception when others then
      null;
    end;
  end if;
end;
$$;

-- ---------- 6. Password Reset via Username + Recovery Phrase -----------------
create or replace function public.reset_password_with_recovery(
  p_username        text,
  p_recovery_digest text,
  p_new_password    text
)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uname_clean  text := lower(trim(coalesce(p_username, '')));
  v_digest       text := trim(coalesce(p_recovery_digest, ''));
  v_new_pw       text := coalesce(p_new_password, '');
  v_fails        int;
  v_user_id      uuid;
  v_profile_hash text;
  v_secret_hash  text;
  v_meta_digest  text;
  v_matched      boolean := false;
begin
  if v_uname_clean !~ '^[a-z0-9_]{3,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_username');
  end if;

  if char_length(v_new_pw) < 8 then
    return jsonb_build_object('ok', false, 'error', 'password_too_short');
  end if;

  if char_length(v_digest) < 16 then
    return jsonb_build_object('ok', false, 'error', 'invalid_recovery_phrase');
  end if;

  -- Prune old attempt logs and enforce 5 attempts / 15 minutes rate limit per username.
  delete from public.recovery_attempts
   where attempted_at < now() - interval '1 hour';

  select count(*) into v_fails
    from public.recovery_attempts
   where username_key = v_uname_clean
     and attempted_at > now() - interval '15 minutes';

  if v_fails >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_recovery_attempts');
  end if;

  select p.id,
         p.recovery_phrase_hash,
         urs.recovery_hash,
         coalesce(
           u.raw_user_meta_data ->> 'recovery_phrase_hash',
           u.raw_user_meta_data ->> 'recovery_digest'
         )
    into v_user_id, v_profile_hash, v_secret_hash, v_meta_digest
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.user_recovery_secrets urs on urs.user_id = p.id
   where lower(p.username) = v_uname_clean;

  if v_user_id is null then
    insert into public.recovery_attempts (username_key) values (v_uname_clean);
    return jsonb_build_object('ok', false, 'error', 'invalid_recovery_phrase');
  end if;

  if v_profile_hash is not null and v_profile_hash = v_digest then
    v_matched := true;
  elsif v_meta_digest is not null and v_meta_digest = v_digest then
    v_matched := true;
  elsif v_secret_hash is not null then
    if v_secret_hash = v_digest then
      v_matched := true;
    else
      begin
        if v_secret_hash = extensions.crypt(v_digest, v_secret_hash) then
          v_matched := true;
        end if;
      exception when others then
        v_matched := false;
      end;
    end if;
  end if;

  if not v_matched then
    insert into public.recovery_attempts (username_key) values (v_uname_clean);
    return jsonb_build_object('ok', false, 'error', 'invalid_recovery_phrase');
  end if;

  -- Verified! Update the user's password in auth.users using bcrypt.
  update auth.users
     set encrypted_password = extensions.crypt(v_new_pw, extensions.gen_salt('bf', 10)),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at         = now()
   where id = v_user_id;

  delete from public.recovery_attempts where username_key = v_uname_clean;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.reset_password_with_recovery(text, text, text) from public;
grant execute on function public.reset_password_with_recovery(text, text, text)
  to anon, authenticated, service_role, postgres;

-- ---------- 7. Allow bootstrap_admin() to accept either username or email ----
create or replace function public.bootstrap_admin(p_email text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user  uuid;
  v_clean text := lower(trim(coalesce(p_email, '')));
begin
  select id into v_user
    from auth.users
   where lower(email) in (v_clean, v_clean || '@kafkasino.com', v_clean || '@kafkasino.local')
   limit 1;

  if v_user is null then
    select id into v_user
      from public.profiles
     where lower(username) = v_clean
     limit 1;
  end if;

  if v_user is null then
    raise exception 'user_not_found';
  end if;
  if exists (select 1 from public.user_roles where role = 'admin') then
    raise exception 'admin_already_exists';
  end if;
  insert into public.user_roles (user_id, role) values (v_user, 'admin');
  return v_user;
end;
$$;

revoke all on function public.bootstrap_admin(text) from public, anon, authenticated;
grant execute on function public.bootstrap_admin(text) to postgres, service_role;

-- ---------- 8. Ensure `apply_balance_delta` Overloads & Game Catalog ---------
alter table public.wallet_transactions
  drop constraint if exists wallet_transactions_kind_check;

alter table public.wallet_transactions
  add constraint wallet_transactions_kind_check
  check (kind in (
    'starting_bonus','daily_bonus','bet','win','refund',
    'game_bet','game_win','game_refund','purchase',
    'tournament_entry','tournament_refund','tournament_prize','admin_adjust'
  ));

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

insert into public.game_catalog (slug, name, min_players, max_players, is_enabled) values
  ('blackjack', 'Blackjack',      1, 5, true),
  ('roulette',  'Roulette',       1, 8, true),
  ('slots',     'Slots',          1, 1, true),
  ('poker',     'Texas Hold''em', 2, 6, true),
  ('durak',     'Durak',          2, 4, true),
  ('chess',     'Chess',          2, 2, true),
  ('checkers',  'Checkers',       2, 2, true)
on conflict (slug) do update
  set name        = excluded.name,
      min_players = excluded.min_players,
      max_players = excluded.max_players,
      is_enabled  = true;

-- ---------- 9. Crucial Grants for Supabase Auth (`supabase_auth_admin`) ------
grant usage on schema public to postgres, anon, authenticated, service_role, supabase_auth_admin;
grant all on all tables    in schema public to postgres, service_role, supabase_auth_admin;
grant all on all sequences in schema public to postgres, service_role, supabase_auth_admin;
grant execute on all functions in schema public to postgres, service_role, supabase_auth_admin;
grant execute on function public.apply_balance_delta(bigint, text, jsonb) to authenticated;


-- =============================================================================
-- FILE: 20261030000015_fix_apply_balance_delta.sql
-- =============================================================================
-- =============================================================================
-- Kafkasino :: Migration 15 â€” Fix `apply_balance_delta` RPC & Enable All Games
-- =============================================================================
-- 1. Expands `wallet_transactions_kind_check` on `public.wallet_transactions`
--    so that `'game_bet'`, `'game_win'`, and `'game_refund'` (used by all 7
--    game engines) are permitted alongside `'bet'`, `'win'`, `'refund'`, etc.
-- 2. Defines all overloaded signatures of `public.apply_balance_delta` so that:
--    - 7-arg signature `(uuid, bigint, text, text, text, text, jsonb)` works
--    - 6-arg signature `(uuid, bigint, text, jsonb, uuid, text)` called by
--      Blackjack, Roulette, Slots, Texas Hold'em, Durak, Chess, Checkers, and
--      `claim_turn_timeout` resolves without throwing "function ... does not exist"
--    - 3-arg signature `(bigint, text, jsonb)` works for direct authenticated RPCs
--    - Missing wallet rows are automatically provisioned with the starting balance.
-- 3. Ensures all 7 games (`blackjack`, `roulette`, `slots`, `poker`, `durak`,
--    `chess`, `checkers`) exist in `public.game_catalog` with `is_enabled = true`.
-- =============================================================================

-- ---------- 1. Expand `wallet_transactions.kind` check constraint ------------
alter table public.wallet_transactions
  drop constraint if exists wallet_transactions_kind_check;

alter table public.wallet_transactions
  add constraint wallet_transactions_kind_check
  check (kind in (
    'starting_bonus','daily_bonus','bet','win','refund',
    'game_bet','game_win','game_refund','purchase',
    'tournament_entry','tournament_refund','tournament_prize','admin_adjust'
  ));

-- ---------- 2. Canonical 7-Argument `apply_balance_delta` --------------------
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

-- ---------- 3. 6-Argument Overload Used by All 7 Game Engines ----------------
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

-- ---------- 4. 3-Argument Convenience Overload for Authenticated Clients -----
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

grant execute on function public.apply_balance_delta(uuid, bigint, text, text, text, text, jsonb)
  to postgres, service_role, supabase_auth_admin;
grant execute on function public.apply_balance_delta(uuid, bigint, text, jsonb, uuid, text)
  to postgres, service_role, supabase_auth_admin;
grant execute on function public.apply_balance_delta(bigint, text, jsonb)
  to authenticated, postgres, service_role, supabase_auth_admin;

-- ---------- 5. Ensure All 7 Games Are Enabled in `public.game_catalog` -------
insert into public.game_catalog (slug, name, min_players, max_players, is_enabled) values
  ('blackjack', 'Blackjack',      1, 5, true),
  ('roulette',  'Roulette',       1, 8, true),
  ('slots',     'Slots',          1, 1, true),
  ('poker',     'Texas Hold''em', 2, 6, true),
  ('durak',     'Durak',          2, 4, true),
  ('chess',     'Chess',          2, 2, true),
  ('checkers',  'Checkers',       2, 2, true)
on conflict (slug) do update
  set name        = excluded.name,
      min_players = excluded.min_players,
      max_players = excluded.max_players,
      is_enabled  = true;


