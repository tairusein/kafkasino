import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { BlackjackTable } from '../components/BlackjackTable';
import { BoardGameTable } from '../components/BoardGameTable';
import { DurakTable } from '../components/DurakTable';
import { EmoteVectorIcon } from '../components/InteractiveEmotePreview';
import { PokerTable } from '../components/PokerTable';
import { RouletteTable } from '../components/RouletteTable';
import { SlotsMachine } from '../components/SlotsMachine';
import { useRoomEngine } from '../game/useRoomEngine';
import { useI18n } from '../i18n/I18nProvider';
import { QUICK_EMOTES } from '../lib/emotes';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type { RouletteBetItem } from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';

const ROOM_WITH_PIN_RE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-([A-Za-z0-9]{6})$/;

export function GameRoomPage() {
  const { roomId: rawRoomParam = '' } = useParams<{ gameType?: string; roomId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { balance } = useWallet();
  const { t, gameName } = useI18n();

  // Support both /room/<uuid>?pin=XXXXXX and compact /room/<uuid>-XXXXXX direct invite links
  const { roomId, invitePin } = useMemo(() => {
    const match = ROOM_WITH_PIN_RE.exec(rawRoomParam.trim());
    if (match) {
      return { roomId: match[1], invitePin: match[2].toUpperCase() };
    }
    const queryPin = searchParams.get('pin');
    return {
      roomId: rawRoomParam.trim(),
      invitePin: queryPin ? queryPin.trim().toUpperCase() : null,
    };
  }, [rawRoomParam, searchParams]);

  const {
    room,
    hostPin,
    seats,
    mySeat,
    gameState,
    privateState,
    messages,
    cardBackMap,
    emoteInventory,
    quickEmotesByUser,
    activeInteractiveEmote,
    turnRemainingMs,
    loading,
    syncStatus,
    error,
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
  } = useRoomEngine(roomId, invitePin);

  const [chatText, setChatText] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showEmotes, setShowEmotes] = useState(false);
  const [selectedEmoteItemId, setSelectedEmoteItemId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [uiNotice, setUiNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pinCopied, setPinCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef<number>(0);

  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      const diff = messages.length - prevMsgCountRef.current;
      if (!chatOpen && prevMsgCountRef.current > 0) {
        setUnreadCount((c) => c + diff);
      }
      if (chatOpen) {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length, chatOpen]);

  useEffect(() => {
    if (chatOpen) {
      setUnreadCount(0);
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatOpen]);

  // Default selected interactive emote to the first owned emote with charges > 0.
  useEffect(() => {
    if (selectedEmoteItemId) return;
    const withCharges = emoteInventory.find((e) => e.quantity > 0);
    if (withCharges) setSelectedEmoteItemId(withCharges.item.id);
  }, [emoteInventory, selectedEmoteItemId]);

  async function onLeave() {
    await leaveRoom();
    navigate('/lobby');
  }

  async function onCopyPin() {
    if (!hostPin) return;
    try {
      await navigator.clipboard.writeText(hostPin);
      setPinCopied(true);
      window.setTimeout(() => setPinCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  }

  function buildDirectInviteUrl(): string {
    if (!room) return window.location.href;
    const base = `${window.location.origin}/room/${room.id}`;
    if (room.visibility === 'private' && hostPin) {
      return `${base}?pin=${encodeURIComponent(hostPin)}`;
    }
    return base;
  }

  async function onCopyInviteLink() {
    const url = buildDirectInviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2200);
    } catch {
      /* clipboard blocked */
    }
  }

  async function onShareInviteLink() {
    const url = buildDirectInviteUrl();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: `Kafkasino — ${room?.name ?? 'Private Table'}`,
          text: `Take a seat at my ${room?.game_type ?? 'Kafkasino'} table:`,
          url,
        });
        return;
      } catch {
        /* user cancelled or share unavailable */
      }
    }
    await onCopyInviteLink();
  }

  async function onSendChat(e: FormEvent) {
    e.preventDefault();
    const trimmed = chatText.trim();
    if (!trimmed || sendingChat) return;
    setSendingChat(true);
    setUiNotice(null);
    try {
      await sendChat(trimmed);
      setChatText('');
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not send message.' });
    } finally {
      setSendingChat(false);
    }
  }

  async function onFireInteractive(targetUserId: string) {
    if (!selectedEmoteItemId) {
      setShowEmotes(true);
      setUiNotice({
        kind: 'error',
        text: 'Select an Interactive Emote with available charges below (or restock in the Shop).',
      });
      return;
    }
    setUiNotice(null);
    try {
      await sendInteractiveEmote(targetUserId, selectedEmoteItemId);
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not send emote.' });
    }
  }

  async function onStartTurn() {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await startTurnCycle();
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to start turn.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onTurnMove(move: string) {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await performTurnAction(move);
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Move rejected.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onBjStartRound() {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await startBlackjackRound();
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start hand.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onBjPlaceBet(amount: number) {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await placeBlackjackBet(amount);
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not place bet.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onBjAction(action: 'hit' | 'stand' | 'double') {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await actBlackjack(action);
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Action rejected.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onRlStartRound() {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await startRouletteRound();
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not open Roulette betting.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onRlPlaceBets(bets: Pick<RouletteBetItem, 'kind' | 'number' | 'amount'>[]) {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await placeRouletteBets(bets);
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not place Roulette bets.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onSlSpin(bet: number) {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await spinSlots(bet);
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Spin rejected.' });
    } finally {
      setActionBusy(false);
    }
  }

  async function onReturnFromAfk() {
    setActionBusy(true);
    setUiNotice(null);
    try {
      await returnFromAfk();
      setUiNotice({ kind: 'ok', text: 'Welcome back. Your seat is active again.' });
    } catch (err) {
      setUiNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not update status.' });
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <p className="muted">Synchronizing table state…</p>
      </div>
    );
  }

  if (error || !room) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <p className="eyebrow">Table Unavailable</p>
            <h1>Could not join room</h1>
          </div>
          <Link className="btn btn--gold" to="/lobby">
            {t('room.backToLobby')}
          </Link>
        </header>
        <p className="form-error">{error ?? 'Room not found.'}</p>
      </div>
    );
  }

  const isMyTurn = Boolean(user && gameState?.turn_user_id === user.id);
  const turnSeconds = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct = turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;
  const lastAction = gameState?.state?.last_action;
  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;

  return (
    <div className="page room-page">
      {/* Compact Top Room Header */}
      <header className="room-header">
        <div>
          <div className="row">
            <span className="eyebrow">{gameName(room.game_type)}</span>
            <span className={`badge ${room.visibility === 'private' ? 'badge--open' : ''}`}>
              {room.visibility === 'private' ? t('room.privatePin') : t('room.publicTable')}
            </span>
            <span className="badge tabular" title="Authoritative state version">
              {syncStatus === 'synced' ? `● v${gameState?.version ?? 0}` : '↻ Sync…'}
            </span>
          </div>
          <h1 className="room-header__title">{room.name}</h1>
        </div>

        <div className="row">
          {hostPin && (
            <div className="room-pin-box" title="Share this direct invite link or 6-character PIN with invited players">
              <span className="muted small">{t('room.roomPin')}</span>
              <strong className="room-pin-box__code tabular">{hostPin}</strong>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onCopyPin()}>
                {pinCopied ? t('room.copied') : t('room.copy')}
              </button>
              <button
                type="button"
                className="btn btn--gold btn--sm room-invite-btn"
                onClick={() => void onCopyInviteLink()}
              >
                {inviteCopied ? t('room.linkCopied') : t('room.inviteLink')}
              </button>
              {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void onShareInviteLink()}
                  title="Share direct invite link"
                >
                  Share
                </button>
              )}
            </div>
          )}
          {!hostPin && room.visibility === 'public' && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onCopyInviteLink()}
              title="Copy direct link to this table"
            >
              {inviteCopied ? t('room.linkCopied') : t('room.inviteLink')}
            </button>
          )}
          <div className="room-minbet-box">
            <span className="muted small">{t('room.minBet')}</span>
            <strong className="tabular">{formatChips(room.min_bet)}</strong>
          </div>
          <button
            type="button"
            className={`btn btn--sm ${showEmotes ? 'btn--gold' : 'btn--ghost'}`}
            onClick={() => setShowEmotes((v) => !v)}
          >
            🎭 {t('room.emotesToggle')}
          </button>
          <button
            type="button"
            className={`btn btn--sm ${chatOpen ? 'btn--gold' : 'btn--ghost'}`}
            onClick={() => setChatOpen((v) => !v)}
          >
            💬 {t('room.chatTitle')}
            {unreadCount > 0 && <span className="badge badge--open tabular">+{unreadCount}</span>}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onLeave()}>
            {t('room.leaveTable')}
          </button>
        </div>
      </header>

      {/* AFK Status Recovery Banner */}
      {mySeat?.status === 'afk' && (
        <div className="afk-banner" role="alert">
          <div>
            <strong>{t('room.afkTitle')}</strong>
            <p className="muted small">{t('room.afkDesc')}</p>
          </div>
          <button
            type="button"
            className="btn btn--gold"
            onClick={() => void onReturnFromAfk()}
            disabled={actionBusy}
          >
            {actionBusy ? t('room.returning') : t('room.returnFromAfk')}
          </button>
        </div>
      )}

      {uiNotice && (
        <p className={uiNotice.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
          {uiNotice.text}
        </p>
      )}

      {/* Maximized Full-Width Game Table Area */}
      <div className="room-layout room-layout--maximized">
        <div className="room-main">
          {room.game_type === 'blackjack' ? (
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
              onStartRound={onBjStartRound}
              onPlaceBet={onBjPlaceBet}
              onAction={onBjAction}
              onFireInteractive={onFireInteractive}
            />
          ) : room.game_type === 'roulette' ? (
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
              onStartRound={onRlStartRound}
              onPlaceBets={onRlPlaceBets}
              onFireInteractive={onFireInteractive}
            />
          ) : room.game_type === 'slots' ? (
            <SlotsMachine
              room={room}
              gameState={gameState}
              actionBusy={actionBusy}
              onSpin={onSlSpin}
            />
          ) : room.game_type === 'poker' ? (
            <PokerTable
              myUserId={user?.id ?? ''}
              minBet={room.min_bet}
              walletBalance={balance}
              seats={seats}
              gameState={gameState}
              privateState={privateState}
              cardBackMap={cardBackMap}
              turnRemainingMs={turnRemainingMs}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              onFireInteractive={onFireInteractive}
              onStartHand={startPokerHand}
              onAction={actPoker}
            />
          ) : room.game_type === 'durak' ? (
            <DurakTable
              myUserId={user?.id ?? ''}
              minBet={room.min_bet}
              seats={seats}
              gameState={gameState}
              privateState={privateState}
              cardBackMap={cardBackMap}
              turnRemainingMs={turnRemainingMs}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              onFireInteractive={onFireInteractive}
              onStartGame={startDurakGame}
              onAction={actDurak}
            />
          ) : room.game_type === 'chess' ? (
            <BoardGameTable
              mode="chess"
              myUserId={user?.id ?? ''}
              minBet={room.min_bet}
              seats={seats}
              gameState={gameState}
              turnRemainingMs={turnRemainingMs}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              onFireInteractive={onFireInteractive}
              onStartGame={startChessGame}
              onMoveChess={moveChess}
            />
          ) : room.game_type === 'checkers' ? (
            <BoardGameTable
              mode="checkers"
              myUserId={user?.id ?? ''}
              minBet={room.min_bet}
              seats={seats}
              gameState={gameState}
              turnRemainingMs={turnRemainingMs}
              quickEmotesByUser={quickEmotesByUser}
              activeInteractiveEmote={activeInteractiveEmote}
              onFireInteractive={onFireInteractive}
              onStartGame={startCheckersGame}
              onMoveCheckers={moveCheckers}
            />
          ) : (
            <section className="table-felt casino-oval-felt" aria-label="Game table">
              <div className="table-felt__center">
                <p className="eyebrow">
                  Phase: {gameState?.phase ?? 'lobby'} · Turn #{gameState?.state?.turn_number ?? 0}
                </p>

                {turnPlayer && turnSeconds !== null ? (
                  <div className="turn-spotlight">
                    <div className="turn-spotlight__title">
                      {isMyTurn ? (
                        <span className="gold-text">Your Turn to Act</span>
                      ) : (
                        <span>Waiting on {turnPlayer.username}</span>
                      )}
                      <span className={`turn-clock tabular${Number(turnSeconds) <= 5 ? ' turn-clock--urgent' : ''}`}>
                        {turnSeconds}s
                      </span>
                    </div>
                    <div className="turn-progress" aria-hidden="true">
                      <div
                        className={`turn-progress__fill${Number(turnSeconds) <= 5 ? ' is-urgent' : ''}`}
                        style={{ width: `${turnProgressPct}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="muted small">
                    Start a 15-second turn cycle below to test Realtime sync and automatic AFK timeout enforcement.
                  </p>
                )}

                {lastAction && (
                  <div className="last-action-pill">
                    <span className="muted small">Last Action:</span>{' '}
                    <strong>{lastAction.type.toUpperCase()}</strong>
                    {lastAction.forced_by_timeout && (
                      <span className="badge badge--timeout">Forced by 15s Timeout → AFK</span>
                    )}
                  </div>
                )}

                <div className="row row--center table-felt__controls">
                  <button
                    type="button"
                    className="btn btn--gold"
                    onClick={() => void onStartTurn()}
                    disabled={actionBusy}
                  >
                    {gameState?.turn_user_id ? 'Restart 15s Turn Clock' : 'Start 15s Turn Cycle'}
                  </button>
                  {isMyTurn && (
                    <>
                      <button
                        type="button"
                        className="btn btn--gold"
                        onClick={() => void onTurnMove('check_or_bet')}
                        disabled={actionBusy}
                      >
                        Act: Check / Bet
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void onTurnMove('stand_or_pass')}
                        disabled={actionBusy}
                      >
                        Act: Stand / Pass
                      </button>
                    </>
                  )}
                </div>
              </div>

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
                  const cbItem = seat.equipped_card_back ? cardBackMap.get(seat.equipped_card_back) : null;
                  const cardBackUrl = cbItem ? resolveCardBackUrl(cbItem) : DEFAULT_CARD_BACK_URL;

                  return (
                    <div
                      key={seat.user_id}
                      className={`seat-card${isTurn ? ' seat-card--turn' : ''}${
                        seat.status === 'afk' ? ' seat-card--afk' : ''
                      }${incomingHit ? ' seat-card--hit' : ''}${outgoingCast ? ' seat-card--casting' : ''}`}
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
                        <span className="muted small tabular">Seat #{seat.seat + 1}</span>
                        <div className="row">
                          {room.host_id === seat.user_id && <span className="badge">Host</span>}
                          {seat.status === 'afk' ? (
                            <span className="badge badge--timeout">AFK</span>
                          ) : seat.status === 'spectating' ? (
                            <span className="badge">Spectating</span>
                          ) : isTurn ? (
                            <span className="badge badge--open">Acting</span>
                          ) : null}
                        </div>
                      </div>

                      <div className="seat-card__identity">
                        <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={54} />
                        <div className="seat-card__meta">
                          <strong className="seat-card__name">
                            {seat.username} {isMe ? '(You)' : ''}
                          </strong>
                          <span className="muted small">{cbItem ? cbItem.name : 'House Deck'}</span>
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

                      {isTurn && turnSeconds !== null && (
                        <div className="seat-turn-bar">
                          <div
                            className={`seat-turn-bar__fill${Number(turnSeconds) <= 5 ? ' is-urgent' : ''}`}
                            style={{ width: `${turnProgressPct}%` }}
                          />
                        </div>
                      )}

                      {!isMe && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm seat-target-btn"
                          onClick={() => void onFireInteractive(seat.user_id)}
                        >
                          {t('room.targetEmote')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Collapsible Compact Emote Bar */}
          {showEmotes && (
            <section className="emote-dock emote-dock--compact" aria-label="Quick and interactive emotes">
              <div className="emote-dock__group">
                <span className="eyebrow">{t('room.quickEmotes')}</span>
                <div className="quick-emote-bar">
                  {QUICK_EMOTES.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="quick-emote-btn"
                      onClick={() => void sendQuickEmote(preset)}
                      data-silent
                    >
                      <span>{preset.symbol}</span>
                      <span>{preset.phrase}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="emote-dock__group">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="eyebrow">{t('room.interactiveEmotes')}</span>
                  <Link className="small" to="/shop">
                    {t('room.buyInShop')}
                  </Link>
                </div>
                <div className="interactive-ammo-bar">
                  {emoteInventory.map(({ item, quantity }) => {
                    const anim = item.asset?.animation ?? 'slap';
                    const selected = selectedEmoteItemId === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`ammo-pill${selected ? ' is-selected' : ''}${quantity === 0 ? ' is-empty' : ''}`}
                        onClick={() => setSelectedEmoteItemId(item.id)}
                      >
                        <EmoteVectorIcon animation={anim} size={22} />
                        <span>{item.name}</span>
                        <span className="badge tabular">×{quantity}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Compact Collapsible Floating Chat Widget */}
      <div className={`room-chat-floating${chatOpen ? ' is-open' : ''}`}>
        {!chatOpen ? (
          <button
            type="button"
            className="room-chat-fab"
            onClick={() => setChatOpen(true)}
            aria-label={t('room.chatTitle')}
          >
            <span className="room-chat-fab__icon">💬</span>
            <span className="room-chat-fab__label">{t('room.chatTitle')}</span>
            {unreadCount > 0 && <span className="room-chat-fab__badge tabular">{unreadCount}</span>}
          </button>
        ) : (
          <aside className="room-chat room-chat--compact" aria-label="Table chat">
            <div className="room-chat__head">
              <div className="row" style={{ gap: '0.4rem' }}>
                <span className="eyebrow">{t('room.chatTitle')}</span>
                <span className="badge tabular">{seats.length}</span>
              </div>
              <button
                type="button"
                className="room-chat__close"
                onClick={() => setChatOpen(false)}
                aria-label="Minimize chat"
              >
                ✕
              </button>
            </div>

            <div className="room-chat__quick-emotes">
              {QUICK_EMOTES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="room-chat__emote-chip"
                  onClick={() => void sendQuickEmote(preset)}
                  title={preset.phrase}
                  data-silent
                >
                  {preset.symbol}
                </button>
              ))}
            </div>

            <div className="room-chat__log" role="log" aria-live="polite">
              {messages.length === 0 ? (
                <p className="muted small">{t('room.chatEmpty')}</p>
              ) : (
                messages.map((m) => {
                  const sender = seats.find((s) => s.user_id === m.user_id);
                  const senderName = sender?.username ?? `player_${m.user_id.slice(0, 6)}`;
                  const senderAvatar = sender?.avatar_id ?? 'fox';
                  return (
                    <div key={m.id} className="chat-msg">
                      <Avatar avatarId={senderAvatar} userId={m.user_id} size={24} />
                      <div className="chat-msg__bubble">
                        <div className="chat-msg__meta">
                          <strong>{senderName}</strong>
                          <span className="muted small">
                            {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="chat-msg__body">{m.body}</p>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>

            <form className="room-chat__form" onSubmit={onSendChat}>
              <input
                type="text"
                maxLength={300}
                placeholder={t('room.chatPlaceholder')}
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                disabled={sendingChat}
              />
              <button type="submit" className="btn btn--gold btn--sm" disabled={sendingChat || !chatText.trim()}>
                {t('room.chatSend')}
              </button>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
}
