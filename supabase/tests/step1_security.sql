-- =============================================================================
-- Kafkasino :: Step 1 security & economy tests (plain SQL, no pgTAP needed)
-- Run against a LOCAL/disposable database after `supabase db reset`:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/step1_security.sql
-- Everything runs in one transaction that is rolled back. Any failed ASSERT aborts.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

-- ---------- fixtures (as postgres) ---------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.dev', '{"username":"alice","avatar_id":"owl"}'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.dev', '{"username":"bob","avatar_id":"bear"}'),
  ('00000000-0000-0000-0000-00000000000c', 'c@test.dev', '{"username":"carol","avatar_id":"wolf"}'),
  ('00000000-0000-0000-0000-00000000000d', 'admin@test.dev', '{"username":"boss","avatar_id":"lion"}');

do $$
begin
  -- starting capital is exactly 10x the daily bonus
  assert (select balance from public.wallets where user_id = '00000000-0000-0000-0000-00000000000a')
       = 10 * public.cfg_int('daily_bonus_amount'), 'starting balance must be 10x daily bonus';
  assert (select count(*) from public.wallet_transactions
           where user_id = '00000000-0000-0000-0000-00000000000a' and kind = 'starting_bonus') = 1;
  assert (select avatar_id from public.profiles where id = '00000000-0000-0000-0000-00000000000a') = 'owl';
  -- bad avatar rejected
  begin
    insert into auth.users (id, email, raw_user_meta_data)
    values (gen_random_uuid(), 'x@test.dev', '{"username":"xavier","avatar_id":"dragon"}');
    raise exception 'SHOULD HAVE FAILED: invalid avatar';
  exception when raise_exception then
    assert sqlerrm = 'invalid_avatar', 'unexpected error: ' || sqlerrm;
  end;
  -- bonus period boundaries (Europe/Berlin, CET = +01 on 2026-10-30)
  assert public.bonus_period_start('2026-10-30 02:59:59+01') = '2026-10-29 03:00:00+01'::timestamptz;
  assert public.bonus_period_start('2026-10-30 03:00:00+01') = '2026-10-30 03:00:00+01'::timestamptz;
  assert public.bonus_next_reset ('2026-10-30 03:00:00+01') = '2026-10-31 03:00:00+01'::timestamptz;
  -- single admin
  perform public.bootstrap_admin('admin@test.dev');
  begin
    perform public.bootstrap_admin('a@test.dev');
    raise exception 'SHOULD HAVE FAILED: second admin';
  exception when raise_exception then
    assert sqlerrm = 'admin_already_exists';
  end;
end $$;

