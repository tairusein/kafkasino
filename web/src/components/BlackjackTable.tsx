import { useEffect, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  BlackjackHandState,
  GameStateRow,
  InteractiveEmoteEvent,
  QuickEmoteEvent,
  Room,
  RoomSeatWithProfile,
  ShopItem,
} from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';
import { CasinoChipSvg, PlayingCardSvg } from './PlayingCardSvg';

const CHIP_DENOMINATIONS = [50, 100, 250, 500, 1000, 5000] as const;

interface BlackjackTableProps {
  room: Room;
  seats: RoomSeatWithProfile[];
  currentUserId: string | null;
  gameState: GameStateRow | null;
  cardBackMap: Map<string, ShopItem>;
  quickEmotesByUser: Record<string, QuickEmoteEvent>;
  activeInteractiveEmote: InteractiveEmoteEvent | null;
  turnRemainingMs: number | null;
  actionBusy: boolean;
  onStartRound: () => Promise<void>;
  onPlaceBet: (amount: number) => Promise<void>;
  onAction: (action: 'hit' | 'stand' | 'double') => Promise<void>;
  onFireInteractive: (targetUserId: string) => Promise<void>;
}

function formatHandTotal(total: number, isSoft: boolean, isBlackjack: boolean, isBust: boolean): string {
  if (isBlackjack) return '21 · BLACKJACK';
  if (isBust) return `${total} · BUST`;
  if (isSoft && total <= 21) return `Soft ${total}`;
  return String(total);
}

function outcomeBadgeMeta(hand: BlackjackHandState): { label: string; className: string } | null {
  switch (hand.outcome) {
    case 'blackjack':
      return {
        label: `BLACKJACK 3:2 (+${formatChips(hand.net)})`,
        className: 'badge badge--bj-win',
      };
    case 'win':
      return {
        label: `WIN (+${formatChips(hand.net)})`,
        className: 'badge badge--bj-win',
      };
    case 'push':
      return {
        label: `PUSH (Refunded ${formatChips(hand.payout)})`,
        className: 'badge badge--bj-push',
      };
    case 'bust':
      return {
        label: `BUST (-${formatChips(hand.bet)})`,
        className: 'badge badge--timeout',
      };
    case 'lose':
      return {
        label: `DEALER WINS (-${formatChips(hand.bet)})`,
        className: 'badge badge--timeout',
      };
    default:
      return null;
  }
}

