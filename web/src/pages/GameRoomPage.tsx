import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useSound } from '../audio/SoundProvider';
import { Avatar } from '../components/Avatar';
import { BlackjackTable } from '../components/BlackjackTable';
import { BoardGameTable } from '../components/BoardGameTable';
import { DurakTable } from '../components/DurakTable';
import { useNavigate } from '../components/GuardLink';
import { EmoteVectorIcon } from '../components/InteractiveEmotePreview';
import { PokerTable } from '../components/PokerTable';
import { RouletteTable } from '../components/RouletteTable';
import { SlotsMachine } from '../components/SlotsMachine';
import { useI18n } from '../i18n/I18nProvider';
import { humanizeError } from '../lib/errors';
import { formatChips } from '../lib/format';
import {
  DEFAULT_CARD_BACK_URL,
  EMOTE_SPECS,
  QUICK_EMOTES,
  resolveCardBackUrl,
  type QuickEmoteSpec,
} from '../lib/shop';
import { supabase } from '../lib/supabase';
import type {
  Card,
  ChatMessageWithAuthor,
  GameStateRow,
  InteractiveEmoteEvent,
  QuickEmoteEvent,
  Room,
  RoomSeatWithProfile,
  RouletteBetItem,
  ShopItem,
  UserItem,
} from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';

const TURN_TIMEOUT_MS = 15_000;

