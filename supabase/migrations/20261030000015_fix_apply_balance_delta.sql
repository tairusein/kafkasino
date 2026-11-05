-- =============================================================================
-- Kafkasino :: Migration 15 — Fix `apply_balance_delta` RPC & Enable All Games
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
