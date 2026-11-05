import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  CardSuit,
  DurakPlayerState,
  DurakTablePair,
  GameStateRow,
  InteractiveEmoteEvent,
  PlayingCard,
  QuickEmoteEvent,
  RoomSeatWithProfile,
  ShopItem,
} from '../lib/types';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';
import { PlayingCardSvg } from './PlayingCardSvg';

const SUIT_NAMES: Record<CardSuit, { name: string; symbol: string; color: string }> = {
  S: { name: 'Spades', symbol: '♠', color: '#e6e1d6' },
  C: { name: 'Clubs', symbol: '♣', color: '#e6e1d6' },
  H: { name: 'Hearts', symbol: '♥', color: '#b92538' },
  D: { name: 'Diamonds', symbol: '♦', color: '#b92538' },
};

interface DurakTableProps {
  myUserId: string;
  minBet: number;
  seats: RoomSeatWithProfile[];
  gameState: GameStateRow | null;
  privateState: Record<string, unknown>;
  cardBackMap: Map<string, ShopItem>;
  turnRemainingMs: number | null;
  quickEmotesByUser: Record<string, QuickEmoteEvent>;
  activeInteractiveEmote: InteractiveEmoteEvent | null;
  onFireInteractive: (targetUserId: string) => Promise<void>;
  onStartGame: () => Promise<void>;
  onAction: (
    action: 'attack' | 'defend' | 'bito' | 'take',
    card?: PlayingCard | null,
  ) => Promise<void>;
}