export function GameRoomPage() {
  const { game: routeGame, roomId } = useParams<{ game: string; roomId: string }>();
  const { user, profile } = useAuth();
  const { refresh: refreshWallet } = useWallet();
  const { sound } = useSound();
  const { t, gameName } = useI18n();
  const nav = useNavigate();

  const [room, setRoom] = useState<Room | null>(null);
  const [seats, setSeats] = useState<RoomSeatWithProfile[]>([]);
  const [gameState, setGameState] = useState<GameStateRow | null>(null);
  const [myPrivateCards, setMyPrivateCards] = useState<Card[]>([]);
  const [messages, setMessages] = useState<ChatMessageWithAuthor[]>([]);
  const [shopItems, setShopItems] = useState<ShopItem[]>([]);
  const [inventory, setInventory] = useState<UserItem[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatText, setChatText] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [returningAfk, setReturningAfk] = useState(false);
  const [pinCopied, setPinCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  // Compact collapsible chat & emote drawer states
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [emotesExpanded, setEmotesExpanded] = useState(false);

  // Selected interactive emote item_id for targeted throwing
  const [selectedEmoteItemId, setSelectedEmoteItemId] = useState<string | null>(null);

  // Active ephemeral quick-emote bubbles keyed by sender user_id
  const [quickEmotesByUser, setQuickEmotesByUser] = useState<Record<string, QuickEmoteEvent>>({});

  // Active targeted avatar-to-avatar projectile animation
  const [activeInteractiveEmote, setActiveInteractiveEmote] =
    useState<InteractiveEmoteEvent | null>(null);

  // 15-second turn countdown state (milliseconds remaining)
  const [turnRemainingMs, setTurnRemainingMs] = useState<number | null>(null);
  const timeoutClaimedForTurnRef = useRef<string | null>(null);
  const broadcastChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef<number>(0);

  // Map card_back item_id -> ShopItem for fast lookup on seats
  const cardBackMap = useMemo(() => {
    const m = new Map<string, ShopItem>();
    for (const item of shopItems) {
      if (item.kind === 'card_back') m.set(item.id, item);
    }
    return m;
  }, [shopItems]);

  const interactiveItems = useMemo(
    () => shopItems.filter((i) => i.kind === 'emote'),
    [shopItems],
  );

  const inventoryByItemId = useMemo(() => {
    const m = new Map<string, UserItem>();
    for (const row of inventory) {
      m.set(row.item_id, row);
    }
    return m;
  }, [inventory]);

  // Default selected interactive emote to the first one the user owns (or first in catalog)
  useEffect(() => {
    if (selectedEmoteItemId) return;
    const ownedWithAmmo = interactiveItems.find(
      (i) => (inventoryByItemId.get(i.id)?.quantity ?? 0) > 0,
    );
    if (ownedWithAmmo) {
      setSelectedEmoteItemId(ownedWithAmmo.id);
    } else if (interactiveItems[0]) {
      setSelectedEmoteItemId(interactiveItems[0].id);
    }
  }, [interactiveItems, inventoryByItemId, selectedEmoteItemId]);

  const loadRoomData = useCallback(async () => {
    if (!roomId) return;

    const [roomRes, playersRes, stateRes, privRes, chatRes, shopRes, invRes] = await Promise.all([
      supabase.from('rooms').select('*').eq('id', roomId).maybeSingle(),
      supabase
        .from('room_players')
        .select('*')
        .eq('room_id', roomId)
        .is('left_at', null)
        .order('seat', { ascending: true }),
      supabase.from('game_states').select('*').eq('room_id', roomId).maybeSingle(),
      user
        ? supabase
            .from('game_private_states')
            .select('private_state')
            .eq('room_id', roomId)
            .eq('user_id', user.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('chat_messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })
        .limit(80),
      supabase.from('shop_items').select('*').eq('is_active', true),
      user
        ? supabase.from('user_items').select('*').eq('user_id', user.id)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (roomRes.error || !roomRes.data) {
      setError('This game room could not be found or is no longer active.');
      setLoading(false);
      return;
    }

    const loadedRoom = roomRes.data as Room;
    setRoom(loadedRoom);

    if (shopRes.data) setShopItems(shopRes.data as ShopItem[]);
    if (invRes.data) setInventory(invRes.data as UserItem[]);
    if (stateRes.data) setGameState(stateRes.data as GameStateRow);

    if (privRes.data) {
      const priv = (privRes.data as { private_state?: { cards?: Card[] } }).private_state;
      setMyPrivateCards(Array.isArray(priv?.cards) ? priv.cards : []);
    } else {
      setMyPrivateCards([]);
    }

    const rawPlayers = (playersRes.data ?? []) as RoomSeatWithProfile[];
    const rawChat = (chatRes.data ?? []) as ChatMessageWithAuthor[];

    const userIds = Array.from(
      new Set([...rawPlayers.map((p) => p.user_id), ...rawChat.map((c) => c.user_id)]),
    );

    const profileMap = new Map<
      string,
      { username: string; avatar_id: string; equipped_card_back: string | null }
    >();

    if (userIds.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, username, avatar_id, equipped_card_back')
        .in('id', userIds);
      if (profs) {
        for (const p of profs as {
          id: string;
          username: string;
          avatar_id: string;
          equipped_card_back: string | null;
        }[]) {
          profileMap.set(p.id, {
            username: p.username,
            avatar_id: p.avatar_id,
            equipped_card_back: p.equipped_card_back,
          });
        }
      }
    }

    const enrichedSeats: RoomSeatWithProfile[] = rawPlayers.map((rp) => {
      const prof = profileMap.get(rp.user_id);
      return {
        ...rp,
        username: prof?.username ?? 'Player',
        avatar_id: prof?.avatar_id ?? 'fox',
        equipped_card_back: prof?.equipped_card_back ?? null,
      };
    });
    setSeats(enrichedSeats);

    // If current user navigated directly to a waiting public room and isn't seated yet, auto-join.
    if (
      user &&
      !enrichedSeats.some((s) => s.user_id === user.id) &&
      loadedRoom.visibility === 'public' &&
      loadedRoom.status === 'waiting' &&
      enrichedSeats.length < loadedRoom.max_players
    ) {
      const { error: joinErr } = await supabase.rpc('join_room', { p_room_id: loadedRoom.id });
      if (!joinErr) {
        void loadRoomData();
        return;
      }
    }

    const enrichedChat: ChatMessageWithAuthor[] = rawChat.map((cm) => {
      const prof = profileMap.get(cm.user_id);
      return {
        ...cm,
        username: prof?.username ?? 'Player',
        avatar_id: prof?.avatar_id ?? 'fox',
      };
    });
    setMessages(enrichedChat);

    setLoading(false);
  }, [roomId, user]);

  useEffect(() => {
    void loadRoomData();
  }, [loadRoomData]);

  // Track unread chat messages when floating chat is closed, and auto-scroll when open
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      const added = messages.length - prevMsgCountRef.current;
      if (!chatOpen && prevMsgCountRef.current > 0) {
        setUnreadCount((c) => c + added);
      }
    }
    prevMsgCountRef.current = messages.length;
    if (chatOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, chatOpen]);

  // Subscribe to Realtime database changes + ephemeral broadcast emotes for this room
  useEffect(() => {
    if (!roomId) return;

    const channel = supabase
      .channel(`room:${roomId}`, {
        config: { broadcast: { self: true } },
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        () => {
          void loadRoomData();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` },
        () => {
          void loadRoomData();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_states', filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (payload.new) {
            setGameState(payload.new as GameStateRow);
            void refreshWallet();
            if (user) {
              void supabase
                .from('game_private_states')
                .select('private_state')
                .eq('room_id', roomId)
                .eq('user_id', user.id)
                .maybeSingle()
                .then(({ data }) => {
                  const priv = (data as { private_state?: { cards?: Card[] } } | null)
                    ?.private_state;
                  setMyPrivateCards(Array.isArray(priv?.cards) ? priv.cards : []);
                });
            }
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_private_states',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          if (payload.new && user && (payload.new as { user_id?: string }).user_id === user.id) {
            const priv = (payload.new as { private_state?: { cards?: Card[] } }).private_state;
            setMyPrivateCards(Array.isArray(priv?.cards) ? priv.cards : []);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${roomId}` },
        () => {
          void loadRoomData();
        },
      )
      .on('broadcast', { event: 'quick_emote' }, ({ payload }) => {
        const ev = payload as QuickEmoteEvent;
        if (!ev || !ev.sender_id) return;
        sound.play('emotePop');
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
        const ev = payload as InteractiveEmoteEvent;
        if (!ev || !ev.sender_id || !ev.target_id) return;
        sound.playEmoteSFX(ev.animation);
        setActiveInteractiveEmote(ev);
        window.setTimeout(() => {
          setActiveInteractiveEmote((curr) => (curr?.id === ev.id ? null : curr));
        }, 1800);
      })
      .subscribe();

    broadcastChannelRef.current = channel;

    return () => {
      broadcastChannelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [roomId, user, loadRoomData, refreshWallet, sound]);

  // 15-Second Turn Timer & Automatic Server-Verified AFK Timeout Claim
  useEffect(() => {
    if (!gameState || !gameState.turn_user_id || !gameState.turn_started_at || !roomId) {
      setTurnRemainingMs(null);
      return;
    }

    const turnKey = `${gameState.turn_user_id}:${gameState.turn_started_at}`;
    const deadlineMs =
      gameState.turn_deadline_at
        ? new Date(gameState.turn_deadline_at).getTime()
        : new Date(gameState.turn_started_at).getTime() + TURN_TIMEOUT_MS;

    const tick = () => {
      const rem = Math.max(0, deadlineMs - Date.now());
      setTurnRemainingMs(rem);

      if (rem === 0 && timeoutClaimedForTurnRef.current !== turnKey) {
        timeoutClaimedForTurnRef.current = turnKey;
        void supabase.rpc('claim_turn_timeout', { p_room_id: roomId });
      }
    };

    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [gameState, roomId]);

  const mySeat = useMemo(
    () => (user ? seats.find((s) => s.user_id === user.id) ?? null : null),
    [seats, user],
  );

  // Universal Game RPC Executor
  async function runGameRpc(
    fnName: string,
    args: Record<string, unknown>,
    sfx: 'cardSlide' | 'chipStack' | 'uiClick' = 'cardSlide',
  ) {
    if (!roomId) return;
    setError(null);
    setActionBusy(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc(fnName, args);
      if (rpcErr) {
        setError(humanizeError(rpcErr));
        return;
      }
      sound.play(sfx);
      if (data && typeof data === 'object' && 'phase' in (data as Record<string, unknown>)) {
        setGameState(data as GameStateRow);
      } else {
        await loadRoomData();
      }
      await refreshWallet();
    } finally {
      setActionBusy(false);
    }
  }

  // Blackjack Handlers
  async function handleStartRound() {
    if (!roomId) return;
    await runGameRpc('blackjack_start_round', { p_room_id: roomId }, 'cardSlide');
  }

  async function handleBlackjackBet(amount: number) {
    if (!roomId) return;
    await runGameRpc('blackjack_place_bet', { p_room_id: roomId, p_amount: amount }, 'chipStack');
  }

  async function handleBlackjackAction(action: 'hit' | 'stand' | 'double') {
    if (!roomId) return;
    await runGameRpc(
      'blackjack_action',
      { p_room_id: roomId, p_action: action },
      action === 'double' ? 'chipStack' : 'cardSlide',
    );
  }

  // Roulette Handlers
  async function handleRouletteStartRound() {
    if (!roomId) return;
    await runGameRpc('roulette_start_round', { p_room_id: roomId }, 'uiClick');
  }

  async function handleRoulettePlaceBets(bets: Pick<RouletteBetItem, 'kind' | 'number' | 'amount'>[]) {
    if (!roomId) return;
    await runGameRpc('roulette_place_bets', { p_room_id: roomId, p_bets: bets }, 'chipStack');
  }

  // Slots Handler
  async function handleSlotsSpin(bet: number) {
    if (!roomId) return;
    await runGameRpc('slots_spin', { p_room_id: roomId, p_bet: bet }, 'chipStack');
  }

  // Texas Hold'em Poker Handlers
  async function handlePokerStartHand() {
    if (!roomId) return;
    await runGameRpc('poker_start_hand', { p_room_id: roomId }, 'cardSlide');
  }

  async function handlePokerAction(
    action: 'fold' | 'check' | 'call' | 'raise' | 'all_in',
    raiseTo = 0,
  ) {
    if (!roomId) return;
    await runGameRpc(
      'poker_action',
      { p_room_id: roomId, p_action: action, p_raise_to: raiseTo },
      action === 'raise' || action === 'all_in' || action === 'call' ? 'chipStack' : 'cardSlide',
    );
  }

  // 36-Card Durak Handlers
  async function handleDurakStartGame() {
    if (!roomId) return;
    await runGameRpc('durak_start_game', { p_room_id: roomId }, 'cardSlide');
  }

  async function handleDurakAttack(card: Card) {
    if (!roomId) return;
    await runGameRpc('durak_attack', { p_room_id: roomId, p_card: card }, 'cardSlide');
  }

  async function handleDurakDefend(pairIndex: number, card: Card) {
    if (!roomId) return;
    await runGameRpc(
      'durak_defend',
      { p_room_id: roomId, p_pair_index: pairIndex, p_card: card },
      'cardSlide',
    );
  }

  async function handleDurakTake() {
    if (!roomId) return;
    await runGameRpc('durak_take', { p_room_id: roomId }, 'cardSlide');
  }

  async function handleDurakPass() {
    if (!roomId) return;
    await runGameRpc('durak_pass', { p_room_id: roomId }, 'uiClick');
  }

  // Chess & Checkers Handlers
  async function handleBoardStartGame(gameKind: 'chess' | 'checkers') {
    if (!roomId) return;
    const rpcName = gameKind === 'chess' ? 'chess_start_game' : 'checkers_start_game';
    await runGameRpc(rpcName, { p_room_id: roomId }, 'cardSlide');
  }

  async function handleBoardMove(gameKind: 'chess' | 'checkers', fromSq: number, toSq: number) {
    if (!roomId) return;
    const rpcName = gameKind === 'chess' ? 'chess_move' : 'checkers_move';
    await runGameRpc(rpcName, { p_room_id: roomId, p_from: fromSq, p_to: toSq }, 'cardSlide');
  }

  async function handleBoardResign(gameKind: 'chess' | 'checkers') {
    if (!roomId) return;
    const rpcName = gameKind === 'chess' ? 'chess_resign' : 'checkers_resign';
    await runGameRpc(rpcName, { p_room_id: roomId }, 'uiClick');
  }

  async function handleReturnFromAfk() {
    if (!roomId) return;
    setError(null);
    setReturningAfk(true);
    try {
      const { error: rpcErr } = await supabase.rpc('return_from_afk', { p_room_id: roomId });
      if (rpcErr) {
        setError(humanizeError(rpcErr));
        return;
      }
      sound.play('uiClick');
      await loadRoomData();
    } finally {
      setReturningAfk(false);
    }
  }

  async function handleLeaveRoom() {
    if (!roomId) return;
    await supabase.rpc('leave_room', { p_room_id: roomId });
    nav('/lobby');
  }

  async function handleSendChat(e: FormEvent) {
    e.preventDefault();
    if (!roomId) return;
    const trimmed = chatText.trim();
    if (!trimmed) return;
    setSendingChat(true);
    try {
      const { error: rpcErr } = await supabase.rpc('send_chat_message', {
        p_room_id: roomId,
        p_content: trimmed,
      });
      if (rpcErr) {
        setError(humanizeError(rpcErr));
        return;
      }
      setChatText('');
    } finally {
      setSendingChat(false);
    }
  }

  // Free Quick-Emotes (instant, unlimited)
  async function handleSendQuickEmote(emote: QuickEmoteSpec) {
    if (!user || !profile || !broadcastChannelRef.current) return;
    const event: QuickEmoteEvent = {
      id: `${user.id}-${Date.now()}`,
      sender_id: user.id,
      sender_username: profile.username,
      emote_id: emote.id,
      symbol: emote.symbol,
      phrase: emote.phrase,
    };
    await broadcastChannelRef.current.send({
      type: 'broadcast',
      event: 'quick_emote',
      payload: event,
    });
  }

  // Targeted Interactive Emotes (consumes 1 charge via server RPC, then broadcasts projectile)
  async function handleFireInteractiveEmote(targetUserId: string) {
    if (!user || !profile || !roomId || !selectedEmoteItemId) return;
    const item = interactiveItems.find((i) => i.id === selectedEmoteItemId);
    if (!item) return;

    const currentQty = inventoryByItemId.get(item.id)?.quantity ?? 0;
    if (currentQty <= 0) {
      setError(`You are out of "${item.name}" charges. Visit the Shop to restock.`);
      return;
    }

    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('use_interactive_emote', {
      p_room_id: roomId,
      p_item_id: item.id,
      p_target_user_id: targetUserId,
    });

    if (rpcErr) {
      setError(humanizeError(rpcErr));
      return;
    }

    const res = data as { remaining_quantity: number; animation: string };

    // Update local inventory count immediately
    setInventory((prev) =>
      prev.map((row) =>
        row.item_id === item.id ? { ...row, quantity: res.remaining_quantity } : row,
      ),
    );

    const event: InteractiveEmoteEvent = {
      id: `${user.id}-${targetUserId}-${Date.now()}`,
      sender_id: user.id,
      target_id: targetUserId,
      item_id: item.id,
      animation: res.animation || item.metadata?.animation || 'egg_toss',
    };

    if (broadcastChannelRef.current) {
      await broadcastChannelRef.current.send({
        type: 'broadcast',
        event: 'interactive_emote',
        payload: event,
      });
    }
  }

  function handleCopyPin() {
    if (!room?.pin_code) return;
    void navigator.clipboard.writeText(room.pin_code);
    setPinCopied(true);
    window.setTimeout(() => setPinCopied(false), 1800);
  }

  function handleCopyInviteLink() {
    if (!room) return;
    const url = `${window.location.origin}/games/${room.game}/${room.id}`;
    void navigator.clipboard.writeText(url);
    sound.play('uiClick');
    setInviteCopied(true);
    window.setTimeout(() => setInviteCopied(false), 2000);
  }

  if (loading) {
    return (
      <section>
        <p className="muted">Entering game room…</p>
      </section>
    );
  }

  if (!room) {
    return (
      <section>
        <h1>Room Unavailable</h1>
        {error && <p className="form-error">{error}</p>}
        <button type="button" className="btn btn--gold" onClick={() => nav('/lobby')}>
          {t('room.backToLobby')}
        </button>
      </section>
    );
  }

  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;
  const isMyTurn = Boolean(user && gameState?.turn_user_id === user.id);
  const turnSeconds =
    turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct =
    turnRemainingMs !== null
      ? Math.min(100, Math.max(0, (turnRemainingMs / TURN_TIMEOUT_MS) * 100))
      : 0;
  const activeGameSlug = room.game || routeGame || 'blackjack';

  return (
    <section className="room-shell">
      {/* Room Header Bar */}
      <header className="room-header">
        <div>
          <p className="eyebrow" style={{ textTransform: 'capitalize' }}>
            {gameName(activeGameSlug, activeGameSlug)} ·{' '}
            {room.visibility === 'private' ? t('room.privatePin') : t('room.publicTable')}
          </p>
          <h1 className="room-header__title">{room.name}</h1>
        </div>

        <div className="row">
          {room.pin_code && (
            <div className="room-pin-box" title="Share this 6-character PIN so friends can join">
              <span className="muted small">{t('room.roomPin')}</span>
              <strong className="room-pin-box__code tabular">{room.pin_code}</strong>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={handleCopyPin}
                data-silent
              >
                {pinCopied ? t('room.copied') : t('room.copy')}
              </button>
            </div>
          )}

          <button
            type="button"
            className="btn btn--ghost btn--sm room-invite-btn"
            onClick={handleCopyInviteLink}
            title="Copy direct invitation link to this table"
          >
            {inviteCopied ? t('room.linkCopied') : t('room.inviteLink')}
          </button>

          <div className="room-minbet-box">
            <span className="muted small">{t('room.minBet')}</span>
            <strong className="tabular">
              {formatChips(room.min_bet)} {t('room.chips')}
            </strong>
          </div>

          <button
            type="button"
            className={`btn btn--ghost btn--sm${emotesExpanded ? ' is-selected-pill' : ''}`}
            onClick={() => setEmotesExpanded((v) => !v)}
          >
            🎭 {t('room.emotesToggle')}
          </button>

          <button type="button" className="btn btn--ghost btn--sm" onClick={() => nav('/lobby')}>
            {t('room.backToLobby')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void handleLeaveRoom()}>
            {t('room.leaveTable')}
          </button>
        </div>
      </header>

      {error && (
        <p className="form-error" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </p>
      )}

      {/* Return from AFK Banner */}
      {mySeat?.status === 'afk' && (
        <div className="afk-banner" role="status">
          <div>
            <p className="eyebrow">{t('room.afkEyebrow')}</p>
            <strong>{t('room.afkTitle')}</strong>
            <p className="muted small">{t('room.afkDesc')}</p>
          </div>
          <button
            type="button"
            className="btn btn--gold"
            onClick={() => void handleReturnFromAfk()}
            disabled={returningAfk}
          >
            {returningAfk ? t('room.returning') : t('room.returnFromAfk')}
          </button>
        </div>
      )}

      {/* Compact Collapsible Emote Strip */}
      {emotesExpanded && (
        <section className="emote-dock emote-dock--compact" aria-label="Emote controls">
          <div className="emote-dock__group">
            <span className="eyebrow">{t('room.quickEmotes')}</span>
            <div className="quick-emote-bar">
              {QUICK_EMOTES.map((qe) => (
                <button
                  key={qe.id}
                  type="button"
                  className="quick-emote-btn"
                  onClick={() => void handleSendQuickEmote(qe)}
                  title={`Show "${qe.phrase}" over your avatar`}
                  data-silent
                >
                  <span>{qe.symbol}</span>
                  <span>{qe.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="emote-dock__group">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="eyebrow">{t('room.interactiveEmotes')}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => nav('/shop')}
              >
                {t('room.buyInShop')}
              </button>
            </div>
            <div className="interactive-ammo-bar">
              {interactiveItems.map((item) => {
                const qty = inventoryByItemId.get(item.id)?.quantity ?? 0;
                const animKey = item.metadata?.animation ?? 'egg_toss';
                const selected = selectedEmoteItemId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`ammo-pill${selected ? ' is-selected' : ''}${
                      qty === 0 ? ' is-empty' : ''
                    }`}
                    onClick={() => setSelectedEmoteItemId(item.id)}
                  >
                    <EmoteVectorIcon animation={animKey} size={22} />
                    <span>{item.name}</span>
                    <span className="badge tabular">{qty}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Full-Width Maximized Game Table Area */}
      <div className="room-layout room-layout--maximized">
        <div className="room-main">
          {room.game === 'blackjack' ? (
            <BlackjackTable
              room={room}
              seats={seats}
              currentUserId={user?.id ?? null}
              gameState={gameState}
              cardBackMap={cardBackMap}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              turnRemainingMs={turnRemainingMs}
              actionBusy={actionBusy}
              onStartRound={handleStartRound}
              onPlaceBet={handleBlackjackBet}
              onAction={handleBlackjackAction}
              onFireInteractive={handleFireInteractiveEmote}
            />
          ) : room.game === 'roulette' ? (
            <RouletteTable
              room={room}
              seats={seats}
              currentUserId={user?.id ?? null}
              gameState={gameState}
              cardBackMap={cardBackMap}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              turnRemainingMs={turnRemainingMs}
              actionBusy={actionBusy}
              onStartRound={handleRouletteStartRound}
              onPlaceBets={handleRoulettePlaceBets}
              onFireInteractive={handleFireInteractiveEmote}
            />
          ) : room.game === 'slots' ? (
            <SlotsMachine
              room={room}
              seats={seats}
              currentUserId={user?.id ?? null}
              gameState={gameState}
              cardBackMap={cardBackMap}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              actionBusy={actionBusy}
              onSpin={handleSlotsSpin}
              onFireInteractive={handleFireInteractiveEmote}
            />
          ) : room.game === 'poker' ? (
            <PokerTable
              room={room}
              seats={seats}
              currentUserId={user?.id ?? null}
              gameState={gameState}
              myPrivateCards={myPrivateCards}
              cardBackMap={cardBackMap}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              turnRemainingMs={turnRemainingMs}
              actionBusy={actionBusy}
              onStartHand={handlePokerStartHand}
              onAction={handlePokerAction}
              onFireInteractive={handleFireInteractiveEmote}
            />
          ) : room.game === 'durak' ? (
            <DurakTable
              room={room}
              seats={seats}
              currentUserId={user?.id ?? null}
              gameState={gameState}
              myPrivateCards={myPrivateCards}
              cardBackMap={cardBackMap}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              turnRemainingMs={turnRemainingMs}
              actionBusy={actionBusy}
              onStartGame={handleDurakStartGame}
              onAttack={handleDurakAttack}
              onDefend={handleDurakDefend}
              onTake={handleDurakTake}
              onPass={handleDurakPass}
              onFireInteractive={handleFireInteractiveEmote}
            />
          ) : room.game === 'chess' || room.game === 'checkers' ? (
            <BoardGameTable
              gameKind={room.game}
              room={room}
              seats={seats}
              currentUserId={user?.id ?? null}
              gameState={gameState}
              cardBackMap={cardBackMap}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              turnRemainingMs={turnRemainingMs}
              actionBusy={actionBusy}
              onStartGame={() => handleBoardStartGame(room.game as 'chess' | 'checkers')}
              onMove={(fromSq, toSq) =>
                handleBoardMove(room.game as 'chess' | 'checkers', fromSq, toSq)
              }
              onResign={() => handleBoardResign(room.game as 'chess' | 'checkers')}
              onFireInteractive={handleFireInteractiveEmote}
            />
          ) : (
            <div className="table-felt">
              <div className="table-felt__center">
                <p className="eyebrow">
                  {gameState?.phase === 'playing'
                    ? `Hand #${gameState.state?.round_number ?? 1} · In Progress`
                    : 'Waiting to Deal'}
                </p>

                {turnPlayer && turnSeconds !== null ? (
                  <div className="turn-spotlight">
                    <div className="turn-spotlight__title">
                      {isMyTurn ? (
                        <span className="gold-text">Your Turn to Act</span>
                      ) : (
                        <span>{turnPlayer.username}&apos;s Turn</span>
                      )}
                      <span
                        className={`turn-clock tabular${
                          Number(turnSeconds) <= 5 ? ' turn-clock--urgent' : ''
                        }`}
                      >
                        {turnSeconds}s
                      </span>
                    </div>
                    <div className="turn-progress" aria-hidden="true">
                      <div
                        className={`turn-progress__fill${
                          Number(turnSeconds) <= 5 ? ' is-urgent' : ''
                        }`}
                        style={{ width: `${turnProgressPct}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="muted small">
                    Seat players and start a round to activate the 15-second turn clock.
                  </p>
                )}

                <div className="row row--center table-felt__controls">
                  {gameState?.phase !== 'playing' && (
                    <button
                      type="button"
                      className="btn btn--gold"
                      onClick={() => void handleStartRound()}
                      disabled={actionBusy}
                    >
                      {actionBusy ? 'Starting…' : 'Start Round'}
                    </button>
                  )}
                </div>
              </div>

              {/* Seated Players Grid */}
              <div className="seats-grid">
                {seats.map((seat) => {
                  const isTurn = gameState?.turn_user_id === seat.user_id;
                  const isMe = user?.id === seat.user_id;
                  const quickBubble = quickEmotesByUser[seat.user_id];
                  const incomingHit =
                    activeInteractiveEmote && activeInteractiveEmote.target_id === seat.user_id
                      ? activeInteractiveEmote
                      : null;
                  const outgoingCast =
                    activeInteractiveEmote && activeInteractiveEmote.sender_id === seat.user_id
                      ? activeInteractiveEmote
                      : null;
                  const cbItem = seat.equipped_card_back
                    ? cardBackMap.get(seat.equipped_card_back)
                    : null;
                  const cardBackUrl = cbItem ? resolveCardBackUrl(cbItem) : DEFAULT_CARD_BACK_URL;

                  return (
                    <div
                      key={seat.user_id}
                      className={`seat-card${isTurn ? ' seat-card--turn' : ''}${
                        seat.status === 'afk' ? ' seat-card--afk' : ''
                      }${incomingHit ? ' seat-card--hit' : ''}${
                        outgoingCast ? ' seat-card--casting' : ''
                      }`}
                    >
                      {quickBubble && (
                        <div key={quickBubble.id} className="quick-emote-bubble" role="status">
                          <span className="quick-emote-bubble__sym">{quickBubble.symbol}</span>
                          <span>{quickBubble.phrase}</span>
                        </div>
                      )}

                      {incomingHit && (
                        <div key={incomingHit.id} className="seat-hit-overlay" role="status">
                          <EmoteVectorIcon animation={incomingHit.animation} size={48} />
                          <span className="emote-stage__impact">
                            {EMOTE_SPECS[incomingHit.animation]?.impactWord ?? 'HIT!'}
                          </span>
                        </div>
                      )}

                      <div className="seat-card__top">
                        <span className="muted small tabular">
                          {t('room.seat')} #{seat.seat + 1}
                        </span>
                        <div className="row">
                          {room.host_id === seat.user_id && (
                            <span className="badge">{t('room.host')}</span>
                          )}
                          {seat.status === 'afk' ? (
                            <span className="badge badge--timeout">AFK</span>
                          ) : isTurn ? (
                            <span className="badge badge--open">{t('room.acting')}</span>
                          ) : null}
                        </div>
                      </div>

                      <div className="seat-card__identity">
                        <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={52} />
                        <div className="seat-card__meta">
                          <strong className="seat-card__name">
                            {seat.username} {isMe ? t('room.you') : ''}
                          </strong>
                          <span className="muted small">
                            {cbItem ? cbItem.name : 'House Deck'}
                          </span>
                        </div>
                        <img
                          src={cardBackUrl}
                          alt="Equipped card back"
                          className="seat-card__cardback"
                          width={28}
                          height={40}
                          draggable={false}
                        />
                      </div>

                      {!isMe && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm seat-target-btn"
                          onClick={() => void handleFireInteractiveEmote(seat.user_id)}
                        >
                          {t('room.targetEmote')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Compact Collapsible Floating Chat Widget */}
      <aside
        className={`room-chat-floating${chatOpen ? ' is-open' : ' is-minimized'}`}
        aria-label={t('room.chatTitle')}
      >
        {!chatOpen ? (
          <button
            type="button"
            className="room-chat-fab"
            onClick={() => {
              setChatOpen(true);
              setUnreadCount(0);
            }}
          >
            <span className="room-chat-fab__icon" aria-hidden="true">
              💬
            </span>
            <span>{t('room.chatTitle')}</span>
            {unreadCount > 0 && (
              <span className="room-chat-fab__badge tabular">{unreadCount}</span>
            )}
          </button>
        ) : (
          <div className="room-chat room-chat--compact">
            <div className="room-chat__head">
              <div className="row" style={{ gap: '0.45rem' }}>
                <span className="eyebrow">{t('room.chatTitle')}</span>
                <span className="muted small tabular">({messages.length})</span>
              </div>
              <button
                type="button"
                className="room-chat__close-btn"
                onClick={() => setChatOpen(false)}
                aria-label="Minimize chat"
                title="Minimize chat"
              >
                —
              </button>
            </div>

            <div className="room-chat__log" role="log" aria-live="polite">
              {messages.length === 0 ? (
                <p className="muted small">{t('room.chatEmpty')}</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className="chat-msg">
                    <Avatar avatarId={m.avatar_id} userId={m.user_id} size={22} />
                    <div className="chat-msg__bubble">
                      <div className="chat-msg__meta">
                        <strong>{m.username}</strong>
                        <span className="muted small tabular">
                          {new Date(m.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <p className="chat-msg__body">{m.content}</p>
                    </div>
                  </div>
                ))
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Quick Emote Mini-Row inside Chat */}
            <div className="room-chat__quick-emotes">
              {QUICK_EMOTES.map((qe) => (
                <button
                  key={qe.id}
                  type="button"
                  className="chat-mini-emote-btn"
                  onClick={() => void handleSendQuickEmote(qe)}
                  title={qe.phrase}
                  data-silent
                >
                  {qe.symbol}
                </button>
              ))}
            </div>

            <form className="room-chat__form" onSubmit={handleSendChat}>
              <input
                type="text"
                maxLength={280}
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                placeholder={t('room.chatPlaceholder')}
                aria-label={t('room.chatPlaceholder')}
              />
              <button type="submit" className="btn btn--gold btn--sm" disabled={sendingChat}>
                {t('room.chatSend')}
              </button>
            </form>
          </div>
        )}
      </aside>
    </section>
  );
}
