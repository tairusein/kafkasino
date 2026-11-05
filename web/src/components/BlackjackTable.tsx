import { useEffect, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { useI18n } from '../i18n/I18nProvider';
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
  const { t } = useI18n();

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
    <section className="table-felt casino-oval-felt bj-felt" aria-label="Blackjack table">
      {/* Luxury Casino Chip Tray & Dealer Station */}
      <div className="bj-dealer-zone">
        <div className="bj-dealer-head">
          <div className="row">
            <span className="casino-dealer-badge">CROUPIER</span>
            <span className="eyebrow">{t('bj.dealerRules')}</span>
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
                  ? `${dealer.total} + ?`
                  : formatHandTotal(dealer.total, dealer.is_soft, dealer.is_blackjack, dealer.is_bust)}
              </span>
            )}
          </div>

          <div className="casino-dealer-tray" aria-hidden="true">
            <span className="casino-dealer-tray__tube" />
            <span className="casino-dealer-tray__tube" />
            <span className="casino-dealer-tray__tube" />
            <span className="casino-dealer-tray__tube" />
            <span className="casino-dealer-tray__tube" />
          </div>

          <div className="bj-shoe-pill" title="Authoritative 6-deck server shoe">
            <svg viewBox="0 0 28 20" width="22" height="16" aria-hidden="true">
              <rect x="2" y="3" width="24" height="14" rx="2" fill="#23262e" stroke="#c9a24b" strokeWidth="1.4" />
              <line x1="7" y1="3" x2="7" y2="17" stroke="#c9a24b" strokeWidth="1" />
              <line x1="12" y1="3" x2="12" y2="17" stroke="#c9a24b" strokeWidth="1" />
            </svg>
            <span className="muted small tabular">
              {t('bj.shoe')}: {shoeRemaining} / 312
            </span>
          </div>
        </div>

        <div className="bj-cards-row bj-cards-row--dealer">
          {dealer && dealer.cards.length > 0 ? (
            <>
              {dealer.cards.map((c, idx) => (
                <PlayingCardSvg
                  key={`dealer-${idx}-${c.rank}-${c.suit}`}
                  card={c}
                  width={90}
                  height={126}
                  className="bj-card-anim"
                />
              ))}
              {dealer.hole_hidden && (
                <PlayingCardSvg
                  key="dealer-hole-hidden"
                  hidden
                  cardBackUrl={DEFAULT_CARD_BACK_URL}
                  width={90}
                  height={126}
                  className="bj-card-anim"
                />
              )}
            </>
          ) : (
            <div className="bj-empty-cards">
              <PlayingCardSvg hidden cardBackUrl={DEFAULT_CARD_BACK_URL} width={78} height={110} />
              <PlayingCardSvg hidden cardBackUrl={DEFAULT_CARD_BACK_URL} width={78} height={110} />
              <span className="muted small">{t('bj.placeWagerPrompt')}</span>
            </div>
          )}
        </div>
      </div>

      {/* 2. Center Felt Ribbon, Curved Felt Arch & 15s Turn Clock */}
      <div className="table-felt__center bj-center-ribbon">
        <div className="bj-rules-arch">{t('bj.feltRibbon')}</div>

        <div className="row row--center">
          <span className="badge badge--open">
            {phase === 'lobby'
              ? t('room.tableReady')
              : phase === 'betting'
                ? `${t('room.hand')} #${roundNumber} · ${t('room.bettingOpen')}`
                : phase === 'playing'
                  ? `${t('room.hand')} #${roundNumber} · ${t('room.inPlay')}`
                  : `${t('room.hand')} #${roundNumber} · ${t('room.settled')}`}
          </span>

          {lastAction && (
            <span className="last-action-pill">
              <strong>{lastAction.type.toUpperCase()}</strong>
              {lastAction.forced_by_timeout && (
                <span className="badge badge--timeout">15s → AFK</span>
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
                  {phase === 'betting' ? t('bj.yourTurnBet') : t('bj.yourTurnAct')}
                </span>
              ) : (
                <span>
                  {phase === 'betting'
                    ? t('bj.awaitingBet', { player: turnPlayer.username })
                    : t('bj.playerActing', { player: turnPlayer.username })}
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
                  3:2 — +{formatChips(myHand.payout)} {t('room.chips')} (+{formatChips(myHand.net)})
                </span>
              </>
            )}
            {myHand.outcome === 'win' && (
              <>
                <strong>HAND WON!</strong>
                <span>
                  +{formatChips(myHand.payout)} {t('room.chips')} (+{formatChips(myHand.net)})
                </span>
              </>
            )}
            {myHand.outcome === 'push' && (
              <>
                <strong>PUSH — STANDOFF</strong>
                <span>
                  {formatChips(myHand.payout)} {t('room.chips')} refunded.
                </span>
              </>
            )}
            {myHand.outcome === 'bust' && (
              <>
                <strong>BUST ({myHand.total})</strong>
                <span>
                  -{formatChips(myHand.bet)} {t('room.chips')}
                </span>
              </>
            )}
            {myHand.outcome === 'lose' && (
              <>
                <strong>
                  DEALER WINS ({dealer?.total ?? 0} vs {myHand.total})
                </strong>
                <span>
                  -{formatChips(myHand.bet)} {t('room.chips')}
                </span>
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
                  title={`+${formatChips(val)}`}
                  data-silent
                >
                  <CasinoChipSvg value={val} size={50} />
                </button>
              ))}
            </div>

            <div className="bj-wager-bar">
              <div className="bj-wager-display">
                <span className="muted small">
                  {t('bj.yourWager')} ({t('room.min')} {formatChips(tableMinBet)})
                </span>
                <strong className="bj-wager-display__amount tabular">
                  {formatChips(wager)} {t('room.chips')}
                </strong>
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
                  {t('room.min')} ({formatChips(tableMinBet)})
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
                  {t('room.doubleWager')}
                </button>
                <button
                  type="button"
                  className="btn btn--gold"
                  onClick={() => void onPlaceBet(wager)}
                  disabled={actionBusy || insufficientForWager || wager < tableMinBet}
                >
                  {actionBusy
                    ? t('bj.dealing')
                    : phase === 'betting'
                      ? `${t('bj.confirmBet')} · ${formatChips(wager)}`
                      : `${t('bj.dealHand')} ${formatChips(wager)}`}
                </button>
                {seats.length > 1 && (phase === 'lobby' || phase === 'settled') && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void onStartRound()}
                    disabled={actionBusy}
                  >
                    {t('room.openTableBetting')}
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
              {t('bj.hit')}
            </button>
            <button
              type="button"
              className="btn btn--ghost bj-action-btn"
              onClick={() => void onAction('stand')}
              disabled={actionBusy}
            >
              {t('bj.stand')} ({myHand.total})
            </button>
            <button
              type="button"
              className="btn btn--gold bj-action-btn"
              onClick={() => void onAction('double')}
              disabled={actionBusy || !canDoubleDown}
            >
              {t('bj.doubleDown')} (+{formatChips(myHand.bet)})
            </button>
          </div>
        )}
      </div>

      {/* 4. Seated Players Arc */}
      <div className="seats-grid seats-grid--arc">
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
                  {room.host_id === seat.user_id && <span className="badge">{t('room.host')}</span>}
                  {seat.status === 'afk' ? (
                    <span className="badge badge--timeout">AFK</span>
                  ) : seat.status === 'spectating' ? (
                    <span className="badge">{t('room.spectating')}</span>
                  ) : isTurn ? (
                    <span className="badge badge--open">{t('room.acting')}</span>
                  ) : null}
                </div>
              </div>

              <div className="seat-card__identity">
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={48} />
                <div className="seat-card__meta">
                  <strong className="seat-card__name">
                    {seat.username} {isMe ? t('room.you') : ''}
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

              {seatHand && seatHand.bet > 0 ? (
                <div className="bj-seat-hand">
                  <div className="bj-seat-hand__meta">
                    <span className="badge badge--open tabular">
                      ● {formatChips(seatHand.bet)}
                    </span>
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
                      <span className="badge badge--open">2×</span>
                    )}
                  </div>

                  {seatHand.cards.length > 0 && (
                    <div className="bj-cards-row bj-cards-row--seat">
                      {seatHand.cards.map((c, idx) => (
                        <PlayingCardSvg
                          key={`${seat.user_id}-c-${idx}-${c.rank}-${c.suit}`}
                          card={c}
                          cardBackUrl={cardBackUrl}
                          width={72}
                          height={102}
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
              ) : (
                <div className="casino-betting-circle" aria-hidden="true">
                  <span>{seatHand?.status === 'betting' ? 'BETTING…' : 'WAGER ZONE'}</span>
                </div>
              )}

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
  );
}
