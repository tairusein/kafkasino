import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import type { QuickEmotePreset } from '../lib/emotes';
import { friendlyError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { useWallet } from '../wallet/WalletProvider';
import type {
  ChatMessageRow,
  GameStateRow,
  InteractiveEmoteAnimation,
  InteractiveEmoteEvent,
  PlayingCard,
  Profile,
  QuickEmoteEvent,
  Room,
  RoomPlayer,
  RoomSeatWithProfile,
  RouletteBetItem,
  ShopItem,
  UserItem,
} from '../lib/types';

export interface EmoteInventoryEntry {
  item: ShopItem;
  quantity: number;
}

export function useRoomEngine(roomId: string, invitePin: string | null = null) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { sound } = useSound();
  const { refresh: refreshWallet } = useWallet();

  const [room, setRoom] = useState<Room | null>(null);
  const [hostPin, setHostPin] = useState<string | null>(null);
  const [seats, setSeats] = useState<RoomSeatWithProfile[]>([]);
  const [gameState, setGameState] = useState<GameStateRow | null>(null);
  const [privateState, setPrivateState] = useState<Record<string, unknown>>({});
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [cardBackMap, setCardBackMap] = useState<Map<string, ShopItem>>(new Map());
  const [emoteInventory, setEmoteInventory] = useState<EmoteInventoryEntry[]>([]);
  const [roomOnlineIds, setRoomOnlineIds] = useState<ReadonlySet<string>>(new Set());

  const [quickEmotesByUser, setQuickEmotesByUser] = useState<Record<string, QuickEmoteEvent>>({});
  const [activeInteractiveEmote, setActiveInteractiveEmote] = useState<InteractiveEmoteEvent | null>(null);

  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'synced' | 'resyncing'>('connecting');
  const [error, setError] = useState<string | null>(null);

  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const versionRef = useRef<number>(-1);
  const bcastChannelRef = useRef<RealtimeChannel | null>(null);
  const timeoutClaimedForVersionRef = useRef<number>(-1);

  // Load seats + join their public profiles.
  const loadSeats = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('room_players')
      .select('*')
      .eq('room_id', roomId)
      .order('seat', { ascending: true });

    if (err || !data) return;
    const rows = data as RoomPlayer[];
    if (rows.length === 0) {
      setSeats([]);
      return;
    }

    const ids = rows.map((r) => r.user_id);
    const { data: profData } = await supabase
      .from('profiles')
      .select('id, username, avatar_id, equipped_card_back')
      .in('id', ids);

    const profMap = new Map<string, Pick<Profile, 'id' | 'username' | 'avatar_id' | 'equipped_card_back'>>();
    (profData as Pick<Profile, 'id' | 'username' | 'avatar_id' | 'equipped_card_back'>[] | null)?.forEach((p) => {
      profMap.set(p.id, p);
    });

    setSeats(
      rows.map((r) => {
        const p = profMap.get(r.user_id);
        return {
          ...r,
          username: p?.username ?? `player_${r.user_id.slice(0, 6)}`,
          avatar_id: p?.avatar_id ?? 'fox',
          equipped_card_back: p?.equipped_card_back ?? null,
        };
      }),
    );
  }, [roomId]);

  const loadPrivateState = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('game_private_states')
      .select('data')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .maybeSingle();

    setPrivateState(((data as { data?: Record<string, unknown> } | null)?.data) ?? {});
  }, [roomId, userId]);

  const loadShopAndInventory = useCallback(async () => {
    if (!userId) return;
    const [shopRes, invRes] = await Promise.all([
      supabase.from('shop_items').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
      supabase.from('user_items').select('*').eq('user_id', userId),
    ]);

    if (shopRes.error || !shopRes.data) return;
    const items = shopRes.data as ShopItem[];
    const cbMap = new Map<string, ShopItem>();
    for (const item of items) {
      if (item.kind === 'card_back') cbMap.set(item.id, item);
    }
    setCardBackMap(cbMap);

    const qtyMap = new Map<string, number>();
    ((invRes.data as UserItem[] | null) ?? []).forEach((u) => {
      qtyMap.set(u.item_id, Number(u.quantity));
    });

    setEmoteInventory(
      items
        .filter((i) => i.kind === 'emote' && i.is_interactive)
        .map((item) => ({ item, quantity: qtyMap.get(item.id) ?? 0 })),
    );
  }, [userId]);

  // Full authoritative resync (initial load, reconnect, or version-gap recovery).
  const resync = useCallback(async () => {
    if (!userId) return;
    setSyncStatus((prev) => (prev === 'connecting' ? 'connecting' : 'resyncing'));

    const clockRes = await supabase.rpc('get_server_time');
    if (!clockRes.error && typeof clockRes.data === 'string') {
      const srvMs = new Date(clockRes.data).getTime();
      if (!Number.isNaN(srvMs)) setServerOffsetMs(srvMs - Date.now());
    }

    // Check if the user is already seated in this room or another room.
    const { data: existingSeatRow } = await supabase
      .from('room_players')
      .select('room_id, seat')
      .eq('user_id', userId)
      .maybeSingle();

    const existingSeat = existingSeatRow as { room_id: string; seat: number } | null;
    let isSeatedHere = existingSeat?.room_id === roomId;

    // If user clicked a direct invite link while still seated at an old table, leave the old table automatically.
    if (existingSeat && existingSeat.room_id !== roomId) {
      await supabase.rpc('leave_room', { p_room_id: existingSeat.room_id });
    }

    // If an invite PIN was supplied in the direct invite URL (/room/:roomId?pin=XXXXXX),
    // automatically seat the user via join_room_by_pin BEFORE querying `rooms` (since private
    // rooms are hidden by RLS until the user is seated in `room_players`).
    if (!isSeatedHere && invitePin) {
      const cleanedPin = invitePin.trim().toUpperCase();
      if (cleanedPin.length > 0) {
        const { data: pinJoinData, error: pinJoinErr } = await supabase.rpc('join_room_by_pin', {
          p_pin: cleanedPin,
        });
        if (pinJoinErr) {
          setError(friendlyError(pinJoinErr));
        } else {
          const resObj = pinJoinData as { ok?: boolean; error?: string; room_id?: string } | null;
          if (resObj && resObj.ok === false) {
            setError(friendlyError({ message: resObj.error ?? 'invalid_pin' }));
          } else {
            isSeatedHere = true;
          }
        }
      }
    }

    const roomRes = await supabase.from('rooms').select('*').eq('id', roomId).maybeSingle();
    let currentRoom = (roomRes.data as Room | null) ?? null;
    if (!currentRoom) {
      setError('Room not found or requires a valid Private Invite Link.');
      setLoading(false);
      return;
    }

    // If not yet seated and the room is public & open, auto-join on direct link visit.
    if (!isSeatedHere && currentRoom.visibility === 'public' && currentRoom.status !== 'closed') {
      const { error: joinErr } = await supabase.rpc('join_room', { p_room_id: roomId });
      if (joinErr) {
        setError(friendlyError(joinErr));
      } else {
        isSeatedHere = true;
        const refreshed = await supabase.from('rooms').select('*').eq('id', roomId).maybeSingle();
        currentRoom = (refreshed.data as Room | null) ?? currentRoom;
      }
    }

    setRoom(currentRoom);

    // If caller is the host of a private room, fetch the PIN from room_secrets.
    if (currentRoom.visibility === 'private' && currentRoom.host_id === userId) {
      const { data: sec } = await supabase
        .from('room_secrets')
        .select('pin')
        .eq('room_id', roomId)
        .maybeSingle();
      setHostPin(((sec as { pin?: string } | null)?.pin) ?? null);
    } else {
      setHostPin(invitePin ? invitePin.trim().toUpperCase() : null);
    }

    const [gsRes, chatRes] = await Promise.all([
      supabase.from('game_states').select('*').eq('room_id', roomId).maybeSingle(),
      supabase
        .from('chat_messages')
        .select('*')
        .eq('room_id', roomId)
        .order('id', { ascending: false })
        .limit(60),
      loadSeats(),
      loadPrivateState(),
      loadShopAndInventory(),
    ]);

    if (!gsRes.error && gsRes.data) {
      const gs = gsRes.data as GameStateRow;
      versionRef.current = Number(gs.version);
      setGameState({ ...gs, version: Number(gs.version) });
    }

    if (!chatRes.error && chatRes.data) {
      setMessages((chatRes.data as ChatMessageRow[]).slice().reverse());
    }

    setSyncStatus('synced');
    setLoading(false);
  }, [roomId, invitePin, userId, loadSeats, loadPrivateState, loadShopAndInventory]);

  // Set up database postgres_changes channel + private room Broadcast/Presence channel.
  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    let dbChannel: RealtimeChannel | null = null;
    let roomChannel: RealtimeChannel | null = null;

    void (async () => {
      await resync();
      if (disposed) return;

      const { data } = await supabase.auth.getSession();
      await supabase.realtime.setAuth(data.session?.access_token ?? null);
      if (disposed) return;

      // 1) Authoritative DB state channel with version-gap detection
      dbChannel = supabase
        .channel(`room-db:${roomId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
          (payload) => {
            if (payload.eventType === 'UPDATE' && payload.new) {
              setRoom(payload.new as Room);
            }
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` },
          () => {
            void loadSeats();
          },
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'game_states', filter: `room_id=eq.${roomId}` },
          (payload) => {
            const incoming = payload.new as GameStateRow;
            const nextVer = Number(incoming.version);
            const curVer = versionRef.current;

            if (curVer >= 0 && nextVer !== curVer + 1) {
              // Version gap or out-of-order delivery -> full snapshot resync.
              void resync();
              return;
            }
            versionRef.current = nextVer;
            setGameState((prev) => {
              if (prev?.phase !== 'playing' && incoming.phase === 'playing') {
                sound.play('cardDeal');
              } else if (prev?.phase !== 'settled' && incoming.phase === 'settled') {
                void refreshWallet();
                const myOutcome = userId ? incoming.state?.hands?.[userId]?.outcome : null;
                if (myOutcome === 'blackjack' || myOutcome === 'win') {
                  sound.play('win');
                } else if (myOutcome === 'push') {
                  sound.play('notify');
                } else if (myOutcome === 'lose' || myOutcome === 'bust') {
                  sound.play('lose');
                } else {
                  sound.play('cardFlip');
                }
              }
              return { ...incoming, version: nextVer };
            });
            void loadPrivateState();
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'game_private_states', filter: `room_id=eq.${roomId}` },
          () => {
            void loadPrivateState();
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${roomId}` },
          (payload) => {
            const msg = payload.new as ChatMessageRow;
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          },
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' && !disposed) {
            void resync();
          }
        });

      // 2) Private Room Broadcast & Presence channel (`room:<uuid>`)
      const rch = supabase.channel(`room:${roomId}`, {
        config: {
          private: true,
          broadcast: { self: true },
          presence: { key: userId },
        },
      });
      roomChannel = rch;
      bcastChannelRef.current = rch;

      rch
        .on('presence', { event: 'sync' }, () => {
          if (!disposed) {
            setRoomOnlineIds(new Set(Object.keys(rch.presenceState())));
          }
        })
        .on('broadcast', { event: 'quick_emote' }, ({ payload }) => {
          if (disposed || !payload) return;
          const ev = payload as QuickEmoteEvent;
          sound.play('notify');
          setQuickEmotesByUser((prev) => ({ ...prev, [ev.sender_id]: ev }));
          window.setTimeout(() => {
            setQuickEmotesByUser((prev) => {
              if (prev[ev.sender_id]?.id !== ev.id) return prev;
              const copy = { ...prev };
              delete copy[ev.sender_id];
              return copy;
            });
          }, 3200);
        })
        .on('broadcast', { event: 'interactive_emote' }, ({ payload }) => {
          if (disposed || !payload) return;
          const ev = payload as InteractiveEmoteEvent;
          if (ev.animation === 'toast') {
            sound.play('notify');
          } else if (ev.animation === 'slap' || ev.animation === 'punch') {
            sound.play('cardFlip');
          } else {
            sound.play('slotStop');
          }
          setActiveInteractiveEmote(ev);
          window.setTimeout(() => {
            setActiveInteractiveEmote((cur) => (cur?.id === ev.id ? null : cur));
          }, 1500);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' && !disposed) {
            void rch.track({ joined_at: new Date().toISOString() });
          }
        });
    })();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void resync();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      bcastChannelRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      if (dbChannel) void supabase.removeChannel(dbChannel);
      if (roomChannel) void supabase.removeChannel(roomChannel);
    };
  }, [roomId, userId, resync, loadSeats, loadPrivateState, sound, refreshWallet]);

  // High-frequency 100ms ticker while a 15-second turn deadline is active.
  const turnDeadlineMs = useMemo(() => {
    if (!gameState?.turn_deadline) return null;
    const ms = new Date(gameState.turn_deadline).getTime();
    return Number.isNaN(ms) ? null : ms;
  }, [gameState?.turn_deadline]);

  useEffect(() => {
    if (turnDeadlineMs === null || !gameState?.turn_user_id) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      const serverNow = current + serverOffsetMs;
      // Trigger server-side timeout enforcement once per version when deadline expires.
      // The active player's client triggers at 0ms; other room members trigger at +250ms
      // so the room never stalls even if the active player closed their browser.
      const graceMs = gameState.turn_user_id === userId ? 0 : 250;
      if (
        serverNow >= turnDeadlineMs + graceMs &&
        timeoutClaimedForVersionRef.current !== gameState.version
      ) {
        timeoutClaimedForVersionRef.current = gameState.version;
        void supabase.rpc('claim_turn_timeout', { p_room_id: roomId }).then(({ data }) => {
          const res = data as { expired?: boolean } | null;
          if (res && res.expired === false) {
            // Server clock says a few ms remain; allow retry on a subsequent tick.
            timeoutClaimedForVersionRef.current = -1;
          }
        });
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [turnDeadlineMs, gameState?.turn_user_id, gameState?.version, serverOffsetMs, userId, roomId]);

  const turnRemainingMs = useMemo(() => {
    if (turnDeadlineMs === null) return null;
    return Math.max(0, turnDeadlineMs - (nowMs + serverOffsetMs));
  }, [turnDeadlineMs, nowMs, serverOffsetMs]);

  const mySeat = useMemo(
    () => (userId ? seats.find((s) => s.user_id === userId) ?? null : null),
    [seats, userId],
  );

  // Actions
  const sendChat = useCallback(
    async (text: string) => {
      const { error: err } = await supabase.rpc('send_chat_message', {
        p_room_id: roomId,
        p_body: text,
      });
      if (err) throw new Error(friendlyError(err));
    },
    [roomId],
  );

  const sendQuickEmote = useCallback(
    async (preset: QuickEmotePreset) => {
      if (!userId || !bcastChannelRef.current) return;
      const ev: QuickEmoteEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sender_id: userId,
        emote_id: preset.id,
        symbol: preset.symbol,
        phrase: preset.phrase,
        sent_at: Date.now(),
      };
      await bcastChannelRef.current.send({
        type: 'broadcast',
        event: 'quick_emote',
        payload: ev,
      });
    },
    [userId],
  );

  const sendInteractiveEmote = useCallback(
    async (targetUserId: string, itemId: string) => {
      if (!userId) return;
      const { data, error: err } = await supabase.rpc('use_interactive_emote', {
        p_room_id: roomId,
        p_target_user: targetUserId,
        p_item_id: itemId,
      });
      if (err) throw new Error(friendlyError(err));

      const res = data as {
        animation: InteractiveEmoteAnimation;
        name: string;
        remaining: number;
      };

      setEmoteInventory((prev) =>
        prev.map((entry) =>
          entry.item.id === itemId ? { ...entry, quantity: Number(res.remaining) } : entry,
        ),
      );

      if (bcastChannelRef.current) {
        const ev: InteractiveEmoteEvent = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sender_id: userId,
          target_id: targetUserId,
          animation: res.animation,
          name: res.name,
          sent_at: Date.now(),
        };
        await bcastChannelRef.current.send({
          type: 'broadcast',
          event: 'interactive_emote',
          payload: ev,
        });
      }
    },
    [roomId, userId],
  );

  const returnFromAfk = useCallback(async () => {
    const { error: err } = await supabase.rpc('return_from_afk', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('notify');
    await loadSeats();
  }, [roomId, loadSeats, sound]);

  const startTurnCycle = useCallback(async () => {
    const { error: err } = await supabase.rpc('start_turn_cycle', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('cardShuffle');
  }, [roomId, sound]);

  const performTurnAction = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      const { error: err } = await supabase.rpc('perform_turn_action', {
        p_room_id: roomId,
        p_action: action,
        p_payload: payload,
      });
      if (err) throw new Error(friendlyError(err));
      sound.play('chipClick');
    },
    [roomId, sound],
  );

  // Blackjack authoritative RPC actions
  const startBlackjackRound = useCallback(async () => {
    const { error: err } = await supabase.rpc('blackjack_start_round', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('cardShuffle');
  }, [roomId, sound]);

  const placeBlackjackBet = useCallback(
    async (amount: number) => {
      const { error: err } = await supabase.rpc('blackjack_place_bet', {
        p_room_id: roomId,
        p_amount: Math.floor(amount),
      });
      if (err) throw new Error(friendlyError(err));
      sound.play('chipStack');
      await refreshWallet();
    },
    [roomId, sound, refreshWallet],
  );

  const actBlackjack = useCallback(
    async (action: 'hit' | 'stand' | 'double') => {
      const { error: err } = await supabase.rpc('blackjack_action', {
        p_room_id: roomId,
        p_action: action,
      });
      if (err) throw new Error(friendlyError(err));
      if (action === 'hit') {
        sound.play('cardDeal');
      } else if (action === 'double') {
        sound.play('cardFlip');
        await refreshWallet();
      } else {
        sound.play('chipClick');
      }
    },
    [roomId, sound, refreshWallet],
  );

  // Roulette authoritative RPC actions
  const startRouletteRound = useCallback(async () => {
    const { error: err } = await supabase.rpc('roulette_start_round', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('notify');
  }, [roomId, sound]);

  const placeRouletteBets = useCallback(
    async (bets: Pick<RouletteBetItem, 'kind' | 'number' | 'amount'>[]) => {
      const { error: err } = await supabase.rpc('roulette_place_bets', {
        p_room_id: roomId,
        p_bets: bets,
      });
      if (err) throw new Error(friendlyError(err));
      sound.play('chipStack');
      await refreshWallet();
    },
    [roomId, sound, refreshWallet],
  );

  // Slots authoritative RPC action
  const spinSlots = useCallback(
    async (bet: number) => {
      const { error: err } = await supabase.rpc('slots_spin', {
        p_room_id: roomId,
        p_bet: Math.floor(bet),
      });
      if (err) throw new Error(friendlyError(err));
      await refreshWallet();
    },
    [roomId, refreshWallet],
  );

  // Texas Hold'em Poker authoritative RPC actions
  const startPokerHand = useCallback(async () => {
    const { error: err } = await supabase.rpc('poker_start_hand', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('cardShuffle');
    await Promise.all([refreshWallet(), loadPrivateState()]);
  }, [roomId, sound, refreshWallet, loadPrivateState]);

  const actPoker = useCallback(
    async (action: 'fold' | 'check' | 'call' | 'raise', amount: number = 0) => {
      const { error: err } = await supabase.rpc('poker_action', {
        p_room_id: roomId,
        p_action: action,
        p_amount: Math.floor(amount),
      });
      if (err) throw new Error(friendlyError(err));
      if (action === 'fold') {
        sound.play('cardFlip');
      } else if (action === 'check') {
        sound.play('chipClick');
      } else {
        sound.play('chipStack');
      }
      await refreshWallet();
    },
    [roomId, sound, refreshWallet],
  );

  // Classic 36-Card Durak authoritative RPC actions
  const startDurakGame = useCallback(async () => {
    const { error: err } = await supabase.rpc('durak_start_game', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('cardShuffle');
    await Promise.all([refreshWallet(), loadPrivateState()]);
  }, [roomId, sound, refreshWallet, loadPrivateState]);

  const actDurak = useCallback(
    async (action: 'attack' | 'defend' | 'bito' | 'take', card: PlayingCard | null = null) => {
      const { error: err } = await supabase.rpc('durak_action', {
        p_room_id: roomId,
        p_action: action,
        p_card: card,
      });
      if (err) throw new Error(friendlyError(err));
      if (action === 'attack' || action === 'defend') {
        sound.play('cardDeal');
      } else {
        sound.play('cardFlip');
      }
      await Promise.all([refreshWallet(), loadPrivateState()]);
    },
    [roomId, sound, refreshWallet, loadPrivateState],
  );

  // Chess & Checkers authoritative RPC actions
  const startChessGame = useCallback(async () => {
    const { error: err } = await supabase.rpc('chess_start_game', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('notify');
    await refreshWallet();
  }, [roomId, sound, refreshWallet]);

  const moveChess = useCallback(
    async (fromRow: number, fromCol: number, toRow: number, toCol: number, promotion: string = 'Q') => {
      const { error: err } = await supabase.rpc('chess_move', {
        p_room_id: roomId,
        p_from_row: fromRow,
        p_from_col: fromCol,
        p_to_row: toRow,
        p_to_col: toCol,
        p_promotion: promotion,
      });
      if (err) throw new Error(friendlyError(err));
      sound.play('chipClick');
      await refreshWallet();
    },
    [roomId, sound, refreshWallet],
  );

  const startCheckersGame = useCallback(async () => {
    const { error: err } = await supabase.rpc('checkers_start_game', { p_room_id: roomId });
    if (err) throw new Error(friendlyError(err));
    sound.play('notify');
    await refreshWallet();
  }, [roomId, sound, refreshWallet]);

  const moveCheckers = useCallback(
    async (fromRow: number, fromCol: number, toRow: number, toCol: number) => {
      const { error: err } = await supabase.rpc('checkers_move', {
        p_room_id: roomId,
        p_from_row: fromRow,
        p_from_col: fromCol,
        p_to_row: toRow,
        p_to_col: toCol,
      });
      if (err) throw new Error(friendlyError(err));
      sound.play('chipClick');
      await refreshWallet();
    },
    [roomId, sound, refreshWallet],
  );

  const leaveRoom = useCallback(async () => {
    await supabase.rpc('leave_room', { p_room_id: roomId });
  }, [roomId]);

  return {
    room,
    hostPin,
    seats,
    mySeat,
    gameState,
    privateState,
    messages,
    cardBackMap,
    emoteInventory,
    roomOnlineIds,
    quickEmotesByUser,
    activeInteractiveEmote,
    turnRemainingMs,
    loading,
    syncStatus,
    error,
    resync,
    sendChat,
    sendQuickEmote,
    sendInteractiveEmote,
    returnFromAfk,
    startTurnCycle,
    performTurnAction,
    startBlackjackRound,
    placeBlackjackBet,
    actBlackjack,
    startRouletteRound,
    placeRouletteBets,
    spinSlots,
    startPokerHand,
    actPoker,
    startDurakGame,
    actDurak,
    startChessGame,
    moveChess,
    startCheckersGame,
    moveCheckers,
    leaveRoom,
  };
}

