-- =============================================================================
-- Kafkasino :: Step 1 / Migration 1 — core: config, RBAC, shared helpers
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