export function DurakTable({
  myUserId,
  minBet,
  seats,
  gameState,
  privateState,
  cardBackMap,
  turnRemainingMs,
  quickEmotesByUser,
  activeInteractiveEmote,
  onFireInteractive,
  onStartGame,
  onAction,
}: DurakTableProps) {
  const { t } = useI18n();
  const phase = gameState?.phase ?? 'waiting';
  const pot = Number(gameState?.state?.pot ?? 0);
  const deckRemaining = Number(gameState?.state?.deck_remaining ?? 0);
  const trumpCard = (gameState?.state?.trump_card ?? null) as PlayingCard | null;
  const trumpSuit = (gameState?.state?.trump_suit ?? 'S') as CardSuit;
  const attackerId = (gameState?.state?.attacker_id ?? null) as string | null;
  const defenderId = (gameState?.state?.defender_id ?? null) as string | null;
  const boutSubphase = (gameState?.state?.bout_subphase ?? 'attacking') as
    | 'attacking'
    | 'defending';
  const tablePairs = (gameState?.state?.table_pairs ?? []) as DurakTablePair[];
  const playersMap = (gameState?.state?.players ?? {}) as Record<string, DurakPlayerState>;
  const winnerId = (gameState?.state?.winner_id ?? null) as string | null;

  const turnUserId = gameState?.turn_user_id ?? null;
  const isMyTurn = turnUserId === myUserId;
  const amAttacker = attackerId === myUserId;
  const amDefender = defenderId === myUserId;

  const myHand = Array.isArray(privateState.hand) ? (privateState.hand as PlayingCard[]) : [];

  const [busy, setBusy] = useState(false);
  const [tableErr, setTableErr] = useState<string | null>(null);

  const turnSec = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;
  const isUrgent = turnRemainingMs !== null && turnRemainingMs <= 4000;

  const activeTurnSeat = turnUserId ? seats.find((s) => s.user_id === turnUserId) ?? null : null;
  const suitInfo = SUIT_NAMES[trumpSuit] ?? SUIT_NAMES.S;

  async function runAction(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setTableErr(null);
    try {
      await fn();
    } catch (e) {
      setTableErr(e instanceof Error ? e.message : 'Durak move rejected.');
    } finally {
      setBusy(false);
    }
  }

  function handleCardClick(card: PlayingCard) {
    if (!isMyTurn || phase !== 'playing' || busy) return;
    if (boutSubphase === 'attacking' && amAttacker) {
      void runAction(() => onAction('attack', card));
    } else if (boutSubphase === 'defending' && amDefender) {
      void runAction(() => onAction('defend', card));
    }
  }

  return (
    <div className="table-felt casino-oval-felt durak-felt bj-felt">
      {/* Top Status Bar */}
      <div className="bj-top-bar">
        <div className="bj-top-meta">
          <span className="casino-dealer-badge">DURAK 36</span>
          <span className="badge badge--gold">{t('durak.eyebrow')}</span>
          <span className="badge">
            {t('room.minBet')} {formatChips(minBet)}
          </span>
          {pot > 0 ? (
            <span className="badge badge--gold">
              {t('durak.pot')}: {formatChips(pot)}
            </span>
          ) : null}
          {phase === 'playing' || phase === 'settled' ? (
            <span className="badge" style={{ color: suitInfo.color }}>
              TRUMP: {suitInfo.symbol} {suitInfo.name.toUpperCase()}
            </span>
          ) : null}
          {phase === 'playing' ? (
            <span className="badge">
              {t('durak.talon').toUpperCase()}: {deckRemaining}
            </span>
          ) : null}
        </div>

        {turnUserId && turnSec !== null ? (
          <div className={`bj-clock${isUrgent ? ' bj-clock--urgent' : ''}`}>
            <span className="bj-clock__who">
              {isMyTurn
                ? boutSubphase === 'attacking'
                  ? 'YOUR ATTACK'
                  : 'YOUR DEFENSE'
                : `${activeTurnSeat?.username ?? 'Player'} (${boutSubphase})`}
            </span>
            <strong className="bj-clock__sec">{turnSec}s</strong>
          </div>
        ) : (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {phase === 'waiting' ? t('poker.waitingPlayers') : t('room.settled')}
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

      {/* Center Bout Arena + Talon Deck */}
      <div className="durak-battlefield">
        {/* Talon + Trump Card Stack */}
        <div className="durak-talon-box">
          <span className="bj-dealer-label">
            {t('durak.talon').toUpperCase()} ({deckRemaining})
          </span>
          <div className="durak-talon-stack">
            {trumpCard && deckRemaining > 0 ? (
              <div className="durak-trump-under">
                <PlayingCardSvg card={trumpCard} width={66} height={92} />
              </div>
            ) : null}
            {deckRemaining > 1 ? (
              <div className="durak-talon-top">
                <PlayingCardSvg hidden cardBackUrl={DEFAULT_CARD_BACK_URL} width={66} height={92} />
              </div>
            ) : null}
            {deckRemaining === 0 ? (
              <div className="durak-empty-talon" style={{ color: suitInfo.color }}>
                <span>{suitInfo.symbol}</span>
                <small>{suitInfo.name}</small>
              </div>
            ) : null}
          </div>
        </div>

        {/* Bout Pairs */}
        <div className="durak-pairs-zone">
          <div className="bj-dealer-header">
            <span className="bj-dealer-label">
              BATTLEFIELD ({tablePairs.length} / 6 BOUT PAIRS)
            </span>
            {phase === 'playing' ? (
              <span className="badge badge--gold">
                {boutSubphase === 'attacking'
                  ? 'ATTACKER SELECTING CARD OR BITO'
                  : 'DEFENDER MUST BEAT ATTACK CARD OR TAKE'}
              </span>
            ) : null}
          </div>

          {tablePairs.length === 0 ? (
            <div className="bj-dealer-idle">
              {phase === 'playing'
                ? 'No cards on the table yet — Attacker leads with any card from hand.'
                : 'Click below to shuffle the 36-card deck and reveal the Trump suit.'}
            </div>
          ) : (
            <div className="durak-pairs-grid">
              {tablePairs.map((pair, idx) => (
                <div key={idx} className="durak-pair-slot">
                  <div className="durak-pair-attack">
                    <PlayingCardSvg card={pair.attack} width={74} height={104} className="bj-card-anim" />
                  </div>
                  {pair.defense ? (
                    <div className="durak-pair-defense">
                      <PlayingCardSvg card={pair.defense} width={74} height={104} className="bj-card-anim" />
                    </div>
                  ) : (
                    <div className="durak-pair-undefended">UNDEFENDED</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Private Hand Area for Signed-In Player */}
      {myHand.length > 0 ? (
        <div className="durak-my-hand-panel">
          <div className="durak-my-hand-header">
            <span className="bj-dealer-label">
              {t('durak.yourHand').toUpperCase()} ({myHand.length})
            </span>
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              {isMyTurn
                ? boutSubphase === 'attacking'
                  ? 'Click a card in your hand to Attack'
                  : 'Click a higher card of same suit (or Trump) to Defend'
                : 'Wait for your turn'}
            </span>
          </div>
          <div className="durak-hand-fan">
            {myHand.map((card, idx) => (
              <button
                key={`${card.rank}-${card.suit}-${idx}`}
                type="button"
                className={`durak-hand-card-btn${isMyTurn ? ' durak-hand-card-btn--active' : ''}`}
                disabled={!isMyTurn || busy}
                onClick={() => handleCardClick(card)}
              >
                <PlayingCardSvg card={card} width={76} height={106} />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Seated Players Grid */}
      <div className="bj-seats-grid seats-grid--arc">
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
          const isAttacker = attackerId === seat.user_id;
          const isDefender = defenderId === seat.user_id;

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

              {/* Role Badges */}
              <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                {isAttacker && phase === 'playing' ? (
                  <span className="badge badge--gold">⚔️ ATTACKER</span>
                ) : null}
                {isDefender && phase === 'playing' ? (
                  <span className="badge badge--timeout">🛡️ DEFENDER</span>
                ) : null}
                {phase === 'settled' && winnerId === seat.user_id ? (
                  <span className="badge badge--bj-win">
                    WINNER (+{formatChips(pState?.payout ?? pot)})
                  </span>
                ) : null}
              </div>

              {/* Card Count Representation */}
              <div className="bj-seat-meta-row">
                <PlayingCardSvg hidden cardBackUrl={cardBackUrl} width={36} height={50} />
                <span className="bj-bet-pill">
                  {pState ? `${pState.card_count} Cards` : t('room.tableReady')}
                </span>
              </div>

              <div className="bj-seat-footer">
                <Avatar avatarId={seat.avatar_id} userId={seat.user_id} size={42} />
                <div className="bj-seat-identity">
                  <div className="bj-seat-name">
                    #{seat.seat + 1} {seat.username}
                    {isMe ? <span className="seat-card__you">{t('room.you')}</span> : null}
                  </div>
                  <div className="bj-seat-sub">
                    {seat.status === 'afk' ? (
                      <span style={{ color: '#f29ca8' }}>AFK</span>
                    ) : isTurn ? (
                      <span style={{ color: 'var(--gold-light)' }}>{t('room.acting')}…</span>
                    ) : (
                      <span>{t('room.tableReady')}</span>
                    )}
                  </div>
                </div>
              </div>

              {!isMe ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm seat-target-btn"
                  onClick={() => void onFireInteractive(seat.user_id)}
                >
                  {t('room.targetEmote')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Bottom Action Bar */}
      <div className="bj-controls-bar">
        {tableErr ? (
          <div className="alert alert--error" style={{ marginBottom: '0.65rem' }}>
            {tableErr}
          </div>
        ) : null}

        {phase === 'waiting' || phase === 'settled' || phase === 'lobby' ? (
          <div className="bj-controls-Idle">
            <div>
              <strong style={{ color: 'var(--gold-light)' }}>{t('durak.eyebrow')}</strong>
              <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.82rem' }}>
                {t('room.minBet')}: {formatChips(minBet)} {t('room.chips')}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--gold"
              disabled={busy}
              onClick={() => void runAction(onStartGame)}
            >
              {busy ? t('poker.dealing') : t('durak.dealBout')}
            </button>
          </div>
        ) : null}

        {phase === 'playing' ? (
          <div className="bj-controls-playing">
            <div className="bj-playing-prompt">
              {isMyTurn ? (
                boutSubphase === 'attacking' ? (
                  <strong style={{ color: 'var(--gold-light)' }}>
                    Your Attack — Click a card from your hand above, or click {t('durak.passBita')}
                  </strong>
                ) : (
                  <strong style={{ color: 'var(--gold-light)' }}>
                    Your Defense — Click a card from your hand to beat the attack, or {t('durak.takeCards')}
                  </strong>
                )
              ) : (
                <span className="muted">
                  Waiting for <strong>{activeTurnSeat?.username ?? 'opponent'}</strong>…
                </span>
              )}
            </div>

            <div className="bj-action-buttons">
              {boutSubphase === 'attacking' && amAttacker ? (
                <button
                  type="button"
                  className="btn btn--gold"
                  disabled={!isMyTurn || busy || tablePairs.length === 0}
                  onClick={() => void runAction(() => onAction('bito', null))}
                >
                  {t('durak.passBita')}
                </button>
              ) : null}

              {boutSubphase === 'defending' && amDefender ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!isMyTurn || busy}
                  onClick={() => void runAction(() => onAction('take', null))}
                >
                  {t('durak.takeCards')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
