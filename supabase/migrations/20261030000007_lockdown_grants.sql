-- =============================================================================
-- Kafkasino :: Step 1 / Migration 7 — privilege lockdown (deny-by-default)
-- =============================================================================
-- Supabase auto-grants broad privileges on new public objects to anon/authenticated.
-- We strip ALL of them, then re-grant the minimum. RLS stays the second line of defence.
-- service_role (trusted Edge Functions) is intentionally left untouched.
--
-- !! Every future migration that adds a table or function MUST add its own grants.
--    The default-privilege revokes below make new objects private by default.

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

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

-- ---------- Functions: server-only (service_role / postgres) ------------------------
grant execute on function
  public.apply_balance_delta(uuid, bigint, text, text, text, text, jsonb),
  public.consume_emote_charge(uuid, uuid),
  public.force_afk(uuid, uuid),
  public.bootstrap_admin(text)
  to service_role;

