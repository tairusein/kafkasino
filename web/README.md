# Kafkasino — web (Step 2: auth, routing, avatars)

Stack: Vite · React 18 · TypeScript · React Router 6 · supabase-js 2. Requires Node 20+.

```
cd web
npm install
copy .env.example .env.local     # then fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run typecheck
npm run dev                      # http://localhost:5173
```

## Routes

| Path | Access | Notes |
|---|---|---|
| `/login`, `/register` | signed-out only | signed-in users are redirected (back to the page they wanted, or `/`) |
| `/` | signed-in | Home with the editable Featured Tournament Hero Banner |
| `/lobby` | signed-in | Game catalogue, Create Public/Private Table, Join by 6-char PIN, live Public Rooms |
| `/games/:gameType/:roomId` | signed-in | Realtime Game Room (seats, 15s turn clock + AFK auto-action, quick & interactive emotes, table chat) |
| `/tournaments`, `/tournaments/:id` | signed-in | dedicated Tournament Participation Page (register/withdraw, live roster, countdown) |
| `/shop` | signed-in | Customization Shop (vector card backs & targeted interactive emotes) |
| `/profile` | signed-in | edit username/avatar via the `update_profile` RPC; balance is read-only |
| `/admin` | signed-in Admin (`RequireAdmin`) | Admin Panel (banner/tournament manager, `app_config` editor, ledgered balance adjustments) |

## Step 3: header, presence, audio

- **Global header** (`components/AppLayout.tsx`): logo, nav, live balance, sound toggle, user chip, sign out. The slot for Claim Bonus (Step 5) is marked.
- **Online status** (`presence/PresenceProvider.tsx`): private Realtime Presence channel `presence:global`, keyed by user id. `<Avatar userId=… />` draws a solid green dot at the bottom-right when that user is online; it is used site-wide (header, profile, lobby "Online now").
- **Live balance** (`wallet/WalletProvider.tsx`): read-only mirror of `wallets` via `postgres_changes`, re-fetched on every (re)subscribe so a dropped connection cannot leave it stale.
- **Sound** (`audio/`): Web Audio engine with master volume/mute (persisted), lazy unlock on first gesture, and procedural effects with no files needed: `uiClick`, `notify`, `chipClick`, `chipStack`, `cardShuffle`, `cardDeal`, `cardFlip`, `win`, `lose`, `slotStop`, plus `startSlotSpin()` and `playRouletteBall(ms)`. Use from any component: `const { sound } = useSound(); sound.play('chipClick')`. To use recordings, put files in `public/sounds/` and map them in `SOUND_FILES` (`audio/SoundManager.ts`).

## Step 4: Admin & Tournaments

- **Admin RBAC & Route Guard** (`auth/AuthProvider.tsx`, `auth/guards.tsx`): `AuthProvider` resolves `isAdmin` from `public.user_roles`. `<RequireAdmin />` guards `/admin` on the client while RLS and `public.is_admin()` enforce every write on the server.
- **Editable Homepage Hero Banner** (`components/TournamentBanner.tsx`): displays the featured tournament’s date (`starts_at`), prize name (`prize_name`), and prize image (`prize_image_path` — vector SVG presets in `public/tournaments/*.svg` or Admin-uploaded images in the `tournament-images` Storage bucket). Clicking the banner routes to `/tournaments/:id`. The Admin can edit the banner inline on the Homepage or from `/admin`.
- **Tournament Participation Page** (`pages/TournamentPage.tsx`): dedicated page at `/tournaments` and `/tournaments/:id` with live countdown, prize showcase, Realtime roster with online status dots, and atomic registration/withdrawal (`register_for_tournament` / `unregister_from_tournament` RPCs).
- **Admin Panel** (`pages/AdminPage.tsx`): full tournament CRUD + banner switcher (`admin_set_featured_tournament`), house tunables (`admin_set_config`), and audited player balance adjustments (`admin_adjust_balance`).

## Step 5: Economy & Shop

- **Daily Bonus** (`components/ClaimBonus.tsx` + `components/BalanceChip.tsx`): rendered next to the user's balance in the global header. Queries `get_bonus_status()`; when available, shows the **Claim Bonus** button. On click, the button disappears immediately, `claim_daily_bonus()` executes on the server, a smooth vector coin-burst animation flies into the balance chip while the balance counts up, and a server-clock-aligned countdown timer to **03:00 AM** replaces the button.
- **Customization Shop** (`pages/ShopPage.tsx`, `/shop`):
  - **Custom Card Backs**: 5 bespoke vector SVG designs (`public/shop-assets/card-backs/*.svg`) plus the House Standard card back. Purchased via `purchase_item()` (with idempotency keys) and equipped/unequipped via `equip_card_back()`.
  - **Premium Interactive Emotes** (`components/InteractiveEmotePreview.tsx`): 5 targeted avatar-to-avatar animations (`slap`, `punch`, `poop`, `tomato`, `toast`) sold in consumable charge packs (`user_items`) with a live interactive preview stage.

## Step 6: Game Engine Core

- **Zero-Desync Realtime Engine** (`game/useRoomEngine.ts`): combines a database `postgres_changes` channel (`room-db:<roomId>`) with strict `game_states.version` gap detection (triggering an immediate full snapshot resync on any missed version, reconnect, or tab visibility restore) and a private Broadcast/Presence channel (`room:<roomId>`).
- **15-Second Turn Timer & AFK Enforcement** (`supabase/migrations/20261030000010_game_engine_core.sql`, `supabase/functions/game-engine/index.ts`): server-clock-calibrated 15s countdown per turn (`turn_deadline`). When expired, `claim_turn_timeout()` atomically marks the player `afk` via `force_afk()`, executes the game's neutral action (`stand` / `check_fold` / `skip`), and advances the turn without delaying the room. Returning players click **I'm Back** (`return_from_afk()`).
- **Public & Private PIN Rooms** (`pages/LobbyPage.tsx`, `pages/GameRoomPage.tsx`): create public or private rooms, share/copy the host-only 6-character PIN (`room_secrets`), or join private rooms by PIN (`join_room_by_pin`).
- **Chat, Quick Emotes & Targeted Interactive Emotes**: in-game text chat (`send_chat_message`), 1-tap quick-emote speech bubbles over avatars (`lib/emotes.ts`), and server-verified consumable interactive emotes (`use_interactive_emote`).

## Notes


- **Remember me:** ticked → session in `localStorage` (survives restarts); unticked → `sessionStorage` (ends with the browser tab). See `src/lib/supabase.ts`.
- **Registration** sends `username` + `avatar_id` as signup metadata; the database trigger validates them, creates the profile and grants the 10× starting balance. The client cannot set or alter any balance.
- If your Supabase project has *Confirm email* enabled, the register page shows a "check your inbox" screen instead of signing in.
- Production hosting must rewrite unknown paths to `index.html` (SPA routing).
- Avatars are served from `public/avatars/<id>.jpg` (see `src/lib/avatars.ts`, kept in sync with `public.avatars`).

