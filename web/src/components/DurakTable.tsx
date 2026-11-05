import { useMemo } from 'react';
import { useSound } from '../audio/SoundProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  Card,
  DurakPair,
  DurakPlayerSummary,
  GameStateRow,
  InteractiveEmoteEvent,
  QuickEmoteEvent,
  Room,
  RoomSeatWithProfile,
  ShopItem,
} from '../lib/types';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';
import { PlayingCardSvg } from './PlayingCardSvg';

const RANK_VAL: Record<string, number> = {
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const SUIT_SYM: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

function canCardBeat(attack: Card, defense: Card, trumpSuit: string | null): boolean {
  if (attack.suit === defense.suit) {
    return (RANK_VAL[defense.rank] ?? 0) > (RANK_VAL[attack.rank] ?? 0);
  }
  return Boolean(trumpSuit && defense.suit === trumpSuit && attack.suit !== trumpSuit);
}

interface DurakTableProps {
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
  onStartGame: () => Promise<void>;
  onAttack: (card: Card) => Promise<void>;
  onDefend: (pairIndex: number, card: Card) => Promise<void>;
  onTake: () => Promise<void>;
  onPass: () => Promise<void>;
  onFireInteractive: (targetUserId: string) => Promise<void>;
}

export function DurakTable({
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
  onStartGame,
  onAttack,
  onDefend,
  onTake,
  onPass,
  onFireInteractive,
}: DurakTableProps) {
  const { sound } = useSound();
  const { t } = useI18n();

  const phase = gameState?.phase ?? 'lobby';
  const roundNumber = gameState?.state?.round_number ?? 0;
  const pot = gameState?.state?.pot ?? 0;
  const entryBet = gameState?.state?.entry_bet ?? Math.max(room.min_bet || 100, 50);
  const trumpCard = (gameState?.state?.trump_card ?? null) as Card | null;
  const trumpSuit = (gameState?.state?.trump_suit ?? trumpCard?.suit ?? null) as string | null;
  const deckRemaining = gameState?.state?.deck_remaining ?? 0;
  const discardCount = gameState?.state?.discard_count ?? 0;
  const attackerId = gameState?.state?.attacker_id ?? null;
  const defenderId = gameState?.state?.defender_id ?? null;
  const tablePairs = useMemo(
    () => (gameState?.state?.table_pairs ?? []) as DurakPair[],
    [gameState?.state?.table_pairs],
  );
  const durakPlayers = (gameState?.state?.players ?? {}) as Record<string, DurakPlayerSummary>;
  const winnerId = gameState?.state?.winner_id ?? null;
  const loserId = gameState?.state?.loser_id ?? null;

  const isMyTurn = Boolean(currentUserId && gameState?.turn_user_id === currentUserId);
  const isAttacker = Boolean(currentUserId && attackerId === currentUserId);
  const isDefender = Boolean(currentUserId && defenderId === currentUserId);

  const firstUndefendedIndex = useMemo(
    () => tablePairs.findIndex((p) => !p.defense),
    [tablePairs],
  );
  const allDefended = tablePairs.length > 0 && firstUndefendedIndex === -1;

  const allowedAttackRanks = useMemo(() => {
    const s = new Set<string>();
    for (const p of tablePairs) {
      if (p.attack?.rank) s.add(p.attack.rank);
      if (p.defense?.rank) s.add(p.defense.rank);
    }
    return s;
  }, [tablePairs]);

  const sortedMyCards = useMemo(() => {
    return [...myPrivateCards].sort((a, b) => {
      const aTrump = a.suit === trumpSuit ? 1 : 0;
      const bTrump = b.suit === trumpSuit ? 1 : 0;
      if (aTrump !== bTrump) return aTrump - bTrump;
      return (RANK_VAL[a.rank] ?? 0) - (RANK_VAL[b.rank] ?? 0);
    });
  }, [myPrivateCards, trumpSuit]);

  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;
  const turnSeconds = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;

  function isCardPlayable(card: Card): boolean {
    if (phase !== 'playing' || !isMyTurn || actionBusy) return false;
    if (isAttacker) {
      if (tablePairs.length === 0) return true;
      if (tablePairs.length >= 6) return false;
      return allowedAttackRanks.has(card.rank);
    }
    if (isDefender && firstUndefendedIndex >= 0) {
      const targetAttack = tablePairs[firstUndefendedIndex]?.attack;
      if (!targetAttack) return false;
      return canCardBeat(targetAttack, card, trumpSuit);
    }
    return false;
  }

  async function handleCardClick(card: Card) {
    if (!isCardPlayable(card)) return;
    sound.play('cardSlide');
    if (isAttacker) {
      await onAttack(card);
    } else if (isDefender && firstUndefendedIndex >= 0) {
      await onDefend(firstUndefendedIndex, card);
    }
  }

  return (
    <section className="table-felt casino-oval-felt durak-felt" aria-label="Durak card table">
      {/* Header Bar */}
      <div className="rl-top-bar">
        <div>
          <span className="eyebrow">{t('durak.eyebrow')}</span>
          <div className="muted small">
            {trumpSuit ? (
              <>
                Trump Suit:{' '}
                <strong className="gold-text">
                  {SUIT_SYM[trumpSuit] ?? ''} {trumpSuit.toUpperCase()}
                </strong>{' '}
                · {t('durak.talon')}: <strong>{deckRemaining}</strong> · {t('durak.bita')}:{' '}
                <strong>{discardCount}</strong>
              </>
            ) : (
              'Rank order: 6 · 7 · 8 · 9 · 10 · J · Q · K · A'
            )}
          </div>
        </div>

        <div className="row">
          <div className="room-minbet-box">
            <span className="muted small">{t('durak.pot')}</span>
            <strong className="gold-text tabular">{formatChips(pot)}</strong>
          </div>
          {phase !== 'playing' && seats.length >= 2 && (
            <button
              type="button"
              className="btn btn--gold btn--sm"
              onClick={() => void onStartGame()}
              disabled={actionBusy}
            >
              {actionBusy ? '…' : `${t('durak.dealBout')} (${formatChips(entryBet)})`}
            </button>
          )}
        </div>
      </div>

      {/* Center Battlefield: Talon & Attack/Defense Pairs */}
      <div className="durak-battlefield">
        {/* Left: Talon & Trump Card */}
        <div className="durak-talon-box">
          <span className="eyebrow">
            {t('durak.talon')} ({deckRemaining})
          </span>
          <div className="durak-talon-stack">
            {trumpCard && deckRemaining > 0 && (
              <div className="durak-trump-under" title={`Trump: ${trumpCard.rank} of ${trumpCard.suit}`}>
                <PlayingCardSvg card={trumpCard} width={68} height={96} />
              </div>
            )}
            {deckRemaining > 1 && (
              <div className="durak-talon-top">
                <PlayingCardSvg hidden cardBackUrl={DEFAULT_CARD_BACK_URL} width={68} height={96} />
              </div>
            )}
            {deckRemaining === 0 && trumpSuit && (
              <div className="durak-empty-talon">
                <span>{SUIT_SYM[trumpSuit] ?? ''}</span>
                <small>{trumpSuit}</small>
              </div>
            )}
          </div>
        </div>

        {/* Right: Active Bout Pairs */}
        <div className="durak-pairs-zone">
          <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
            <span className="eyebrow">
              {phase === 'playing'
                ? `${t('room.round')} #${roundNumber} · ${tablePairs.length} / 6`
                : t('room.tableReady')}
            </span>

            {turnPlayer && turnSeconds !== null && (
              <span className={`turn-clock tabular${Number(turnSeconds) <= 5 ? ' turn-clock--urgent' : ''}`}>
                {isMyTurn ? t('room.acting') : turnPlayer.username} · {turnSeconds}s
              </span>
            )}
          </div>

          {turnPlayer && turnSeconds !== null && (
            <div className="turn-progress" aria-hidden="true" style={{ margin: '0.35rem 0 0.75rem' }}>
              <div
                className={`turn-progress__fill${Number(turnSeconds) <= 5 ? ' is-urgent' : ''}`}
                style={{ width: `${turnProgressPct}%` }}
              />
            </div>
          )}

          {tablePairs.length === 0 ? (
            <p className="muted small" style={{ margin: '1.25rem 0' }}>
              {phase === 'playing'
                ? isAttacker && isMyTurn
                  ? 'Click any card in your hand below to launch the attack.'
                  : 'Waiting for the attacker to lead a card…'
                : 'Seat at least 2 players and click Deal New Bout.'}
            </p>
          ) : (
            <div className="durak-pairs-grid">
              {tablePairs.map((pair, idx) => (
                <div key={`pair-${idx}`} className="durak-pair-slot">
                  <div className="durak-pair-attack">
                    <PlayingCardSvg card={pair.attack} width={76} height={106} />
                  </div>
                  {pair.defense ? (
                    <div className="durak-pair-defense">
                      <PlayingCardSvg card={pair.defense} width={76} height={106} />
                    </div>
                  ) : (
                    <div className="durak-pair-undefended">
                      <span>UNDEFENDED</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Bout Action Buttons (Pass / Bita or Take Cards) */}
          {phase === 'playing' && isMyTurn && (
            <div className="row row--center" style={{ marginTop: '0.85rem' }}>
              {isDefender && firstUndefendedIndex >= 0 && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void onTake()}
                  disabled={actionBusy}
                >
                  {t('durak.takeCards')} ({tablePairs.length})
                </button>
              )}

              {isAttacker && allDefended && (
                <button
                  type="button"
                  className="btn btn--gold"
                  onClick={() => void onPass()}
                  disabled={actionBusy}
                >
                  {t('durak.passBita')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Settlement Outcome Banner */}
      {phase === 'settled' && (winnerId || loserId) && (
        <div
          className={`bj-outcome-banner ${
            winnerId === currentUserId ? 'bj-outcome-banner--win' : 'bj-outcome-banner--push'
          }`}
          role="status"
        >
          <strong>
            {winnerId === currentUserId
              ? 'VICTORY — YOU SHED ALL CARDS FIRST!'
              : `DURAK BOUT COMPLETE`}
          </strong>
          <span>
            Winner collected the {formatChips(pot)} chip pot.
            {loserId ? ` (${seats.find((s) => s.user_id === loserId)?.username ?? 'Player'} is the Durak)` : ''}
          </span>
        </div>
      )}

      {/* My Private Hand Fan */}
      {currentUserId && sortedMyCards.length > 0 && (
        <div className="durak-my-hand-panel">
          <div className="durak-my-hand-header">
            <span className="eyebrow">
              {t('durak.yourHand')} ({sortedMyCards.length}) ·{' '}
              {isAttacker ? 'ATTACKER' : isDefender ? 'DEFENDER' : 'WAITING'}
            </span>
          </div>
          <div className="durak-hand-fan">
            {sortedMyCards.map((c, idx) => {
              const playable = isCardPlayable(c);
              return (
                <button
                  key={`my-durak-${idx}-${c.rank}-${c.suit}`}
                  type="button"
                  className={`durak-hand-card-btn${playable ? ' durak-hand-card-btn--active' : ''}`}
                  onClick={() => void handleCardClick(c)}
                  disabled={!playable || actionBusy}
                  data-silent
                >
                  <PlayingCardSvg card={c} width={80} height={112} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Seated Players */}
      <div className="seats-grid seats-grid--arc">
        {seats.map((seat) => {
          const isTurn = gameState?.turn_user_id === seat.user_id;
          const isMe = currentUserId === seat.user_id;
          const pInfo = durakPlayers[seat.user_id];
          const cardCount = pInfo?.card_count ?? 0;
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
                <span className="muted small tabular">
                  {t('room.seat')} #{seat.seat + 1}
                </span>
                <div className="row">
                  {attackerId === seat.user_id && phase === 'playing' && (
                    <span className="badge badge--bj-win">⚔ Attacker</span>
                  )}
                  {defenderId === seat.user_id && phase === 'playing' && (
                    <span className="badge badge--open">🛡 Defender</span>
                  )}
                  {seat.status === 'afk' && <span className="badge badge--timeout">AFK</span>}
                </div>
              </div>

              <div className="seat-card__identity">
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={46} />
                <div className="seat-card__meta">
                  <strong className="seat-card__name">
                    {seat.username} {isMe ? t('room.you') : ''}
                  </strong>
                  <span className="muted small tabular">
                    {phase === 'playing' ? `${cardCount} cards` : 'Ready'}
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