-- ---------- as Alice -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare r jsonb; v_item uuid; v_bal bigint;
begin
  -- she sees only her own wallet
  assert (select count(*) from public.wallets) = 1, 'alice must only see her own wallet';
  assert (select count(*) from public.wallet_transactions) = 1;

  -- every direct write path is denied
  begin update public.wallets set balance = 999999999; raise exception 'SHOULD HAVE FAILED: wallet update';
  exception when insufficient_privilege then null; end;
  begin insert into public.wallets (user_id, balance) values (gen_random_uuid(), 5); raise exception 'SHOULD HAVE FAILED: wallet insert';
  exception when insufficient_privilege then null; end;
  begin delete from public.wallet_transactions; raise exception 'SHOULD HAVE FAILED: ledger delete';
  exception when insufficient_privilege then null; end;
  begin update public.profiles set username = 'hacker'; raise exception 'SHOULD HAVE FAILED: profile update';
  exception when insufficient_privilege then null; end;
  begin insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-00000000000a', 'admin'); raise exception 'SHOULD HAVE FAILED: self-promote';
  exception when insufficient_privilege then null; end;
  begin insert into public.user_items (user_id, item_id) select '00000000-0000-0000-0000-00000000000a', id from public.shop_items limit 1; raise exception 'SHOULD HAVE FAILED: free item';
  exception when insufficient_privilege then null; end;
  begin insert into public.rooms (game_type, name, host_id, max_players) values ('blackjack', 'x', '00000000-0000-0000-0000-00000000000a', 4); raise exception 'SHOULD HAVE FAILED: direct room insert';
  exception when insufficient_privilege then null; end;
  begin perform public.apply_balance_delta('00000000-0000-0000-0000-00000000000a', 1000000, 'win'); raise exception 'SHOULD HAVE FAILED: apply_balance_delta';
  exception when insufficient_privilege then null; end;
  begin perform public.force_afk(gen_random_uuid(), gen_random_uuid()); raise exception 'SHOULD HAVE FAILED: force_afk';
  exception when insufficient_privilege then null; end;
  begin perform public.bootstrap_admin('a@test.dev'); raise exception 'SHOULD HAVE FAILED: bootstrap_admin';
  exception when insufficient_privilege then null; end;

  -- not an admin
  begin perform public.admin_set_config('daily_bonus_amount', '99999'::jsonb); raise exception 'SHOULD HAVE FAILED: admin_set_config';
  exception when insufficient_privilege then null; end;
  begin perform public.admin_adjust_balance('00000000-0000-0000-0000-00000000000a', 1000000, 'cheating'); raise exception 'SHOULD HAVE FAILED: admin_adjust';
  exception when insufficient_privilege then null; end;
  begin insert into public.tournaments (title, prize_name, starts_at) values ('t', 'p', now()); raise exception 'SHOULD HAVE FAILED: non-admin tournament insert';
  exception when insufficient_privilege then null; end;
  begin insert into public.shop_items (slug, kind, name, price) values ('free', 'card_back', 'Free', 0); raise exception 'SHOULD HAVE FAILED: non-admin shop insert';
  exception when insufficient_privilege then null; end;

  -- daily bonus: once per period
  assert (public.get_bonus_status() ->> 'can_claim')::boolean = true;
  r := public.claim_daily_bonus();
  assert (r ->> 'balance')::bigint = 11000, 'bonus credited';
  assert (public.get_bonus_status() ->> 'can_claim')::boolean = false;
  begin perform public.claim_daily_bonus(); raise exception 'SHOULD HAVE FAILED: double claim';
  exception when raise_exception then assert sqlerrm = 'bonus_already_claimed'; end;

  -- shop: server-priced, idempotent, no overdraft, no duplicates of cosmetics
  select id into v_item from public.shop_items where slug = 'cb-burgundy-classic';
  r := public.purchase_item(v_item, 1, 'k1');
  assert (r ->> 'balance')::bigint = 9000;
  r := public.purchase_item(v_item, 1, 'k1');                   -- replay: no second charge
  assert (r ->> 'replayed')::boolean and (r ->> 'balance')::bigint = 9000;
  begin perform public.purchase_item(v_item, 1, 'k2'); raise exception 'SHOULD HAVE FAILED: duplicate cosmetic';
  exception when raise_exception then assert sqlerrm = 'already_owned'; end;
  begin perform public.purchase_item((select id from public.shop_items where slug = 'cb-royal-monogram')); raise exception 'SHOULD HAVE FAILED: overdraft';
  exception when raise_exception then assert sqlerrm = 'insufficient_funds'; end;
  perform public.equip_card_back(v_item);
  begin perform public.equip_card_back((select id from public.shop_items where slug = 'cb-gold-crest')); raise exception 'SHOULD HAVE FAILED: equip unowned';
  exception when raise_exception then assert sqlerrm = 'item_not_owned'; end;
  r := public.purchase_item((select id from public.shop_items where slug = 'em-slap'), 2);
  assert (select quantity from public.user_items where item_id = (select id from public.shop_items where slug = 'em-slap')) = 10, '2 packs x 5 charges';

  select balance into v_bal from public.wallets;
  assert v_bal = 9000 - 600;
  -- ledger always reconciles with the balance
  assert (select sum(amount) from public.wallet_transactions) = v_bal, 'ledger must sum to balance';
end $$;

-- ---------- rooms: public / private / PIN ---------------------------------------------
do $$
declare r jsonb;
begin
  r := public.create_room('blackjack', 'Alice''s secret table', 'private', 4, 100);
  assert (r ->> 'pin') ~ '^[A-HJ-NP-Z2-9]{6}$';
  perform set_config('kafka.room', r ->> 'room_id', true);
  perform set_config('kafka.pin',  r ->> 'pin', true);
  assert (select count(*) from public.room_secrets) = 1, 'host can read the PIN';
  begin perform public.create_room('poker', 'x'); raise exception 'SHOULD HAVE FAILED: disabled game';
  exception when raise_exception then assert sqlerrm = 'game_not_available'; end;
  begin perform public.create_room('blackjack', 'again'); raise exception 'SHOULD HAVE FAILED: second room';
  exception when raise_exception then assert sqlerrm = 'already_in_another_room'; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);

