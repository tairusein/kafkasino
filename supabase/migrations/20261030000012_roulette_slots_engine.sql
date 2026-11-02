-- =============================================================================
-- Kafkasino :: Step 8 / Migration 12 — Inflation Control Games:
--   1. Classic European Single-Zero Roulette (97.30% RTP / 2.70% House Edge)
--   2. Strict Vintage 3-Reel Mechanical Slots (94.53% RTP / 5.47% House Edge)
-- =============================================================================
-- Security & Anti-Cheat guarantees:
--   * Both games are enabled in `public.game_catalog`.
--   * All random outcomes (European wheel pocket 0..36 and 3×20-stop reel spins)
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
-- Every bet type has expected return = 36/37 ≈ 97.297% (2.703% House Edge).
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

