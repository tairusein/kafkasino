-- =============================================================================
-- Kafkasino :: Step 7 / Migration 11 — Blackjack Authoritative Engine
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

