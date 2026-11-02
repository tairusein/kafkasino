-- =============================================================================
-- Kafkasino :: Step 6 / Migration 10 — Game Engine Core:
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

