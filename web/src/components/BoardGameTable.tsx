import { useState } from 'react';
import { formatChips } from '../lib/format';
import { EMOTE_SPECS } from '../lib/shop';
import type {
  GameStateRow,
  InteractiveEmoteEvent,
  QuickEmoteEvent,
  RoomSeatWithProfile,
} from '../lib/types';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

function ChessPieceSvg({ code, size = 42 }: { code: string; size?: number }) {
  const color = code.startsWith('w') ? '#f7f3eb' : '#1e1e26';
  const stroke = code.startsWith('w') ? '#261b12' : '#c9a24b';
  const accent = code.startsWith('w') ? '#c9a24b' : '#e6c875';
  const kind = code.slice(1);

  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label={code}>
      {/* Pedestal base common to all pieces */}
      <path
        d="M 10 41 L 38 41 L 35 37 L 13 37 Z"
        fill={color}
        stroke={stroke}
        strokeWidth="2"
      />
      {kind === 'P' && (
        <>
          <path
            d="M 16 37 C 16 29 20 26 20 22 L 28 22 C 28 26 32 29 32 37 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="2"
          />
          <circle cx="24" cy="16" r="6" fill={color} stroke={stroke} strokeWidth="2" />
        </>
      )}
      {kind === 'R' && (
        <>
          <rect
            x="15"
            y="20"
            width="18"
            height="17"
            fill={color}
            stroke={stroke}
            strokeWidth="2"
          />
          <path
            d="M 13 20 L 13 13 L 17 13 L 17 16 L 22 16 L 22 13 L 26 13 L 26 16 L 31 16 L 31 13 L 35 13 L 35 20 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="2"
          />
        </>
      )}
      {kind === 'N' && (
        <path
          d="M 15 37 L 17 24 L 13 22 L 15 14 L 22 11 L 25 14 C 31 15 34 21 33 37 Z"
          fill={color}
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      )}
      {kind === 'B' && (
        <>
          <path
            d="M 15 37 C 15 24 18 16 24 12 C 30 16 33 24 33 37 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="2"
          />
          <circle cx="24" cy="9" r="2.5" fill={accent} stroke={stroke} strokeWidth="1.5" />
          <line x1="21" y1="20" x2="27" y2="20" stroke={accent} strokeWidth="2" />
          <line x1="24" y1="17" x2="24" y2="23" stroke={accent} strokeWidth="2" />
        </>
      )}
      {kind === 'Q' && (
        <>
          <path
            d="M 13 37 L 11 16 L 18 24 L 24 13 L 30 24 L 37 16 L 35 37 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="11" cy="14" r="2" fill={accent} />
          <circle cx="24" cy="11" r="2.2" fill={accent} />
          <circle cx="37" cy="14" r="2" fill={accent} />
        </>
      )}
      {kind === 'K' && (
        <>
          <path
            d="M 14 37 C 13 24 17 17 24 17 C 31 17 35 24 34 37 Z"
            fill={color}
            stroke={stroke}
            strokeWidth="2"
          />
          <line x1="24" y1="7" x2="24" y2="16" stroke={accent} strokeWidth="2.6" />
          <line x1="20" y1="11" x2="28" y2="11" stroke={accent} strokeWidth="2.6" />
        </>
      )}
    </svg>
  );
}

function CheckerDiscSvg({ code, size = 42 }: { code: string; size?: number }) {
  const isRed = code.toLowerCase() === 'r';
  const isKing = code === 'R' || code === 'B';
  const fill = isRed ? '#9e1f32' : '#1b1b22';
  const inner = isRed ? '#751423' : '#2a2a35';
  const rim = isRed ? '#e6c875' : '#c9a24b';

  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label={code}>
      <circle cx="24" cy="25" r="18" fill="rgba(0,0,0,0.45)" />
      <circle cx="24" cy="23" r="18" fill={fill} stroke={rim} strokeWidth="2.2" />
      <circle cx="24" cy="23" r="13" fill={inner} stroke={rim} strokeWidth="1.2" strokeDasharray="3 2" />
      {isKing ? (
        <path
          d="M 16 27 L 15 18 L 20 22 L 24 16 L 28 22 L 33 18 L 32 27 Z"
          fill="#e6c875"
          stroke="#261b12"
          strokeWidth="1.2"
        />
      ) : null}
    </svg>
  );
}