do $$
declare r jsonb; v_room uuid := current_setting('kafka.room')::uuid;
begin
  assert (select count(*) from public.rooms where id = v_room) = 0, 'private room hidden from outsiders';
  assert (select count(*) from public.room_secrets) = 0, 'PIN never leaks';
  begin perform public.join_room(v_room); raise exception 'SHOULD HAVE FAILED: join private by id';
  exception when raise_exception then assert sqlerrm = 'room_not_found'; end;
  r := public.join_room_by_pin('ZZZZZZ');
  assert (r ->> 'ok')::boolean = false, 'wrong pin rejected';
  r := public.join_room_by_pin(lower(current_setting('kafka.pin')));
  assert (r ->> 'ok')::boolean and (r ->> 'seat')::int = 1, 'bob seated at seat 1 via PIN';
  assert (select count(*) from public.game_states where room_id = v_room) = 1, 'member can read state';
  perform public.send_chat_message(v_room, '  hello table  ');
  assert (select body from public.chat_messages where room_id = v_room) = 'hello table';
  begin perform public.send_chat_message(v_room, 'spam'); raise exception 'SHOULD HAVE FAILED: rate limit';
  exception when raise_exception then assert sqlerrm = 'rate_limited'; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);

do $$
declare v_room uuid := current_setting('kafka.room')::uuid; i int;
begin
  assert (select count(*) from public.game_states) = 0, 'outsider cannot read game state';
  assert (select count(*) from public.chat_messages) = 0, 'outsider cannot read chat';
  assert (select count(*) from public.game_private_states) = 0;
  begin perform public.send_chat_message(v_room, 'let me in'); raise exception 'SHOULD HAVE FAILED: chat outsider';
  exception when insufficient_privilege then null; end;
  -- PIN brute-force throttle: 10 failures then locked out
  for i in 1..10 loop perform public.join_room_by_pin('AAAAA' || (i % 8 + 2)::text); end loop;
  begin perform public.join_room_by_pin(current_setting('kafka.pin')); raise exception 'SHOULD HAVE FAILED: throttle';
  exception when raise_exception then assert sqlerrm = 'too_many_attempts'; end;
end $$;

-- ---------- admin / tournaments / config -------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);

do $$
declare v_t uuid; v_new_bal bigint;
begin
  assert public.is_admin();
  insert into public.tournaments (title, prize_name, starts_at, entry_fee, status, max_participants)
  values ('Autumn Cup', 'Gold Watch', now() + interval '2 days', 500, 'upcoming', 1)
  returning id into v_t;
  perform public.admin_set_featured_tournament(v_t);
  perform set_config('kafka.tournament', v_t::text, true);
  begin perform public.admin_set_config('bonus_timezone', '"Mars/Olympus"'::jsonb); raise exception 'SHOULD HAVE FAILED: bad tz';
  exception when raise_exception then assert sqlerrm = 'invalid_value'; end;
  perform public.admin_set_config('daily_bonus_amount', '500'::jsonb);
  v_new_bal := public.admin_adjust_balance('00000000-0000-0000-0000-00000000000c', 100, 'welcome gift');
  assert v_new_bal = 10000 + 100;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare v_t uuid := current_setting('kafka.tournament')::uuid; r jsonb; v_before bigint;
begin
  assert (select count(*) from public.tournaments where is_featured) = 1, 'banner visible';
  select balance into v_before from public.wallets;
  r := public.register_for_tournament(v_t);
  assert (r ->> 'balance')::bigint = v_before - 500;
  begin perform public.register_for_tournament(v_t); raise exception 'SHOULD HAVE FAILED: double register';
  exception when raise_exception then assert sqlerrm = 'already_registered'; end;
  r := public.unregister_from_tournament(v_t);
  assert (r ->> 'balance')::bigint = v_before, 'entry fee refunded';
end $$;

-- anon sees the public banner but nothing private
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  assert (select count(*) from public.tournaments where is_featured) = 1;
  assert (select count(*) from public.avatars) = 10;
  begin perform count(*) from public.wallets; raise exception 'SHOULD HAVE FAILED: anon wallet read';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.profiles; raise exception 'SHOULD HAVE FAILED: anon profile read';
  exception when insufficient_privilege then null; end;
end $$;

-- new user after config change: starting balance follows the 10x rule exactly
reset role;
do $$
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-00000000000e', 'e@test.dev', '{"username":"erin","avatar_id":"eagle"}');
  assert (select balance from public.wallets where user_id = '00000000-0000-0000-0000-00000000000e') = 5000;
  -- DB-level single-admin guarantee
  begin
    insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-00000000000e', 'admin');
    raise exception 'SHOULD HAVE FAILED: second admin row';
  exception when unique_violation then null; end;
end $$;

select 'ALL STEP 1 TESTS PASSED' as result;
rollback;