export function BlackjackTable({
  room,
  seats,
  currentUserId,
  gameState,
  cardBackMap,
  quickEmotesByUser,
  activeInteractiveEmote,
  turnRemainingMs,
  actionBusy,
  onStartRound,
  onPlaceBet,
  onAction,
  onFireInteractive,
}: BlackjackTableProps) {
  const { balance } = useWallet();
  const { sound } = useSound();

  const tableMinBet = Math.max(room.min_bet || 0, 50);
  const [wager, setWager] = useState<number>(tableMinBet);

  useEffect(() => {
    setWager((prev) => (prev < tableMinBet ? tableMinBet : prev));
  }, [tableMinBet]);

  const phase = gameState?.phase ?? 'lobby';
  const roundNumber = gameState?.state?.round_number ?? 0;
  const shoeRemaining = gameState?.state?.shoe_remaining ?? 312;
  const dealer = gameState?.state?.dealer;
  const handsMap = gameState?.state?.hands ?? {};
  const myHand: BlackjackHandState | undefined = currentUserId ? handsMap[currentUserId] : undefined;
  const lastAction = gameState?.state?.last_action;

  const isMyTurn = Boolean(currentUserId && gameState?.turn_user_id === currentUserId);
  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;
  const turnSeconds = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;

  // Determine whether the current user can place a bet right now:
  // Either a round hasn't started yet ('lobby', 'settled', 'awaiting_players')
  // OR we are in 'betting' and the user hasn't placed their bet yet.
  const canPlaceBet =
    Boolean(currentUserId) &&
    (phase === 'lobby' ||
      phase === 'settled' ||
      phase === 'awaiting_players' ||
      (phase === 'betting' && (!myHand || myHand.status === 'betting' || myHand.status === 'skipped_afk')));

  const canActInPlay =
    phase === 'playing' && isMyTurn && myHand !== undefined && myHand.status === 'playing';

  const canDoubleDown =
    canActInPlay &&
    myHand.cards.length === 2 &&
    (balance === null || balance >= myHand.bet);

  const insufficientForWager = balance !== null && wager > balance;

  function addChipToWager(chipVal: number) {
    sound.play('chipClick');
    setWager((prev) => {
      const next = prev + chipVal;
      if (balance !== null && next > balance) {
        return Math.max(tableMinBet, balance);
      }
      return Math.min(1000000, next);
    });
  }

  return (
    <section className="table-felt bj-felt" aria-label="Blackjack table">
      {/* 1. Dealer Station & 6-Deck Shoe */}
      <div className="bj-dealer-zone">
        <div className="bj-dealer-head">
          <div className="row">
            <span className="eyebrow">House Dealer · Stands on All 17s</span>
            {dealer && dealer.cards.length > 0 && (
              <span
                className={`badge tabular ${
                  dealer.is_bust
                    ? 'badge--timeout'
                    : dealer.is_blackjack
                      ? 'badge--bj-win'
                      : 'badge--open'
                }`}
              >
                {dealer.hole_hidden
                  ? `${dealer.total} + Hidden`
                  : formatHandTotal(dealer.total, dealer.is_soft, dealer.is_blackjack, dealer.is_bust)}
              </span>
            )}
          </div>

          <div className="bj-shoe-pill" title="Authoritative 6-deck server shoe (stored in game_server_secrets)">
            <svg viewBox="0 0 28 20" width="22" height="16" aria-hidden="true">
              <rect x="2" y="3" width="24" height="14" rx="2" fill="#23262e" stroke="#c9a24b" strokeWidth="1.4" />
              <line x1="7" y1="3" x2="7" y2="17" stroke="#c9a24b" strokeWidth="1" />
              <line x1="12" y1="3" x2="12" y2="17" stroke="#c9a24b" strokeWidth="1" />
            </svg>
            <span className="muted small tabular">Shoe: {shoeRemaining} / 312</span>
          </div>
        </div>

        <div className="bj-cards-row bj-cards-row--dealer">
          {dealer && dealer.cards.length > 0 ? (
            <>
              {dealer.cards.map((c, idx) => (
                <PlayingCardSvg
                  key={`dealer-${idx}-${c.rank}-${c.suit}`}
                  card={c}
                  width={84}
                  height={118}
                  className="bj-card-anim"
                />
              ))}
              {dealer.hole_hidden && (
                <PlayingCardSvg
                  key="dealer-hole-hidden"
                  hidden
                  cardBackUrl={DEFAULT_CARD_BACK_URL}
                  width={84}
                  height={118}
                  className="bj-card-anim"
                />
              )}
            </>
          ) : (
            <div className="bj-empty-cards">
              <PlayingCardSvg hidden cardBackUrl={DEFAULT_CARD_BACK_URL} width={76} height={106} />
              <PlayingCardSvg hidden cardBackUrl={DEFAULT_CARD_BACK_URL} width={76} height={106} />
              <span className="muted small">Place your wager below to deal the next hand.</span>
            </div>
          )}
        </div>
      </div>

      {/* 2. Center Felt Ribbon, 15s Turn Clock & Round Banner */}
      <div className="table-felt__center bj-center-ribbon">
        <div className="bj-rules-arch">
          BLACKJACK PAYS 3 TO 2 · DEALER MUST STAND ON ALL 17 · 6-DECK SHOE
        </div>

        <div className="row row--center">
          <span className="badge">
            {phase === 'lobby'
              ? 'Table Ready'
              : phase === 'betting'
                ? `Hand #${roundNumber} · Betting Open`
                : phase === 'playing'
                  ? `Hand #${roundNumber} · In Play`
                  : `Hand #${roundNumber} · Settled`}
          </span>

          {lastAction && (
            <span className="last-action-pill">
              <span className="muted small">Last:</span>{' '}
              <strong>{lastAction.type.toUpperCase()}</strong>
              {lastAction.forced_by_timeout && (
                <span className="badge badge--timeout">15s Timeout → AFK</span>
              )}
            </span>
          )}
        </div>

        {/* 15-Second Active Turn Spotlight */}
        {turnPlayer && turnSeconds !== null && (
          <div className="turn-spotlight">
            <div className="turn-spotlight__title">
              {isMyTurn ? (
                <span className="gold-text">
                  {phase === 'betting' ? 'Your Turn to Place Bet' : 'Your Turn to Act (Hit / Stand / Double)'}
                </span>
              ) : (
                <span>
                  {phase === 'betting'
                    ? `Awaiting ${turnPlayer.username}'s Bet`
                    : `${turnPlayer.username} is Acting`}
                </span>
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

        {/* Personal Hand Outcome Banner on Settlement */}
        {phase === 'settled' && myHand && myHand.bet > 0 && (
          <div
            className={`bj-outcome-banner bj-outcome-banner--${myHand.outcome ?? 'push'}`}
            role="status"
          >
            {myHand.outcome === 'blackjack' && (
              <>
                <strong>NATURAL BLACKJACK!</strong>
                <span>
                  Paid 3:2 — Returned {formatChips(myHand.payout)} Chips (+{formatChips(myHand.net)} net profit)
                </span>
              </>
            )}
            {myHand.outcome === 'win' && (
              <>
                <strong>HAND WON!</strong>
                <span>
                  Returned {formatChips(myHand.payout)} Chips (+{formatChips(myHand.net)} net profit)
                </span>
              </>
            )}
            {myHand.outcome === 'push' && (
              <>
                <strong>PUSH — STANDOFF</strong>
                <span>Your {formatChips(myHand.payout)} chip wager has been refunded to your balance.</span>
              </>
            )}
            {myHand.outcome === 'bust' && (
              <>
                <strong>HAND BUSTED ({myHand.total})</strong>
                <span>Wager of {formatChips(myHand.bet)} chips lost to the House.</span>
              </>
            )}
            {myHand.outcome === 'lose' && (
              <>
                <strong>DEALER WINS ({dealer?.total ?? 0} vs {myHand.total})</strong>
                <span>Wager of {formatChips(myHand.bet)} chips lost to the House.</span>
              </>
            )}
          </div>
        )}

        {/* 3. Betting Tray OR In-Hand Action Bar */}
        {canPlaceBet && (
          <div className="bj-betting-console">
            <div className="bj-chip-rack" role="group" aria-label="Select casino chips to add to wager">
              {CHIP_DENOMINATIONS.map((val) => (
                <button
                  key={val}
                  type="button"
                  className="bj-chip-btn"
                  onClick={() => addChipToWager(val)}
                  disabled={actionBusy || (balance !== null && balance < val)}
                  title={`Add ${formatChips(val)} chips to wager`}
                  data-silent
                >
                  <CasinoChipSvg value={val} size={46} />
                </button>
              ))}
            </div>

            <div className="bj-wager-bar">
              <div className="bj-wager-display">
                <span className="muted small">Your Wager (Min {formatChips(tableMinBet)})</span>
                <strong className="bj-wager-display__amount tabular">{formatChips(wager)} Chips</strong>
              </div>

              <div className="row">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    sound.play('chipClick');
                    setWager(tableMinBet);
                  }}
                  disabled={actionBusy || wager === tableMinBet}
                  data-silent
                >
                  Min ({formatChips(tableMinBet)})
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    sound.play('chipClick');
                    setWager((prev) => {
                      const doubled = prev * 2;
                      return balance !== null ? Math.min(balance, doubled) : Math.min(1000000, doubled);
                    });
                  }}
                  disabled={actionBusy || (balance !== null && wager * 2 > balance)}
                  data-silent
                >
                  2× Wager
                </button>
                <button
                  type="button"
                  className="btn btn--gold"
                  onClick={() => void onPlaceBet(wager)}
                  disabled={actionBusy || insufficientForWager || wager < tableMinBet}
                >
                  {actionBusy
                    ? 'Dealing…'
                    : phase === 'betting'
                      ? `Confirm Bet · ${formatChips(wager)} Chips`
                      : `Deal Hand · Bet ${formatChips(wager)} Chips`}
                </button>
                {seats.length > 1 && (phase === 'lobby' || phase === 'settled') && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void onStartRound()}
                    disabled={actionBusy}
                    title="Start a 15-second betting timer for all seated players"
                  >
                    Open Table Betting (15s)
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {canActInPlay && (
          <div className="bj-action-bar" role="group" aria-label="Blackjack hand actions">
            <button
              type="button"
              className="btn btn--gold bj-action-btn"
              onClick={() => void onAction('hit')}
              disabled={actionBusy}
            >
              Hit (Draw Card)
            </button>
            <button
              type="button"
              className="btn btn--ghost bj-action-btn"
              onClick={() => void onAction('stand')}
              disabled={actionBusy}
            >
              Stand (Hold {myHand.total})
            </button>
            <button
              type="button"
              className="btn btn--gold bj-action-btn"
              onClick={() => void onAction('double')}
              disabled={actionBusy || !canDoubleDown}
              title={
                canDoubleDown
                  ? `Double wager to ${formatChips(myHand.bet * 2)} and draw 1 final card`
                  : 'Double Down requires exactly 2 cards and sufficient chip balance'
              }
            >
              Double Down (+{formatChips(myHand.bet)})
            </button>
          </div>
        )}
      </div>

      {/* 4. Seated Players Arc */}
      <div className="seats-grid">
        {seats.map((seat) => {
          const isTurn = gameState?.turn_user_id === seat.user_id;
          const isMe = currentUserId === seat.user_id;
          const seatHand = handsMap[seat.user_id];
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
          const outcomeMeta = seatHand ? outcomeBadgeMeta(seatHand) : null;

          return (
            <div
              key={seat.user_id}
              className={`seat-card bj-seat-card${isTurn ? ' seat-card--turn' : ''}${
                seat.status === 'afk' ? ' seat-card--afk' : ''
              }${incomingHit ? ' seat-card--hit' : ''}${outgoingCast ? ' seat-card--casting' : ''}`}
            >
              {/* Quick-Emote Floating Speech Bubble */}
              {quickBubble && (
                <div key={quickBubble.id} className="quick-emote-bubble" role="status">
                  <span className="quick-emote-bubble__sym">{quickBubble.symbol}</span>
                  <span>{quickBubble.phrase}</span>
                </div>
              )}

              {/* Incoming Targeted Interactive Emote Overlay */}
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
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={48} />
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
                  width={26}
                  height={38}
                  draggable={false}
                />
              </div>

              {/* Player's Blackjack Hand Cards & Wager */}
              {seatHand && seatHand.bet > 0 ? (
                <div className="bj-seat-hand">
                  <div className="bj-seat-hand__meta">
                    <span className="badge tabular">Bet: {formatChips(seatHand.bet)}</span>
                    {seatHand.cards.length > 0 && (
                      <span
                        className={`badge tabular ${
                          seatHand.status === 'bust'
                            ? 'badge--timeout'
                            : seatHand.is_blackjack
                              ? 'badge--bj-win'
                              : 'badge--open'
                        }`}
                      >
                        {formatHandTotal(
                          seatHand.total,
                          seatHand.is_soft,
                          seatHand.is_blackjack,
                          seatHand.status === 'bust',
                        )}
                      </span>
                    )}
                    {seatHand.status === 'stood' && phase === 'playing' && (
                      <span className="badge">Stood</span>
                    )}
                    {seatHand.status === 'doubled' && phase === 'playing' && (
                      <span className="badge badge--open">2× Doubled</span>
                    )}
                  </div>

                  {seatHand.cards.length > 0 && (
                    <div className="bj-cards-row bj-cards-row--seat">
                      {seatHand.cards.map((c, idx) => (
                        <PlayingCardSvg
                          key={`${seat.user_id}-c-${idx}-${c.rank}-${c.suit}`}
                          card={c}
                          cardBackUrl={cardBackUrl}
                          width={68}
                          height={96}
                          className="bj-card-anim"
                        />
                      ))}
                    </div>
                  )}

                  {outcomeMeta && (
                    <div className="bj-seat-outcome">
                      <span className={outcomeMeta.className}>{outcomeMeta.label}</span>
                    </div>
                  )}
                </div>
              ) : seatHand?.status === 'betting' ? (
                <p className="muted small bj-seat-waiting">Selecting wager…</p>
              ) : seatHand?.status === 'skipped_afk' ? (
                <p className="muted small bj-seat-waiting">Skipped (15s Timeout → AFK)</p>
              ) : null}

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
                  title="Launch selected interactive emote at this player"
                >
                  🎯 Target with Emote
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

