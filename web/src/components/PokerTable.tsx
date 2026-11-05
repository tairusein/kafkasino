import { useEffect, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  Card,
  GameStateRow,
  InteractiveEmoteEvent,
  PokerSeatState,
  QuickEmoteEvent,
  Room,
  RoomSeatWithProfile,
  ShopItem,
} from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';
import { CasinoChipSvg, PlayingCardSvg } from './PlayingCardSvg';

const RAISE_CHIPS = [50, 100, 250, 500, 1000] as const;

interface PokerTableProps {
  room: Room;
  seats: RoomSeatWithProfile[];
  currentUserId: string | null;
  gameState: GameStateRow | null;
  myPrivateCards: Card[];
  cardBackMap: Map<string, ShopItem>;
  quickEmotesByUser: Record<string, QuickEmoteEvent>;
  activeInteractiveEmote: InteractiveEmoteEvent | null;
  turnRemainingMs: number | null;
  actionBusy: boolean;
  onStartHand: () => Promise<void>;
  onAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'all_in', raiseTo?: number) => Promise<void>;
  onFireInteractive: (targetUserId: string) => Promise<void>;
}

export function PokerTable({
  room,
  seats,
  currentUserId,
  gameState,
  myPrivateCards,
  cardBackMap,
  quickEmotesByUser,
  activeInteractiveEmote,
  turnRemainingMs,
  actionBusy,
  onStartHand,
  onAction,
  onFireInteractive,
}: PokerTableProps) {
  const { balance } = useWallet();
  const { sound } = useSound();
  const { t } = useI18n();

  const phase = gameState?.phase ?? 'lobby';
  const street = (gameState?.state?.street ?? phase) as string;
  const roundNumber = gameState?.state?.round_number ?? 0;
  const pot = gameState?.state?.pot ?? 0;
  const currentHighBet = gameState?.state?.current_high_bet ?? 0;
  const minRaise = gameState?.state?.min_raise ?? Math.max(room.min_bet || 100, 50);
  const smallBlind = gameState?.state?.small_blind ?? Math.max(Math.floor((room.min_bet || 100) / 2), 25);
  const bigBlind = gameState?.state?.big_blind ?? Math.max(room.min_bet || 100, 50);
  const dealerSeat = gameState?.state?.dealer_seat ?? null;
  const sbSeat = gameState?.state?.sb_seat ?? null;
  const bbSeat = gameState?.state?.bb_seat ?? null;
  const communityCards = (gameState?.state?.community_cards ?? []) as Card[];
  const pokerPlayers = (gameState?.state?.players ?? {}) as Record<string, PokerSeatState>;
  const revealedHands = (gameState?.state?.revealed_hands ?? {}) as Record<string, Card[]>;
  const lastAction = gameState?.state?.last_action;

  const myPokerState = currentUserId ? pokerPlayers[currentUserId] : undefined;
  const myStreetBet = myPokerState?.street_bet ?? 0;
  const callDiff = Math.max(0, currentHighBet - myStreetBet);
  const minRaiseTo = currentHighBet + Math.max(minRaise, bigBlind);

  const [raiseToAmount, setRaiseToAmount] = useState<number>(minRaiseTo);

  useEffect(() => {
    setRaiseToAmount((prev) => (prev < minRaiseTo ? minRaiseTo : prev));
  }, [minRaiseTo]);

  const isMyTurn = Boolean(currentUserId && gameState?.turn_user_id === currentUserId);
  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;
  const turnSeconds = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;

  const canStartHand =
    seats.length >= 2 && (phase === 'lobby' || phase === 'settled' || phase === 'awaiting_players');

  const canAct =
    phase === 'playing' &&
    isMyTurn &&
    myPokerState !== undefined &&
    myPokerState.status === 'active';

  function addRaiseChip(val: number) {
    sound.play('chipClick');
    setRaiseToAmount((prev) => {
      const base = Math.max(prev, minRaiseTo);
      const next = base + val;
      if (balance !== null) {
        const maxPossible = myStreetBet + balance;
        return Math.min(next, Math.max(minRaiseTo, maxPossible));
      }
      return next;
    });
  }

  return (
    <section className="table-felt casino-oval-felt poker-felt" aria-label="Texas Hold'em Poker table">
      {/* Top Info Bar: Blinds, Street & Pot */}
      <div className="rl-top-bar poker-top-bar">
        <div>
          <span className="eyebrow">
            {t('poker.eyebrow')} · {t('poker.blinds')} {formatChips(smallBlind)} / {formatChips(bigBlind)}
          </span>
          <div className="muted small">
            {roundNumber > 0
              ? `${t('room.hand')} #${roundNumber} · ${street.toUpperCase()}`
              : t('poker.waitingPlayers')}
          </div>
        </div>

        <div className="row">
          <div className="room-minbet-box poker-pot-box">
            <CasinoChipSvg value={500} size={28} />
            <div>
              <span className="muted small">{t('poker.pot')}</span>
              <strong className="gold-text tabular" style={{ display: 'block', fontSize: '1.1rem' }}>
                {formatChips(pot)} {t('room.chips')}
              </strong>
            </div>
          </div>
          {currentHighBet > 0 && phase === 'playing' && (
            <div className="room-minbet-box">
              <span className="muted small">{t('poker.highBet')}</span>
              <strong className="tabular">{formatChips(currentHighBet)}</strong>
            </div>
          )}
        </div>
      </div>

      {/* Community Cards Track + Pot + Action Console */}
      <div className="table-felt__center bj-center-ribbon poker-board-center">
        <div className="bj-rules-arch">
          TEXAS HOLD&apos;EM · NO-LIMIT · DEALER BUTTON ROTATES CLOCKWISE
        </div>

        {/* 5 Community Card Slots */}
        <div className="poker-community-row" aria-label="Community cards">
          {[0, 1, 2, 3, 4].map((slotIdx) => {
            const card = communityCards[slotIdx];
            const slotLabel = slotIdx < 3 ? 'FLOP' : slotIdx === 3 ? 'TURN' : 'RIVER';
            return card ? (
              <PlayingCardSvg
                key={`comm-${slotIdx}-${card.rank}-${card.suit}`}
                card={card}
                width={86}
                height={120}
                className="bj-card-anim"
              />
            ) : (
              <div key={`comm-empty-${slotIdx}`} className="poker-community-placeholder">
                <span>{slotLabel}</span>
              </div>
            );
          })}
        </div>

        {lastAction && (
          <div className="row row--center">
            <span className="last-action-pill">
              <strong>{lastAction.type.toUpperCase()}</strong>
              {lastAction.amount ? ` · ${formatChips(lastAction.amount)}` : ''}
              {lastAction.forced_by_timeout && (
                <span className="badge badge--timeout">15s → AFK</span>
              )}
            </span>
          </div>
        )}

        {/* 15s Turn Spotlight */}
        {turnPlayer && turnSeconds !== null && (
          <div className="turn-spotlight">
            <div className="turn-spotlight__title">
              {isMyTurn ? (
                <span className="gold-text">{t('poker.yourTurn')}</span>
              ) : (
                <span>{t('bj.playerActing', { player: turnPlayer.username })}</span>
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

        {/* Deal Next Hand CTA */}
        {phase !== 'playing' && (
          <div className="row row--center" style={{ marginTop: '0.4rem' }}>
            {canStartHand ? (
              <button
                type="button"
                className="btn btn--gold"
                onClick={() => void onStartHand()}
                disabled={actionBusy}
              >
                {actionBusy
                  ? t('poker.dealing')
                  : `${t('poker.dealNextHand')} (${formatChips(smallBlind)}/${formatChips(bigBlind)})`}
              </button>
            ) : (
              <span className="muted small">{t('poker.waitingPlayers')}</span>
            )}
          </div>
        )}

        {/* Active Player Betting & Action Bar */}
        {canAct && (
          <div className="bj-betting-console">
            <div className="bj-action-bar">
              <button
                type="button"
                className="btn btn--ghost bj-action-btn"
                onClick={() => void onAction('fold')}
                disabled={actionBusy}
              >
                {t('poker.fold')}
              </button>

              {callDiff === 0 ? (
                <button
                  type="button"
                  className="btn btn--gold bj-action-btn"
                  onClick={() => void onAction('check')}
                  disabled={actionBusy}
                >
                  {t('poker.check')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--gold bj-action-btn"
                  onClick={() => void onAction('call')}
                  disabled={actionBusy}
                >
                  {t('poker.call')} {formatChips(callDiff)}
                </button>
              )}

              <button
                type="button"
                className="btn btn--gold bj-action-btn"
                onClick={() => void onAction('raise', raiseToAmount)}
                disabled={
                  actionBusy ||
                  (balance !== null && raiseToAmount - myStreetBet > balance) ||
                  raiseToAmount < minRaiseTo
                }
              >
                {t('poker.raiseTo')} {formatChips(raiseToAmount)}
              </button>

              <button
                type="button"
                className="btn btn--ghost bj-action-btn"
                onClick={() => void onAction('all_in')}
                disabled={actionBusy || (balance !== null && balance <= 0)}
              >
                {t('poker.allIn')} {balance !== null ? `(${formatChips(balance)})` : ''}
              </button>
            </div>

            <div className="bj-chip-rack" role="group" aria-label="Increase raise amount">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setRaiseToAmount(minRaiseTo)}
                disabled={actionBusy}
                data-silent
              >
                {t('room.min')} ({formatChips(minRaiseTo)})
              </button>
              {RAISE_CHIPS.map((val) => (
                <button
                  key={val}
                  type="button"
                  className="bj-chip-btn"
                  onClick={() => addRaiseChip(val)}
                  disabled={actionBusy}
                  title={`+${formatChips(val)}`}
                  data-silent
                >
                  <CasinoChipSvg value={val} size={42} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Seated Players & Hole Cards */}
      <div className="seats-grid seats-grid--arc">
        {seats.map((seat) => {
          const isTurn = gameState?.turn_user_id === seat.user_id;
          const isMe = currentUserId === seat.user_id;
          const pState = pokerPlayers[seat.user_id];
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

          const revealed = revealedHands[seat.user_id];
          const holeCardsToShow: Card[] =
            isMe && myPrivateCards.length > 0
              ? myPrivateCards
              : Array.isArray(revealed) && revealed.length > 0
                ? revealed
                : [];

          return (
            <div
              key={seat.user_id}
              className={`seat-card bj-seat-card${isTurn ? ' seat-card--turn' : ''}${
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
                <div className="row" style={{ gap: '0.35rem' }}>
                  <span className="muted small tabular">
                    {t('room.seat')} #{seat.seat + 1}
                  </span>
                  {dealerSeat === seat.seat && <span className="badge badge--bj-win">D</span>}
                  {sbSeat === seat.seat && <span className="badge">SB</span>}
                  {bbSeat === seat.seat && <span className="badge">BB</span>}
                </div>
                <div className="row">
                  {seat.status === 'afk' ? (
                    <span className="badge badge--timeout">AFK</span>
                  ) : pState?.status === 'folded' ? (
                    <span className="badge badge--timeout">Folded</span>
                  ) : pState?.status === 'all_in' ? (
                    <span className="badge badge--bj-win">ALL-IN</span>
                  ) : isTurn ? (
                    <span className="badge badge--open">{t('room.acting')}</span>
                  ) : null}
                </div>
              </div>

              <div className="seat-card__identity">
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={46} />
                <div className="seat-card__meta">
                  <strong className="seat-card__name">
                    {seat.username} {isMe ? t('room.you') : ''}
                  </strong>
                  <span className="muted small">
                    {pState ? `${t('poker.pot')}: ${formatChips(pState.total_bet)}` : 'Seated'}
                  </span>
                </div>
              </div>

              {pState && (
                <div className="bj-seat-hand">
                  <div className="bj-seat-hand__meta">
                    <span className="badge tabular">Bet: {formatChips(pState.street_bet)}</span>
                    {pState.hand_name && (
                      <span className="badge badge--open">{pState.hand_name}</span>
                    )}
                  </div>

                  <div className="bj-cards-row bj-cards-row--seat">
                    {holeCardsToShow.length > 0 ? (
                      holeCardsToShow.map((c, idx) => (
                        <PlayingCardSvg
                          key={`${seat.user_id}-hole-${idx}-${c.rank}-${c.suit}`}
                          card={c}
                          cardBackUrl={cardBackUrl}
                          width={70}
                          height={98}
                          className="bj-card-anim"
                        />
                      ))
                    ) : pState.status !== 'folded' && roundNumber > 0 ? (
                      <>
                        <PlayingCardSvg hidden cardBackUrl={cardBackUrl} width={66} height={94} />
                        <PlayingCardSvg hidden cardBackUrl={cardBackUrl} width={66} height={94} />
                      </>
                    ) : null}
                  </div>

                  {phase === 'settled' && pState.payout !== undefined && (
                    <div className="bj-seat-outcome">
                      <span
                        className={`badge ${
                          pState.payout > 0 ? 'badge--bj-win' : 'badge--timeout'
                        }`}
                      >
                        {pState.payout > 0
                          ? `WON +${formatChips(pState.payout)} (${pState.hand_name ?? 'Best Hand'})`
                          : `Lost ${formatChips(pState.total_bet)}`}
                      </span>
                    </div>
                  )}
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
  );
}
