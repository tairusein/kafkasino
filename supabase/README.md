# Kafkasino — Step 1: Database & Security

Apply: `supabase db reset` (local) or `supabase db push` (linked project). Then verify (local/disposable DB only):

```
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/step1_security.sql
```

Create the one primary admin after signing up that account once:

```sql
select public.bootstrap_admin('you@example.com');   -- SQL editor / service role only
```

## Migrations

| File | Contents |
|---|---|
| `…01_core` | `app_config`, `app_role` enum, `user_roles` (DB-enforced single admin), `is_admin()`, `bootstrap_admin()`, `admin_set_config()` |
| `…02_profiles_wallet` | avatars (10), profiles, wallets, append-only ledger, `apply_balance_delta()`, signup trigger (10× starting capital), daily bonus, `update_profile()`, `admin_adjust_balance()` |
| `…03_shop` | shop items (5 card backs, 5 interactive emotes), inventory, `purchase_item()`, `equip_card_back()`, `consume_emote_charge()` |
| `…04_rooms_games` | game catalogue, rooms, PIN secrets, seats, authoritative `game_states` (+ version trigger), private hands, chat, room/AFK RPCs |
| `…05_tournaments` | tournaments (= homepage banner via `is_featured`), participants, register/unregister, admin featured switch |
| `…06_realtime_storage` | Realtime Broadcast/Presence authorization, publication, storage buckets/policies |
| `…07_lockdown_grants` | revoke everything, re-grant minimum (SELECT only + explicit RPCs) |
| `…08_avatar_image_paths` | point `public.avatars` image paths at `.jpg` portraits |
| `…09_tournaments_seed_realtime` | add `tournament_participants` to Realtime publication and seed initial featured homepage tournament |
| `…10_game_engine_core` | `get_server_time()`, `use_interactive_emote()`, 15s turn cycle & `claim_turn_timeout()` AFK neutral-action enforcement |
| `…11_blackjack_engine` | `game_server_secrets` (server-only shoe & hidden dealer hole card), `bj_build_shoe()`, `bj_hand_eval()`, `blackjack_start_round()`, `blackjack_place_bet()`, `blackjack_action()` (`hit`/`stand`/`double`), and 3:2 / 1:1 / push settlement via `apply_balance_delta()` |
| `…12_roulette_slots_engine` | Enables `roulette` & `slots` in `game_catalog`; `csprng_int()` (unbiased byte rejection sampling); European Roulette (97.30% RTP: `roulette_start_round()`, `roulette_place_bets()`, `roulette_execute_spin()`); Vintage 3-Reel Slots (94.53% RTP: `slots_spin()`) |
| `…13_scaling_games_engine` | Enables `poker`, `durak`, `chess`, & `checkers` in `game_catalog`; Texas Hold'em Poker (`poker_eval_7()`, `poker_start_hand()`, `poker_action()`, private hole cards in `game_private_states`); 36-Card Durak (`durak_start_game()`, `durak_action()`, private hands in `game_private_states`); 8×8 Chess (`chess_start_game()`, `chess_move()`); 8×8 Checkers (`checkers_start_game()`, `checkers_move()`); unified 15s `claim_turn_timeout()` across all 7 games |

## Security model

- **Balance is write-proof for clients.** `wallets`/`wallet_transactions` have no INSERT/UPDATE/DELETE privilege *and* no write policy for `anon`/`authenticated`. The only mutation primitive is `apply_balance_delta()` (row-locked, never negative, idempotency keys, ledger entry per change). It is executable by `service_role` only; client-callable RPCs reach it through `SECURITY DEFINER`.
- **Roles:** `user_roles` is read-own-only. A partial unique index guarantees at most one `admin`. Admin-only writes (tournaments, shop items, config, balance adjustments) are enforced by RLS/`is_admin()` — hiding the UI is never the guard.
- **Private rooms:** PINs live in `room_secrets` (host-readable only); join is via `join_room_by_pin()` with throttling (10 failures / 10 min). Private rooms are invisible to outsiders and cannot be joined by id.
- **Sync:** `game_states.version` must increase by exactly 1 per write (trigger), clients detect gaps and refetch. Hidden info goes only in `game_private_states` (owner-read). Writers = service-role Edge Functions only.
- **Realtime channels:** must be opened with `private: true`. `presence:global` and `room:<uuid>` (members only) are authorised via `realtime.messages` policies.
- All `SECURITY DEFINER` functions pin `search_path = ''`.

## Client-visible error codes (message text)

`not_authenticated`, `insufficient_funds`, `bonus_already_claimed`, `already_owned`, `item_not_found`, `item_not_owned`, `invalid_quantity`, `game_not_available`, `room_not_found`, `room_full`, `already_in_another_room`, `too_many_attempts`, `not_in_room`, `rate_limited`, `registration_closed`, `already_registered`, `tournament_full`, `not_registered`, `forbidden`.

## Known limitations / notes

- Presence payloads are client-asserted (any member could claim another uid in the payload); the UI should derive identity from the JWT `sub`, and anything with game impact is validated server-side anyway.
- `postgres_changes` DELETE events are not RLS-filtered by Supabase (they carry only primary keys). No sensitive data is exposed this way.
- Avatar/card-back image files referenced by the seeds (`avatars/*.svg`, `shop-assets/…`) are created in later steps.