interface BoardGameTableProps {
  mode: 'chess' | 'checkers';
  myUserId: string;
  minBet: number;
  seats: RoomSeatWithProfile[];
  gameState: GameStateRow | null;
  turnRemainingMs: number | null;
  quickEmotesByUser: Record<string, QuickEmoteEvent>;
  activeInteractiveEmote: InteractiveEmoteEvent | null;
  onFireInteractive: (targetUserId: string) => Promise<void>;
  onStartGame: () => Promise<void>;
  onMoveChess?: (
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number,
    promotion?: string,
  ) => Promise<void>;
  onMoveCheckers?: (
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number,
  ) => Promise<void>;
}

export function BoardGameTable({
  mode,
  myUserId,
  minBet,
  seats,
  gameState,
  turnRemainingMs,
  quickEmotesByUser,
  activeInteractiveEmote,
  onFireInteractive,
  onStartGame,
  onMoveChess,
  onMoveCheckers,
}: BoardGameTableProps) {
  const phase = gameState?.phase ?? 'waiting';
  const pot = Number(gameState?.state?.pot ?? 0);
  const board = (gameState?.state?.board ?? null) as (string | null)[][] | null;
  const turnUserId = gameState?.turn_user_id ?? null;
  const isMyTurn = turnUserId === myUserId;
  const lastMove = gameState?.state?.last_move ?? null;
  const winnerId = (gameState?.state?.winner_id ?? null) as string | null;
  const winReason = (gameState?.state?.win_reason ?? null) as string | null;

  const whiteId = (gameState?.state?.white_id ?? null) as string | null;
  const redId = (gameState?.state?.red_id ?? null) as string | null;
  const blackId = (gameState?.state?.black_id ?? null) as string | null;

  const myColorCode =
    mode === 'chess'
      ? myUserId === whiteId
        ? 'w'
        : myUserId === blackId
          ? 'b'
          : null
      : myUserId === redId
        ? 'r'
        : myUserId === blackId
          ? 'b'
          : null;

  const [selectedSq, setSelectedSq] = useState<[number, number] | null>(null);
  const [promotionPiece, setPromotionPiece] = useState<'Q' | 'R' | 'B' | 'N'>('Q');
  const [busy, setBusy] = useState(false);
  const [tableErr, setTableErr] = useState<string | null>(null);

  const turnSec = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;
  const isUrgent = turnRemainingMs !== null && turnRemainingMs <= 4000;

  const activeTurnSeat = turnUserId ? seats.find((s) => s.user_id === turnUserId) ?? null : null;

  async function runAction(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setTableErr(null);
    try {
      await fn();
    } catch (e) {
      setTableErr(e instanceof Error ? e.message : 'Illegal board move.');
    } finally {
      setBusy(false);
    }
  }

  function isOwnPiece(piece: string | null): boolean {
    if (!piece || !myColorCode) return false;
    if (mode === 'chess') {
      return piece.startsWith(myColorCode);
    }
    return piece.toLowerCase() === myColorCode;
  }

  function handleSquareClick(r: number, c: number) {
    if (phase !== 'playing' || !isMyTurn || !board || busy) return;
    const clickedPiece = board[r]?.[c] ?? null;

    if (!selectedSq) {
      if (isOwnPiece(clickedPiece)) {
        setSelectedSq([r, c]);
        setTableErr(null);
      }
      return;
    }

    const [fromR, fromC] = selectedSq;
    if (fromR === r && fromC === c) {
      setSelectedSq(null);
      return;
    }

    if (isOwnPiece(clickedPiece)) {
      setSelectedSq([r, c]);
      setTableErr(null);
      return;
    }

    // Attempt move from selectedSq -> (r, c)
    setSelectedSq(null);
    if (mode === 'chess' && onMoveChess) {
      void runAction(() => onMoveChess(fromR, fromC, r, c, promotionPiece));
    } else if (mode === 'checkers' && onMoveCheckers) {
      void runAction(() => onMoveCheckers(fromR, fromC, r, c));
    }
  }

  return (
    <div className="bj-felt">
      {/* Top Status Bar */}
      <div className="bj-top-bar">
        <div className="bj-top-meta">
          <span className="badge badge--gold">
            {mode === 'chess' ? 'ROYAL CHESS' : 'GRAND CHECKERS'}
          </span>
          <span className="badge">STAKE {formatChips(minBet)}</span>
          {pot > 0 ? <span className="badge badge--gold">PRIZE POT {formatChips(pot)}</span> : null}
          {gameState?.state?.turn_number ? (
            <span className="badge">MOVE #{gameState.state.turn_number}</span>
          ) : null}
        </div>

        {turnUserId && turnSec !== null ? (
          <div className={`bj-clock${isUrgent ? ' bj-clock--urgent' : ''}`}>
            <span className="bj-clock__who">
              {isMyTurn ? 'YOUR MOVE' : `${activeTurnSeat?.username ?? 'Opponent'} thinking`}
            </span>
            <strong className="bj-clock__sec">{turnSec}s</strong>
          </div>
        ) : (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {phase === 'waiting'
              ? 'Requires 2 seated players to start match'
              : 'Match concluded'}
          </span>
        )}
      </div>

      {turnUserId && turnRemainingMs !== null ? (
        <div className="turn-bar" style={{ marginBottom: '0.9rem' }}>
          <div
            className={`turn-bar__fill${isUrgent ? ' turn-bar__fill--urgent' : ''}`}
            style={{ width: `${turnPct}%` }}
          />
        </div>
      ) : null}

      {/* Main 8x8 Board Layout */}
      <div className="board-arena-layout">
        <div className="board-frame">
          {board ? (
            <div className="board-grid-8x8">
              {board.map((row, rIdx) =>
                row.map((cell, cIdx) => {
                  const isDark = (rIdx + cIdx) % 2 === 1;
                  const isSelected =
                    selectedSq !== null && selectedSq[0] === rIdx && selectedSq[1] === cIdx;
                  const isLastMove =
                    lastMove !== null &&
                    ((lastMove.from[0] === rIdx && lastMove.from[1] === cIdx) ||
                      (lastMove.to[0] === rIdx && lastMove.to[1] === cIdx));

                  return (
                    <button
                      key={`${rIdx}-${cIdx}`}
                      type="button"
                      onClick={() => handleSquareClick(rIdx, cIdx)}
                      className={[
                        'board-sq',
                        isDark ? 'board-sq--dark' : 'board-sq--light',
                        isSelected ? 'board-sq--selected' : '',
                        isLastMove ? 'board-sq--lastmove' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {cIdx === 0 ? <span className="board-coord-rank">{8 - rIdx}</span> : null}
                      {rIdx === 7 ? (
                        <span className="board-coord-file">{FILES[cIdx]}</span>
                      ) : null}

                      {cell ? (
                        mode === 'chess' ? (
                          <ChessPieceSvg code={cell} size={42} />
                        ) : (
                          <CheckerDiscSvg code={cell} size={42} />
                        )
                      ) : null}
                    </button>
                  );
                }),
              )}
            </div>
          ) : (
            <div className="board-idle-placeholder">
              <strong style={{ color: 'var(--gold-light)', fontSize: '1.1rem' }}>
                {mode === 'chess' ? '8×8 Classical Chess Board' : '8×8 Draughts / Checkers Board'}
              </strong>
              <p className="muted" style={{ margin: '0.35rem 0 0', fontSize: '0.85rem' }}>
                Click &ldquo;Start Match&rdquo; below once 2 players are seated to lock stakes and initialize the board.
              </p>
            </div>
          )}
        </div>

        {/* Side Match Telemetry & Promotion Selector */}
        <div className="board-side-info">
          <div className="card" style={{ padding: '0.85rem' }}>
            <div className="bj-dealer-label" style={{ marginBottom: '0.45rem' }}>
              MATCH TELEMETRY
            </div>
            {mode === 'chess' ? (
              <div style={{ fontSize: '0.82rem', display: 'grid', gap: '0.35rem' }}>
                <div>
                  <span className="muted">Your Side: </span>
                  <strong>
                    {myColorCode === 'w'
                      ? 'White Pieces'
                      : myColorCode === 'b'
                        ? 'Black Pieces'
                        : 'Spectator'}
                  </strong>
                </div>
                <div>
                  <span className="muted">Pawn Promotion: </span>
                  <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.25rem' }}>
                    {(['Q', 'R', 'B', 'N'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`btn btn--sm ${promotionPiece === p ? 'btn--gold' : 'btn--ghost'}`}
                        onClick={() => setPromotionPiece(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.82rem', display: 'grid', gap: '0.35rem' }}>
                <div>
                  <span className="muted">Your Side: </span>
                  <strong>
                    {myColorCode === 'r'
                      ? 'Burgundy Red'
                      : myColorCode === 'b'
                        ? 'Obsidian Black'
                        : 'Spectator'}
                  </strong>
                </div>
                <div>
                  <span className="muted">Red Remaining: </span>
                  <strong>{String(gameState?.state?.red_left ?? 12)}</strong>
                </div>
                <div>
                  <span className="muted">Black Remaining: </span>
                  <strong>{String(gameState?.state?.black_left ?? 12)}</strong>
                </div>
              </div>
            )}

            {phase === 'settled' && winnerId ? (
              <div style={{ marginTop: '0.65rem' }}>
                <span className="badge badge--bj-win">
                  {winnerId === myUserId ? 'YOU WON' : 'MATCH SETTLED'} (
                  {winReason ?? 'victory'})
                </span>
              </div>
            ) : null}
          </div>

          {/* Seated Players List */}
          <div style={{ display: 'grid', gap: '0.65rem' }}>
            {seats.map((seat) => {
              const isMe = seat.user_id === myUserId;
              const isTurn = turnUserId === seat.user_id;
              const quickBubble = quickEmotesByUser[seat.user_id];
              const sideLabel =
                mode === 'chess'
                  ? seat.user_id === whiteId
                    ? 'WHITE'
                    : seat.user_id === blackId
                      ? 'BLACK'
                      : 'SEATED'
                  : seat.user_id === redId
                    ? 'RED'
                    : seat.user_id === blackId
                      ? 'BLACK'
                      : 'SEATED';

              const incomingHit =
                activeInteractiveEmote && activeInteractiveEmote.target_id === seat.user_id
                  ? activeInteractiveEmote
                  : null;

              return (
                <div
                  key={seat.user_id}
                  className={[
                    'bj-seat-box',
                    isTurn ? 'bj-seat-box--turn' : '',
                    isMe ? 'bj-seat-box--me' : '',
                    seat.status === 'afk' ? 'seat-card--afk' : '',
                    incomingHit ? 'seat-card--hit' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {quickBubble ? (
                    <div className="quick-emote-bubble" key={quickBubble.id}>
                      <span className="quick-emote-bubble__sym">{quickBubble.symbol}</span>
                      <span>{quickBubble.phrase}</span>
                    </div>
                  ) : null}

                  {incomingHit ? (
                    <div className="seat-hit-overlay" key={incomingHit.id} role="status">
                      <EmoteVectorIcon animation={incomingHit.animation} size={44} />
                      <span className="emote-stage__impact">
                        {EMOTE_SPECS[incomingHit.animation]?.impactWord ?? 'HIT!'}
                      </span>
                    </div>
                  ) : null}

                  <div className="bj-seat-footer">
                    <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={42} />
                    <div className="bj-seat-identity">
                      <div className="bj-seat-name">
                        #{seat.seat + 1} {seat.username}
                        {isMe ? <span className="seat-card__you">YOU</span> : null}
                      </div>
                      <div className="bj-seat-sub">
                        <span className="badge badge--gold" style={{ marginRight: '0.35rem' }}>
                          {sideLabel}
                        </span>
                        {isTurn ? (
                          <span style={{ color: 'var(--gold-light)' }}>Moving...</span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {!isMe ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm seat-target-btn"
                      onClick={() => void onFireInteractive(seat.user_id)}
                      title="Launch selected interactive emote at this player"
                    >
                      🎯 Target Emote
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom Controls Bar */}
      <div className="bj-controls-bar">
        {tableErr ? (
          <div className="alert alert--error" style={{ marginBottom: '0.65rem' }}>
            {tableErr}
          </div>
        ) : null}

        {phase === 'waiting' || phase === 'settled' || phase === 'lobby' ? (
          <div className="bj-controls-Idle">
            <div>
              <strong style={{ color: 'var(--gold-light)' }}>
                {phase === 'settled'
                  ? 'Match Finished — Ready for Rematch'
                  : `Ready to Start ${mode === 'chess' ? 'Chess' : 'Checkers'} Match`}
              </strong>
              <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.82rem' }}>
                Both players stake {formatChips(minBet)} chips ({formatChips(minBet * 2)} pot). Winner takes all; 15s timeout forfeits the match.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--gold"
              disabled={busy}
              onClick={() => runAction(onStartGame)}
            >
              {busy ? 'Starting...' : phase === 'settled' ? 'Start Rematch' : 'Start Match'}
            </button>
          </div>
        ) : (
          <div className="bj-controls-Idle">
            <div>
              <strong style={{ color: 'var(--gold-light)' }}>
                {isMyTurn
                  ? selectedSq
                    ? `Selected square ${FILES[selectedSq[1]]}${8 - selectedSq[0]} — click destination square`
                    : 'Your Turn — Click one of your pieces to select it'
                  : `Waiting for ${activeTurnSeat?.username ?? 'opponent'} to make a move`}
              </strong>
            </div>
            {selectedSq ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setSelectedSq(null)}
              >
                Clear Selection
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
