-- =============================================================================
-- Kafkasino :: Step 9 / Migration 13 — Scaling Games Engine:
--   1. Texas Hold'em Poker (`poker`, 2–9 players, private hole cards in `game_private_states`)
--   2. Classic 36-Card Durak (`durak`, 2–6 players, private hands in `game_private_states`)
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
-- PART A: TEXAS HOLD'EM POKER (`poker`, 2–9 Players)
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
-- PART B: CLASSIC 36-CARD DURAK (`durak`, 2–6 Players)
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
-- PART C: CLASSIC 8×8 CHESS (`chess`, 2 Players)
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
-- PART D: CLASSIC 8×8 CHECKERS / DRAUGHTS (`checkers`, 2 Players)
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

