-- =============================================================================
-- Kafkasino :: Migration 14 — Username + Password + Bcrypt Recovery Phrase Auth
-- =============================================================================
-- 1. Auto-confirms synthetic `@kafkasino.local` emails on signup so users never
--    need an email address or inbox confirmation.
-- 2. Stores the bcrypt-hashed recovery phrase in a strictly server-only table
--    (`public.user_recovery_secrets`, RLS enabled, zero client privileges).
-- 3. Keeps `auth.users.email` synchronized with `lower(username) || '@kafkasino.local'`
--    whenever a player changes their username via `public.update_profile()`.
-- 4. Provides `public.reset_password_with_recovery(p_username, p_recovery_digest, p_new_password)`
--    with brute-force rate limiting and constant-time `pgcrypto` bcrypt verification.
-- 5. Updates `public.bootstrap_admin(p_email)` to accept either a username or an email.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 1. Server-only Bcrypt Recovery Secrets & Brute-Force Throttle ----
create table if not exists public.user_recovery_secrets (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  recovery_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.user_recovery_secrets enable row level security;
revoke all on table public.user_recovery_secrets from public, anon, authenticated;
grant all on table public.user_recovery_secrets to service_role;

create table if not exists public.recovery_attempts (
  id           bigint generated always as identity primary key,
  username_key text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists recovery_attempts_lookup_idx
  on public.recovery_attempts (username_key, attempted_at desc);

alter table public.recovery_attempts enable row level security;
revoke all on table public.recovery_attempts from public, anon, authenticated;
grant all on table public.recovery_attempts to service_role;

-- ---------- 2. Auto-confirm @kafkasino.local accounts on signup --------------
create or replace function public.auto_confirm_kafkasino_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.email like '%@kafkasino.local' then
    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_auto_confirm on auth.users;
create trigger on_auth_user_auto_confirm
  before insert on auth.users
  for each row execute function public.auto_confirm_kafkasino_user();

-- ---------- 3. Upgrade handle_new_user() to bcrypt-hash recovery phrase ------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = 'public, extensions'
as $$
declare
  v_username        text := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  v_avatar          text := nullif(new.raw_user_meta_data ->> 'avatar_id', '');
  v_recovery_digest text := nullif(trim(new.raw_user_meta_data ->> 'recovery_digest'), '');
  c_multiplier      constant bigint := 10;
  v_start           bigint;
begin
  if v_username is null then
    v_username := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  if v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid_username';
  end if;

  if v_avatar is null then
    v_avatar := 'fox';
  elsif not exists (select 1 from public.avatars where id = v_avatar) then
    raise exception 'invalid_avatar';
  end if;

  insert into public.profiles (id, username, avatar_id) values (new.id, v_username, v_avatar);
  insert into public.user_roles (user_id, role) values (new.id, 'player');
  insert into public.wallets (user_id, balance) values (new.id, 0);

  -- Hash the client SHA-256 recovery digest with bcrypt (cost 10) and purge it from raw_user_meta_data.
  if v_recovery_digest is not null and char_length(v_recovery_digest) >= 32 then
    insert into public.user_recovery_secrets (user_id, recovery_hash, updated_at)
    values (new.id, crypt(v_recovery_digest, gen_salt('bf', 10)), now())
    on conflict (user_id) do update
      set recovery_hash = excluded.recovery_hash,
          updated_at    = now();

    update auth.users
       set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'recovery_digest'
     where id = new.id;
  end if;

  v_start := c_multiplier * public.cfg_int('daily_bonus_amount');
  perform public.apply_balance_delta(
    new.id, v_start, 'starting_bonus', 'user', new.id::text,
    'starting_bonus:' || new.id::text,
    jsonb_build_object('multiplier', c_multiplier, 'daily_bonus', public.cfg_int('daily_bonus_amount'))
  );
  return new;
end;
$$;

-- ---------- 4. Keep synthetic email synced when username is updated ----------
create or replace function public.update_profile(p_username text default null, p_avatar_id text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.require_uid();
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

  if v_name is not null then
    update auth.users
       set email              = lower(v_name) || '@kafkasino.local',
           raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{username}', to_jsonb(v_name)),
           updated_at         = now()
     where id = v_uid;
  end if;
end;
$$;

-- ---------- 5. Password Reset via Username + Recovery Phrase -----------------
-- Returns JSONB `{ ok: boolean, error?: text }` instead of raising on wrong phrase
-- so the brute-force throttle row in `public.recovery_attempts` is committed.
create or replace function public.reset_password_with_recovery(
  p_username        text,
  p_recovery_digest text,
  p_new_password    text
)
returns jsonb
language plpgsql security definer
set search_path = 'public, extensions'
as $$
declare
  v_uname_clean text := lower(trim(coalesce(p_username, '')));
  v_digest      text := trim(coalesce(p_recovery_digest, ''));
  v_new_pw      text := coalesce(p_new_password, '');
  v_fails       int;
  v_user_id     uuid;
  v_stored_hash text;
begin
  if v_uname_clean !~ '^[a-z0-9_]{3,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_username');
  end if;

  if char_length(v_new_pw) < 8 then
    return jsonb_build_object('ok', false, 'error', 'password_too_short');
  end if;

  if char_length(v_digest) < 32 then
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

  select p.id, urs.recovery_hash
    into v_user_id, v_stored_hash
    from public.profiles p
    join public.user_recovery_secrets urs on urs.user_id = p.id
   where lower(p.username) = v_uname_clean;

  if v_user_id is null or v_stored_hash is null then
    insert into public.recovery_attempts (username_key) values (v_uname_clean);
    return jsonb_build_object('ok', false, 'error', 'invalid_recovery_phrase');
  end if;

  -- Constant-time bcrypt comparison via pgcrypto `crypt(candidate, stored_hash)`
  if v_stored_hash <> crypt(v_digest, v_stored_hash) then
    insert into public.recovery_attempts (username_key) values (v_uname_clean);
    return jsonb_build_object('ok', false, 'error', 'invalid_recovery_phrase');
  end if;

  -- Verified! Update the user's password in auth.users using bcrypt.
  update auth.users
     set encrypted_password = crypt(v_new_pw, gen_salt('bf', 10)),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at         = now()
   where id = v_user_id;

  delete from public.recovery_attempts where username_key = v_uname_clean;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.reset_password_with_recovery(text, text, text) from public;
grant execute on function public.reset_password_with_recovery(text, text, text) to anon, authenticated;

-- ---------- 6. Allow bootstrap_admin() to accept either username or email ----
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
   where lower(email) in (v_clean, v_clean || '@kafkasino.local')
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
grant execute on function public.bootstrap_admin(text) to service_role;

