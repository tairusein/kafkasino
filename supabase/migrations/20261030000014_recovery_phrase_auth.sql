-- =============================================================================
-- Kafkasino :: Migration 14 — Username + Password + Recovery Phrase Auth Fix
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
  ('fox',      'The Barrister — Fox',        'avatars/fox.jpg',      1),
  ('owl',      'The Professor — Owl',        'avatars/owl.jpg',      2),
  ('bear',     'The Executive — Bear',       'avatars/bear.jpg',     3),
  ('wolf',     'The Detective — Wolf',       'avatars/wolf.jpg',     4),
  ('lion',     'The Chairman — Lion',        'avatars/lion.jpg',     5),
  ('raccoon',  'The Accountant — Raccoon',   'avatars/raccoon.jpg',  6),
  ('elephant', 'The Diplomat — Elephant',    'avatars/elephant.jpg', 7),
  ('penguin',  'The Maître d'' — Penguin',   'avatars/penguin.jpg',  8),
  ('eagle',    'The Captain — Eagle',        'avatars/eagle.jpg',    9),
  ('panther',  'The Gentleman — Panther',    'avatars/panther.jpg', 10)
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
  values ('fox', 'The Barrister — Fox', 'avatars/fox.jpg', 1)
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

-- ---------- 8. Crucial Grants for Supabase Auth (`supabase_auth_admin`) ------
grant usage on schema public to postgres, anon, authenticated, service_role, supabase_auth_admin;
grant all on all tables    in schema public to postgres, service_role, supabase_auth_admin;
grant all on all sequences in schema public to postgres, service_role, supabase_auth_admin;
grant execute on all functions in schema public to postgres, service_role, supabase_auth_admin;
