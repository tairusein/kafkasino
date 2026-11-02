import { useEffect, useState } from 'react';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  GameStateRow,
  InteractiveEmoteEvent,
  PlayingCard,
  PokerPlayerState,
  QuickEmoteEvent,
  RoomSeatWithProfile,
  ShopItem,
} from '../lib/types';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';
import { CasinoChipSvg, PlayingCardSvg } from './PlayingCardSvg';

const CHIP_DENOMS = [50, 100, 500, 1000, 5000] as const;

interface PokerTableProps {
  myUserId: string;
  minBet: number;
  walletBalance: number | null;
  seats: RoomSeatWithProfile[];
  gameState: GameStateRow | null;
  privateState: Record<string, unknown>;
  cardBackMap: Map<string, ShopItem>;
  turnRemainingMs: number | null;
  quickEmotesByUser: Record<string, QuickEmoteEvent>;
  activeInteractiveEmote: InteractiveEmoteEvent | null;
  onFireInteractive: (targetUserId: string) => Promise<void>;
  onStartHand: () => Promise<void>;
  onAction: (action: 'fold' | 'check' | 'call' | 'raise', amount?: number) => Promise<void>;
}

export function PokerTable({
  myUserId,
  minBet,
  walletBalance,
  seats,
  gameState,
  privateState,
  cardBackMap,
  turnRemainingMs,
  quickEmotesByUser,
  activeInteractiveEmote,
  onFireInteractive,
  onStartHand,
  onAction,
}: PokerTableProps) {
  const phase = gameState?.phase ?? 'waiting';
  const street = gameState?.state?.street ?? 'preflop';
  const pot = Number(gameState?.state?.pot ?? 0);
  const currentBet = Number(gameState?.state?.current_bet ?? 0);
  const minRaise = Number(gameState?.state?.min_raise ?? minBet);
  const smallBlind = Number(gameState?.state?.small_blind ?? Math.max(10, Math.floor(minBet / 2)));
  const bigBlind = Number(gameState?.state?.big_blind ?? minBet);
  const communityCards = (gameState?.state?.community_cards ?? []) as PlayingCard[];
  const playersMap = (gameState?.state?.players ?? {}) as Record<string, PokerPlayerState>;
  const turnUserId = gameState?.turn_user_id ?? null;
  const isMyTurn = turnUserId === myUserId;

  const myPlayer = playersMap[myUserId] ?? null;
  const myHoleCards = Array.isArray(privateState.hole_cards)
    ? (privateState.hole_cards as PlayingCard[])
    : [];

  const toCall = myPlayer ? Math.max(0, currentBet - Number(myPlayer.street_bet ?? 0)) : 0;
  const minRaiseTarget = Math.max(currentBet + minRaise, bigBlind * 2);

  const [raiseTo, setRaiseTo] = useState<number>(minRaiseTarget);
  const [busy, setBusy] = useState(false);
  const [tableErr, setTableErr] = useState<string | null>(null);

  useEffect(() => {
    setRaiseTo((prev) => Math.max(minRaiseTarget, prev));
  }, [minRaiseTarget, gameState?.version]);

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
      setTableErr(e instanceof Error ? e.message : 'Poker action failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bj-felt">
      {/* Top Status & Street Ribbon */}
      <div className="bj-top-bar">
        <div className="bj-top-meta">
          <span className="badge badge--gold">TEXAS HOLD&apos;EM</span>
          <span className="badge">
            BLINDS {formatChips(smallBlind)} / {formatChips(bigBlind)}
          </span>
          {gameState?.state?.round_number ? (
            <span className="badge">HAND #{gameState.state.round_number}</span>
          ) : null}
          <span className="badge">STREET: {street.toUpperCase()}</span>
        </div>

        {turnUserId && turnSec !== null ? (
          <div className={`bj-clock${isUrgent ? ' bj-clock--urgent' : ''}`}>
            <span className="bj-clock__who">
              {isMyTurn ? 'YOUR ACTION' : `${activeTurnSeat?.username ?? 'Player'} acting`}
            </span>
            <strong className="bj-clock__sec">{turnSec}s</strong>
          </div>
        ) : (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {phase === 'waiting'
              ? 'Requires 2+ active players to deal Texas Hold’em'
              : 'Showdown settled — ready for next hand'}
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

      {/* Center Community Cards & Pot */}
      <div className="bj-dealer-zone">
        <div className="bj-dealer-header">
          <span className="bj-dealer-label">COMMUNITY BOARD &amp; POT</span>
          <span className="bj-hand-total bj-hand-total--bj">POT: {formatChips(pot)} CHIPS</span>
        </div>

        <div className="poker-community-row">
          {[0, 1, 2, 3, 4].map((slotIdx) => {
            const card = communityCards[slotIdx];
            return card ? (
              <div key={slotIdx} className="bj-card-slot">
                <PlayingCardSvg card={card} width={78} height={110} />
              </div>
            ) : (
              <div key={slotIdx} className="poker-community-placeholder">
                <span>{slotIdx < 3 ? 'FLOP' : slotIdx === 3 ? 'TURN' : 'RIVER'}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bj-felt-arch">
        <span>NO-LIMIT HOLD&apos;EM &bull; BEST 5 OF 7 CARDS &bull; 15S SHOT CLOCK</span>
      </div>

      {/* Player Seats Grid */}
      <div className="bj-seats-grid">
        {seats.map((seat) => {
          const isMe = seat.user_id === myUserId;
          const isTurn = turnUserId === seat.user_id;
          const pState = playersMap[seat.user_id];
          const quickBubble = quickEmotesByUser[seat.user_id];
          const equippedBack = seat.equipped_card_back
            ? cardBackMap.get(seat.equipped_card_back)
            : null;
          const cardBackUrl = equippedBack
            ? resolveCardBackUrl(equippedBack)
            : DEFAULT_CARD_BACK_URL;

          const incomingHit =
            activeInteractiveEmote && activeInteractiveEmote.target_id === seat.user_id
              ? activeInteractiveEmote
              : null;

          // Determine which hole cards to render:
          // - At showdown, revealed_cards from public state if present
          // - For signed-in user during active hand, myHoleCards from game_private_states
          const faceUpCards: PlayingCard[] =
            pState?.revealed_cards && pState.revealed_cards.length > 0
              ? pState.revealed_cards
              : isMe
                ? myHoleCards
                : [];

          const showFaceDownHole =
            !isMe &&
            pState &&
            pState.status === 'active' &&
            (!pState.revealed_cards || pState.revealed_cards.length === 0) &&
            phase === 'playing';

          return (
            <div
              key={seat.user_id}
              className={[
                'bj-seat-box',
                isTurn ? 'bj-seat-box--turn' : '',
                isMe ? 'bj-seat-box--me' : '',
                seat.status === 'afk' || pState?.status === 'folded' ? 'seat-card--afk' : '',
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

              {/* Dealer / SB / BB Badges */}
              {pState ? (
                <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                  {pState.is_dealer ? <span className="badge badge--gold">DEALER (D)</span> : null}
                  {pState.is_sb ? <span className="badge">SB</span> : null}
                  {pState.is_bb ? <span className="badge">BB</span> : null}
                  {pState.status === 'folded' ? (
                    <span className="badge badge--timeout">FOLDED</span>
                  ) : null}
                </div>
              ) : null}

              {/* Hole Cards Area */}
              <div className="bj-seat-cards">
                {faceUpCards.length > 0 ? (
                  <div className="bj-cards-fan">
                    {faceUpCards.map((c, idx) => (
                      <div key={idx} className="bj-card-slot">
                        <PlayingCardSvg
                          card={c}
                          cardBackUrl={cardBackUrl}
                          width={70}
                          height={98}
                        />
                      </div>
                    ))}
                  </div>
                ) : showFaceDownHole ? (
                  <div className="bj-cards-fan">
                    <div className="bj-card-slot">
                      <PlayingCardSvg
                        hidden
                        cardBackUrl={cardBackUrl}
                        width={68}
                        height={96}
                      />
                    </div>
                    <div className="bj-card-slot">
                      <PlayingCardSvg
                        hidden
                        cardBackUrl={cardBackUrl}
                        width={68}
                        height={96}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="bj-seat-cardback-idle" title={equippedBack?.name ?? 'Card Back'}>
                    <PlayingCardSvg
                      hidden
                      cardBackUrl={cardBackUrl}
                      width={46}
                      height={64}
                    />
                  </div>
                )}
              </div>

              {/* Hand rank & outcome pill */}
              {pState ? (
                <div className="bj-seat-meta-row">
                  {pState.total_bet > 0 ? (
                    <span className="bj-bet-pill">In Pot: {formatChips(pState.total_bet)}</span>
                  ) : null}
                  {pState.hand_label ? (
                    <span className="bj-hand-total bj-hand-total--bj">{pState.hand_label}</span>
                  ) : null}
                  {phase === 'settled' && pState.is_winner ? (
                    <span className="badge badge--bj-win">
                      WINNER (+{formatChips(pState.payout)})
                    </span>
                  ) : null}
                </div>
              ) : null}

              {/* Player Footer */}
              <div className="bj-seat-footer">
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={42} />
                <div className="bj-seat-identity">
                  <div className="bj-seat-name">
                    #{seat.seat + 1} {seat.username}
                    {isMe ? <span className="seat-card__you">YOU</span> : null}
                  </div>
                  <div className="bj-seat-sub">
                    {seat.status === 'afk' ? (
                      <span style={{ color: '#f29ca8' }}>AFK</span>
                    ) : isTurn ? (
                      <span style={{ color: 'var(--gold-light)' }}>Acting now...</span>
                    ) : pState ? (
                      <span>Street bet: {formatChips(pState.street_bet)}</span>
                    ) : (
                      <span>Seated</span>
                    )}
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

      {/* Action Controls Bar */}
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
                {phase === 'settled' ? 'Hand Complete' : 'Ready to Deal Texas Hold’em'}
              </strong>
              <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.82rem' }}>
                Posts Small Blind ({formatChips(smallBlind)}) &amp; Big Blind ({formatChips(bigBlind)}) and deals 2 private hole cards to each player.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--gold"
              disabled={busy}
              onClick={() => runAction(onStartHand)}
            >
              {busy ? 'Dealing...' : phase === 'settled' ? 'Deal Next Hand' : 'Deal Hold’em Hand'}
            </button>
          </div>
        ) : null}

        {phase === 'playing' ? (
          <div className="bj-controls-betting">
            <div className="bj-chip-rack">
              {CHIP_DENOMS.map((denom) => (
                <button
                  key={denom}
                  type="button"
                  className="bj-chip-btn"
                  disabled={!isMyTurn || busy}
                  onClick={() => setRaiseTo((prev) => Math.max(minRaiseTarget, prev + denom))}
                  title={`Increase raise by ${denom}`}
                >
                  <CasinoChipSvg value={denom} size={46} />
                </button>
              ))}
            </div>

            <div className="bj-bet-submit-group">
              <div className="bj-wager-readout">
                <span className="bj-wager-readout__label">RAISE TO</span>
                <strong className="bj-wager-readout__val">{formatChips(raiseTo)}</strong>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!isMyTurn || busy}
                onClick={() => setRaiseTo(minRaiseTarget)}
              >
                Min ({formatChips(minRaiseTarget)})
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!isMyTurn || busy}
                onClick={() => runAction(() => onAction('fold'))}
              >
                Fold
              </button>
              {toCall === 0 ? (
                <button
                  type="button"
                  className="btn"
                  disabled={!isMyTurn || busy}
                  onClick={() => runAction(() => onAction('check'))}
                >
                  Check
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={
                    !isMyTurn ||
                    busy ||
                    (walletBalance !== null && walletBalance < toCall)
                  }
                  onClick={() => runAction(() => onAction('call'))}
                >
                  Call {formatChips(toCall)}
                </button>
              )}
              <button
                type="button"
                className="btn btn--gold"
                disabled={
                  !isMyTurn ||
                  busy ||
                  (walletBalance !== null &&
                    myPlayer &&
                    walletBalance < raiseTo - Number(myPlayer.street_bet ?? 0))
                }
                onClick={() => runAction(() => onAction('raise', raiseTo))}
              >
                Raise to {formatChips(raiseTo)}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
