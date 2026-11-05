import { useEffect, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  BoardMoveRecord,
  GameStateRow,
  InteractiveEmoteEvent,
  QuickEmoteEvent,
  Room,
  RoomSeatWithProfile,
  ShopItem,
} from '../lib/types';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';

const CHESS_PIECE_GLYPH: Record<string, string> = {
  wp: '♙',
  wn: '♘',
  wb: '♗',
  wr: '♖',
  wq: '♕',
  wk: '♔',
  bp: '♟',
  bn: '♞',
  bb: '♝',
  br: '♜',
  bq: '♛',
  bk: '♚',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

function sqToAlgebraic(sq: number): string {
  const r = Math.floor(sq / 8);
  const c = sq % 8;
  return `${FILES[c] ?? '?'}${8 - r}`;
}

interface BoardGameTableProps {
  gameKind: 'chess' | 'checkers';
  room: Room;
  seats: RoomSeatWithProfile[];
  currentUserId: string | null;
  gameState: GameStateRow | null;
  cardBackMap: Map<string, ShopItem>;
  quickEmotesByUser: Record<string, QuickEmoteEvent>;
  activeInteractiveEmote: InteractiveEmoteEvent | null;
  turnRemainingMs: number | null;
  actionBusy: boolean;
  onStartGame: () => Promise<void>;
  onMove: (fromSq: number, toSq: number) => Promise<void>;
  onResign: () => Promise<void>;
  onFireInteractive: (targetUserId: string) => Promise<void>;
}

export function BoardGameTable({
  gameKind,
  room,
  seats,
  currentUserId,
  gameState,
  cardBackMap,
  quickEmotesByUser,
  activeInteractiveEmote,
  turnRemainingMs,
  actionBusy,
  onStartGame,
  onMove,
  onResign,
  onFireInteractive,
}: BoardGameTableProps) {
  const { sound } = useSound();
  const { t } = useI18n();
  const [selectedSq, setSelectedSq] = useState<number | null>(null);

  const phase = gameState?.phase ?? 'lobby';
  const roundNumber = gameState?.state?.round_number ?? 0;
  const pot = gameState?.state?.pot ?? 0;
  const entryBet = gameState?.state?.entry_bet ?? Math.max(room.min_bet || 100, 50);
  const board = (gameState?.state?.board ?? []) as (string | null)[];
  const turnColor = (gameState?.state?.turn_color ?? 'w') as string;
  const whiteUser = gameState?.state?.white_user ?? gameState?.state?.red_user ?? null;
  const blackUser = gameState?.state?.black_user ?? null;
  const forcedFrom =
    typeof gameState?.state?.forced_from === 'number' ? gameState.state.forced_from : null;
  const lastMove = (gameState?.state?.last_move ?? null) as BoardMoveRecord | null;
  const winnerId = gameState?.state?.winner_id ?? null;
  const outcomeReason = gameState?.state?.outcome_reason ?? null;

  const isMyTurn = Boolean(currentUserId && gameState?.turn_user_id === currentUserId);
  const myColor: 'w' | 'b' | 'r' | null =
    currentUserId && currentUserId === whiteUser
      ? gameKind === 'chess'
        ? 'w'
        : 'r'
      : currentUserId && currentUserId === blackUser
        ? 'b'
        : null;

  useEffect(() => {
    if (forcedFrom !== null && isMyTurn) {
      setSelectedSq(forcedFrom);
    } else {
      setSelectedSq(null);
    }
  }, [roundNumber, turnColor, forcedFrom, isMyTurn]);

  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;
  const turnSeconds = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;

  function isOwnPiece(piece: string | null | undefined): boolean {
    if (!piece || !myColor) return false;
    return piece.startsWith(myColor);
  }

  async function handleSquareClick(sq: number) {
    if (phase !== 'playing' || !isMyTurn || actionBusy) return;
    const piece = board[sq];

    if (forcedFrom !== null && selectedSq !== forcedFrom) {
      setSelectedSq(forcedFrom);
      return;
    }

    if (selectedSq === null) {
      if (isOwnPiece(piece)) {
        sound.play('uiClick');
        setSelectedSq(sq);
      }
      return;
    }

    if (selectedSq === sq) {
      if (forcedFrom === null) setSelectedSq(null);
      return;
    }

    if (isOwnPiece(piece) && forcedFrom === null) {
      sound.play('uiClick');
      setSelectedSq(sq);
      return;
    }

    const from = selectedSq;
    if (forcedFrom === null) setSelectedSq(null);
    await onMove(from, sq);
  }

  const flipBoard = myColor === 'b';
  const displaySquares = Array.from({ length: 64 }, (_, i) => (flipBoard ? 63 - i : i));

  return (
    <section
      className="table-felt casino-oval-felt board-felt"
      aria-label={`${gameKind === 'chess' ? 'Chess' : 'Checkers'} table`}
    >
      {/* Top Bar */}
      <div className="rl-top-bar">
        <div>
          <span className="eyebrow">
            {gameKind === 'chess' ? t('board.chessTitle') : t('board.checkersTitle')}
          </span>
          <div className="muted small">
            {phase === 'playing'
              ? `Match #${roundNumber} · Turn: ${
                  turnColor === 'w'
                    ? t('board.white')
                    : turnColor === 'r'
                      ? t('board.red')
                      : t('board.black')
                }`
              : 'Seat 2 players to start a match'}
          </div>
        </div>

        <div className="row">
          <div className="room-minbet-box">
            <span className="muted small">{t('durak.pot')}</span>
            <strong className="gold-text tabular">
              {formatChips(pot)} {t('room.chips')}
            </strong>
          </div>

          {phase !== 'playing' && seats.length >= 2 && (
            <button
              type="button"
              className="btn btn--gold btn--sm"
              onClick={() => void onStartGame()}
              disabled={actionBusy}
            >
              {actionBusy ? '…' : `${t('board.startMatch')} (${formatChips(entryBet)})`}
            </button>
          )}

          {phase === 'playing' && myColor !== null && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void onResign()}
              disabled={actionBusy}
            >
              {t('board.resign')}
            </button>
          )}
        </div>
      </div>

      {/* Main 8x8 Board + Side Info */}
      <div className="board-arena-layout">
        <div className="board-frame">
          {board.length === 64 ? (
            <div className="board-grid-8x8" role="grid" aria-label="8 by 8 game board">
              {displaySquares.map((sq) => {
                const r = Math.floor(sq / 8);
                const c = sq % 8;
                const isDark = (r + c) % 2 === 1;
                const piece = board[sq];
                const isSelected = selectedSq === sq;
                const isLastMove =
                  lastMove !== null && (lastMove.from === sq || lastMove.to === sq);

                return (
                  <button
                    key={sq}
                    type="button"
                    className={`board-sq ${isDark ? 'board-sq--dark' : 'board-sq--light'}${
                      isSelected ? ' board-sq--selected' : ''
                    }${isLastMove ? ' board-sq--lastmove' : ''}`}
                    onClick={() => void handleSquareClick(sq)}
                    disabled={phase !== 'playing' || !isMyTurn || actionBusy}
                    title={sqToAlgebraic(sq)}
                    data-silent
                  >
                    {c === (flipBoard ? 7 : 0) && (
                      <span className="board-coord-rank">{8 - r}</span>
                    )}
                    {r === (flipBoard ? 0 : 7) && (
                      <span className="board-coord-file">{FILES[c]}</span>
                    )}

                    {piece && gameKind === 'chess' && (
                      <span
                        className={`chess-glyph ${
                          piece.startsWith('w') ? 'chess-glyph--white' : 'chess-glyph--black'
                        }`}
                        aria-label={piece}
                      >
                        {CHESS_PIECE_GLYPH[piece] ?? piece}
                      </span>
                    )}

                    {piece && gameKind === 'checkers' && (
                      <svg
                        viewBox="0 0 48 48"
                        width="38"
                        height="38"
                        aria-label={piece}
                      >
                        <circle
                          cx="24"
                          cy="24"
                          r="19"
                          fill={piece.startsWith('r') ? '#9e1c34' : '#1b1b22'}
                          stroke="#e6c469"
                          strokeWidth="2.5"
                        />
                        <circle
                          cx="24"
                          cy="24"
                          r="13"
                          fill="none"
                          stroke="rgba(230, 196, 105, 0.55)"
                          strokeWidth="1.5"
                        />
                        {piece.endsWith('k') && (
                          <text
                            x="24"
                            y="29"
                            textAnchor="middle"
                            fill="#f5df9e"
                            fontSize="16"
                            fontWeight="700"
                          >
                            ♔
                          </text>
                        )}
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="board-idle-placeholder">
              <p className="eyebrow">
                {gameKind === 'chess' ? t('game.chess') : t('game.checkers')}
              </p>
              <p className="muted small">
                {seats.length < 2
                  ? 'Waiting for a second player to take a seat…'
                  : 'Click Start Match above to initialize the 8×8 board.'}
              </p>
            </div>
          )}
        </div>

        {/* Right Side: Turn Clock, Move Telemetry & Outcome */}
        <div className="board-side-info">
          {turnPlayer && turnSeconds !== null && (
            <div className="turn-spotlight">
              <div className="turn-spotlight__title">
                {isMyTurn ? (
                  <span className="gold-text">{t('room.acting')}</span>
                ) : (
                  <span>{turnPlayer.username}</span>
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
          )}

          {forcedFrom !== null && isMyTurn && (
            <div className="afk-banner">
              <strong>Multi-Jump Continuation Required</strong>
              <p className="muted small">
                Complete the capture sequence from {sqToAlgebraic(forcedFrom)}.
              </p>
            </div>
          )}

          {lastMove && (
            <div className="rl-result-box">
              <span className="eyebrow">Last Move</span>
              <div>
                <strong>
                  {sqToAlgebraic(lastMove.from)} → {sqToAlgebraic(lastMove.to)}
                </strong>
                {lastMove.captured && (
                  <span className="badge badge--timeout" style={{ marginLeft: '0.5rem' }}>
                    Captured
                  </span>
                )}
                {lastMove.promoted && (
                  <span className="badge badge--bj-win" style={{ marginLeft: '0.5rem' }}>
                    Promoted
                  </span>
                )}
              </div>
            </div>
          )}

          {phase === 'settled' && (
            <div
              className={`bj-outcome-banner ${
                winnerId === currentUserId ? 'bj-outcome-banner--win' : 'bj-outcome-banner--push'
              }`}
              role="status"
            >
              <strong>
                {winnerId === currentUserId ? 'MATCH VICTORY!' : 'MATCH CONCLUDED'}
              </strong>
              <span>
                {outcomeReason ? `Reason: ${String(outcomeReason).replace(/_/g, ' ')} · ` : ''}
                Pot: {formatChips(pot)} {t('room.chips')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Seated Players */}
      <div className="seats-grid seats-grid--arc">
        {seats.map((seat) => {
          const isTurn = gameState?.turn_user_id === seat.user_id;
          const isMe = currentUserId === seat.user_id;
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

          const seatColorBadge =
            seat.user_id === whiteUser
              ? gameKind === 'chess'
                ? `♔ ${t('board.white')}`
                : `🔴 ${t('board.red')}`
              : seat.user_id === blackUser
                ? gameKind === 'chess'
                  ? `♚ ${t('board.black')}`
                  : `⚫ ${t('board.black')}`
                : null;

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
                <span className="muted small tabular">
                  {t('room.seat')} #{seat.seat + 1}
                </span>
                <div className="row">
                  {seatColorBadge && <span className="badge badge--open">{seatColorBadge}</span>}
                  {seat.status === 'afk' && <span className="badge badge--timeout">AFK</span>}
                </div>
              </div>

              <div className="seat-card__identity">
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={46} />
                <div className="seat-card__meta">
                  <strong className="seat-card__name">
                    {seat.username} {isMe ? t('room.you') : ''}
                  </strong>
                  <span className="muted small">
                    {isTurn && phase === 'playing' ? t('room.acting') : t('room.tableReady')}
                  </span>
                </div>
                <img
                  src={cardBackUrl}
                  alt="Equipped card back"
                  className="seat-card__cardback"
                  width={26}
                  height={38}
                  draggable={false}
                />
              </div>

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
  );
}
