import { useEffect, useMemo, useRef, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatChips } from '../lib/format';
import { DEFAULT_CARD_BACK_URL, EMOTE_SPECS, resolveCardBackUrl } from '../lib/shop';
import type {
  GameStateRow,
  InteractiveEmoteEvent,
  QuickEmoteEvent,
  Room,
  RoomSeatWithProfile,
  RouletteBetItem,
  RouletteBetKind,
  RouletteColor,
  RouletteHistoryEntry,
  RouletteTicketState,
  ShopItem,
} from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';
import { Avatar } from './Avatar';
import { EmoteVectorIcon } from './InteractiveEmotePreview';
import { CasinoChipSvg } from './PlayingCardSvg';

const CHIP_DENOMINATIONS = [50, 100, 250, 500, 1000, 5000] as const;

const EUROPEAN_WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29,
  7, 28, 12, 35, 3, 26,
] as const;

const RED_NUMBERS = new Set<number>([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function pocketColor(n: number): RouletteColor {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

function pocketFill(color: RouletteColor): string {
  if (color === 'green') return '#1c5c3e';
  if (color === 'red') return '#8b182c';
  return '#16161a';
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeSector(cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, endDeg: number): string {
  const p1 = polarToCartesian(cx, cy, rOuter, startDeg);
  const p2 = polarToCartesian(cx, cy, rOuter, endDeg);
  const p3 = polarToCartesian(cx, cy, rInner, endDeg);
  const p4 = polarToCartesian(cx, cy, rInner, startDeg);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 0 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

function betKey(kind: RouletteBetKind, num: number | null): string {
  return kind === 'straight' ? `straight:${num ?? 0}` : kind;
}

function formatBetLabel(item: Pick<RouletteBetItem, 'kind' | 'number'>): string {
  switch (item.kind) {
    case 'straight':
      return `Straight #${item.number ?? 0} (35:1)`;
    case 'red':
      return 'Red (1:1)';
    case 'black':
      return 'Black (1:1)';
    case 'even':
      return 'Even (1:1)';
    case 'odd':
      return 'Odd (1:1)';
    case 'low':
      return '1–18 Low (1:1)';
    case 'high':
      return '19–36 High (1:1)';
    case 'dozen_1':
      return '1st 12 (2:1)';
    case 'dozen_2':
      return '2nd 12 (2:1)';
    case 'dozen_3':
      return '3rd 12 (2:1)';
    case 'col_1':
      return 'Column 1 (2:1)';
    case 'col_2':
      return 'Column 2 (2:1)';
    case 'col_3':
      return 'Column 3 (2:1)';
  }
}

function EuropeanRouletteWheelSvg({
  rotationDeg,
  winningNumber,
  spinning,
}: {
  rotationDeg: number;
  winningNumber: number | null;
  spinning: boolean;
}) {
  const step = 360 / 37;

  return (
    <div className="rl-wheel-wrap">
      <svg
        viewBox="0 0 320 320"
        width={276}
        height={276}
        className="rl-wheel-svg"
        role="img"
        aria-label="European single-zero roulette wheel"
      >
        {/* Outer mahogany & gold bowl */}
        <circle cx="160" cy="160" r="154" fill="#2a0d15" stroke="#c9a24b" strokeWidth="4" />
        <circle cx="160" cy="160" r="142" fill="#16161a" stroke="#8a6c28" strokeWidth="2" />

        {/* Rotating 37-pocket rotor */}
        <g
          style={{
            transform: `rotate(${rotationDeg}deg)`,
            transformOrigin: '160px 160px',
            transition: spinning ? 'transform 2.5s cubic-bezier(0.12, 0.82, 0.2, 1)' : 'none',
          }}
        >
          {EUROPEAN_WHEEL_ORDER.map((num, idx) => {
            const startAngle = idx * step - step / 2;
            const endAngle = startAngle + step;
            const midAngle = idx * step;
            const color = pocketColor(num);
            const isWin = !spinning && winningNumber === num;
            const labelPos = polarToCartesian(160, 160, 121, midAngle);

            return (
              <g key={num}>
                <path
                  d={describeSector(160, 160, 136, 82, startAngle, endAngle)}
                  fill={pocketFill(color)}
                  stroke={isWin ? '#f5df9e' : '#c9a24b'}
                  strokeWidth={isWin ? '2.2' : '0.9'}
                />
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  fill={isWin ? '#f5df9e' : '#f2ebdd'}
                  fontFamily="Cormorant Garamond, Georgia, serif"
                  fontSize="10.5"
                  fontWeight="700"
                  textAnchor="middle"
                  dominantBaseline="central"
                  transform={`rotate(${midAngle}, ${labelPos.x}, ${labelPos.y})`}
                >
                  {num}
                </text>
              </g>
            );
          })}

          {/* Inner cone & brass turret spokes */}
          <circle cx="160" cy="160" r="82" fill="#1d1d22" stroke="#c9a24b" strokeWidth="2.2" />
          <circle cx="160" cy="160" r="56" fill="#261319" stroke="#c9a24b" strokeWidth="1.2" strokeDasharray="4 4" />
          <line x1="104" y1="160" x2="216" y2="160" stroke="#c9a24b" strokeWidth="2.2" />
          <line x1="160" y1="104" x2="160" y2="216" stroke="#c9a24b" strokeWidth="2.2" />
          <circle cx="160" cy="160" r="18" fill="#c9a24b" stroke="#16161a" strokeWidth="2" />
          <circle cx="160" cy="160" r="7" fill="#f5df9e" />
        </g>

        {/* Top 12-o'clock pointer & settled ivory ball */}
        <polygon points="160,6 153,22 167,22" fill="#e8cf8f" stroke="#16161a" strokeWidth="1.2" />
        {(winningNumber !== null || spinning) && (
          <circle
            cx="160"
            cy={spinning ? '28' : '64'}
            r="6.5"
            fill="#f7f1e3"
            stroke="#c9a24b"
            strokeWidth="1.5"
            className={spinning ? 'rl-ball--orbiting' : ''}
          />
        )}
      </svg>
    </div>
  );
}

interface RouletteTableProps {
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
  onPlaceBets: (bets: Pick<RouletteBetItem, 'kind' | 'number' | 'amount'>[]) => Promise<void>;
  onFireInteractive: (targetUserId: string) => Promise<void>;
}

export function RouletteTable({
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
  onPlaceBets,
  onFireInteractive,
}: RouletteTableProps) {
  const { balance } = useWallet();
  const { sound } = useSound();
  const { t } = useI18n();

  const tableMinBet = Math.max(room.min_bet || 0, 50);
  const [selectedChip, setSelectedChip] = useState<number>(() => (tableMinBet >= 500 ? 500 : 100));
  const [draftBets, setDraftBets] = useState<Pick<RouletteBetItem, 'kind' | 'number' | 'amount'>[]>([]);
  const [wheelDeg, setWheelDeg] = useState<number>(0);
  const [wheelSpinning, setWheelSpinning] = useState(false);

  const prevRoundRef = useRef<number>(gameState?.state?.round_number ?? 0);
  const stopBallSoundRef = useRef<(() => void) | null>(null);

  const phase = gameState?.phase ?? 'lobby';
  const roundNumber = gameState?.state?.round_number ?? 0;
  const winningNumber =
    typeof gameState?.state?.winning_number === 'number' ? gameState.state.winning_number : null;
  const winningColor = gameState?.state?.winning_color ?? null;
  const ticketsMap = (gameState?.state?.tickets ?? {}) as Record<string, RouletteTicketState>;
  const myTicket = currentUserId ? ticketsMap[currentUserId] : undefined;
  const history = useMemo(
    () => ((gameState?.state?.history ?? []) as RouletteHistoryEntry[]).filter((h) => typeof h.number === 'number'),
    [gameState?.state?.history],
  );

  useEffect(() => {
    if (phase === 'settled' && winningNumber !== null && roundNumber > prevRoundRef.current) {
      prevRoundRef.current = roundNumber;
      const pocketIdx = Math.max(0, EUROPEAN_WHEEL_ORDER.indexOf(winningNumber));
      const pocketAngle = pocketIdx * (360 / 37);

      setWheelSpinning(true);
      setWheelDeg((prev) => {
        const base = Math.ceil(prev / 360) * 360 + 1440;
        return base - pocketAngle;
      });

      stopBallSoundRef.current?.();
      stopBallSoundRef.current = sound.playRouletteBall(2450);

      const timer = window.setTimeout(() => {
        setWheelSpinning(false);
        if (myTicket && myTicket.total_bet > 0) {
          if (myTicket.payout > 0) {
            sound.play('win');
          } else {
            sound.play('lose');
          }
        }
      }, 2500);

      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [phase, winningNumber, roundNumber, sound, myTicket]);

  useEffect(() => {
    return () => {
      stopBallSoundRef.current?.();
    };
  }, []);

  const draftTotal = useMemo(() => draftBets.reduce((acc, b) => acc + b.amount, 0), [draftBets]);

  const draftByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of draftBets) {
      const k = betKey(b.kind, b.number);
      map.set(k, (map.get(k) ?? 0) + b.amount);
    }
    return map;
  }, [draftBets]);

  const canPlaceBets =
    Boolean(currentUserId) &&
    !wheelSpinning &&
    (phase === 'lobby' ||
      phase === 'settled' ||
      phase === 'awaiting_players' ||
      (phase === 'betting' && (!myTicket || myTicket.status === 'betting' || myTicket.status === 'skipped_afk')));

  const isMyTurn = Boolean(currentUserId && gameState?.turn_user_id === currentUserId);
  const turnPlayer = seats.find((s) => s.user_id === gameState?.turn_user_id) ?? null;
  const turnSeconds = turnRemainingMs !== null ? (turnRemainingMs / 1000).toFixed(1) : null;
  const turnProgressPct =
    turnRemainingMs !== null ? Math.min(100, Math.max(0, (turnRemainingMs / 15000) * 100)) : 0;

  function addBet(kind: RouletteBetKind, num: number | null = null) {
    if (!canPlaceBets || actionBusy) return;
    if (balance !== null && draftTotal + selectedChip > balance) return;

    sound.play('chipClick');
    setDraftBets((prev) => {
      const idx = prev.findIndex((b) => b.kind === kind && b.number === num);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], amount: copy[idx].amount + selectedChip };
        return copy;
      }
      return [...prev, { kind, number: num, amount: selectedChip }];
    });
  }

  function undoLastBet() {
    sound.play('uiClick');
    setDraftBets((prev) => prev.slice(0, -1));
  }

  function clearBets() {
    sound.play('uiClick');
    setDraftBets([]);
  }

  function doubleBets() {
    if (draftBets.length === 0) return;
    if (balance !== null && draftTotal * 2 > balance) return;
    sound.play('chipStack');
    setDraftBets((prev) => prev.map((b) => ({ ...b, amount: b.amount * 2 })));
  }

  async function submitSpin() {
    if (draftBets.length === 0 || draftTotal < tableMinBet) return;
    await onPlaceBets(draftBets);
    setDraftBets([]);
  }

  const rows: number[][] = [
    Array.from({ length: 12 }, (_, i) => (i + 1) * 3),
    Array.from({ length: 12 }, (_, i) => i * 3 + 2),
    Array.from({ length: 12 }, (_, i) => i * 3 + 1),
  ];

  return (
    <section className="table-felt casino-oval-felt rl-felt" aria-label="European Roulette table">
      {/* Top Bar: RTP Info & Recent Winning Numbers Marquee */}
      <div className="rl-top-bar">
        <div>
          <span className="eyebrow">{t('rl.eyebrow')}</span>
          <div className="muted small">{t('rl.payouts')}</div>
        </div>

        <div className="rl-history-strip" aria-label="Recent winning numbers">
          <span className="muted small">{t('rl.lastSpins')}</span>
          {history.length === 0 ? (
            <span className="muted small">{t('rl.noSpins')}</span>
          ) : (
            history.map((h, i) => (
              <span
                key={`${h.round}-${i}`}
                className={`rl-history-pill rl-history-pill--${h.color} tabular`}
                title={`Spin #${h.round}: ${h.number} (${h.color.toUpperCase()})`}
              >
                {h.number}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Main Wheel + Interactive Betting Grid Layout */}
      <div className="rl-stage-grid">
        {/* Left: Vector European Wheel & Result Callout */}
        <div className="rl-wheel-panel">
          <EuropeanRouletteWheelSvg
            rotationDeg={wheelDeg}
            winningNumber={winningNumber}
            spinning={wheelSpinning}
          />

          <div className="rl-result-box">
            {wheelSpinning ? (
              <span className="gold-text">{t('rl.ballRolling')}</span>
            ) : winningNumber !== null && winningColor ? (
              <div className="rl-winning-callout">
                <span className={`rl-history-pill rl-history-pill--${winningColor} rl-history-pill--lg tabular`}>
                  {winningNumber}
                </span>
                <div>
                  <div className="eyebrow">
                    {t('rl.winningPocket')} #{roundNumber}
                  </div>
                  <strong>
                    {winningNumber} {winningColor.toUpperCase()}
                    {winningNumber > 0 ? (winningNumber % 2 === 0 ? ' · EVEN' : ' · ODD') : ' · ZERO'}
                  </strong>
                </div>
              </div>
            ) : (
              <span className="muted small">{t('rl.placeChipsPrompt')}</span>
            )}
          </div>
        </div>

        {/* Right: Interactive European Betting Board */}
        <div className="rl-board-panel">
          <div className="rl-board" role="group" aria-label="Roulette betting board">
            {/* Zero Column */}
            <button
              type="button"
              className={`rl-cell rl-cell--zero${
                !wheelSpinning && winningNumber === 0 ? ' is-winning-cell' : ''
              }`}
              onClick={() => addBet('straight', 0)}
              disabled={!canPlaceBets || actionBusy}
              data-silent
            >
              <span className="rl-cell__num">0</span>
              {draftByKey.get('straight:0') && (
                <span className="rl-chip-marker tabular">{formatChips(draftByKey.get('straight:0'))}</span>
              )}
            </button>

            {/* 3×12 Numbers + 2:1 Column Bets */}
            <div className="rl-numbers-matrix">
              {rows.map((rowNums, rIdx) => {
                const colKind: RouletteBetKind = rIdx === 0 ? 'col_3' : rIdx === 1 ? 'col_2' : 'col_1';
                const colKey = betKey(colKind, null);
                return (
                  <div key={`row-${rIdx}`} className="rl-numbers-row">
                    {rowNums.map((num) => {
                      const col = pocketColor(num);
                      const k = betKey('straight', num);
                      const amt = draftByKey.get(k);
                      const isWinner = !wheelSpinning && winningNumber === num;
                      return (
                        <button
                          key={num}
                          type="button"
                          className={`rl-cell rl-cell--${col}${isWinner ? ' is-winning-cell' : ''}`}
                          onClick={() => addBet('straight', num)}
                          disabled={!canPlaceBets || actionBusy}
                          data-silent
                        >
                          <span className="rl-cell__num tabular">{num}</span>
                          {amt && <span className="rl-chip-marker tabular">{formatChips(amt)}</span>}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="rl-cell rl-cell--outside"
                      onClick={() => addBet(colKind, null)}
                      disabled={!canPlaceBets || actionBusy}
                      title="Column Bet (Pays 2 to 1)"
                      data-silent
                    >
                      <span>2:1</span>
                      {draftByKey.get(colKey) && (
                        <span className="rl-chip-marker tabular">{formatChips(draftByKey.get(colKey))}</span>
                      )}
                    </button>
                  </div>
                );
              })}

              {/* Dozens Row (Pays 2:1) */}
              <div className="rl-outside-row rl-outside-row--dozens">
                {(
                  [
                    { kind: 'dozen_1', label: '1st 12 (1–12)' },
                    { kind: 'dozen_2', label: '2nd 12 (13–24)' },
                    { kind: 'dozen_3', label: '3rd 12 (25–36)' },
                  ] as const
                ).map((d) => {
                  const amt = draftByKey.get(d.kind);
                  return (
                    <button
                      key={d.kind}
                      type="button"
                      className="rl-cell rl-cell--outside"
                      onClick={() => addBet(d.kind, null)}
                      disabled={!canPlaceBets || actionBusy}
                      data-silent
                    >
                      <span>{d.label}</span>
                      {amt && <span className="rl-chip-marker tabular">{formatChips(amt)}</span>}
                    </button>
                  );
                })}
              </div>

              {/* Even-Money Outside Row (Pays 1:1) */}
              <div className="rl-outside-row rl-outside-row--evenmoney">
                {(
                  [
                    { kind: 'low', label: '1–18 Low', cls: '' },
                    { kind: 'even', label: 'EVEN', cls: '' },
                    { kind: 'red', label: '◆ RED', cls: 'rl-cell--red' },
                    { kind: 'black', label: '◆ BLACK', cls: 'rl-cell--black' },
                    { kind: 'odd', label: 'ODD', cls: '' },
                    { kind: 'high', label: '19–36 High', cls: '' },
                  ] as const
                ).map((o) => {
                  const amt = draftByKey.get(o.kind);
                  return (
                    <button
                      key={o.kind}
                      type="button"
                      className={`rl-cell rl-cell--outside ${o.cls}`.trim()}
                      onClick={() => addBet(o.kind, null)}
                      disabled={!canPlaceBets || actionBusy}
                      data-silent
                    >
                      <span>{o.label}</span>
                      {amt && <span className="rl-chip-marker tabular">{formatChips(amt)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Chip Selector & Spin Action Bar */}
          <div className="rl-controls-bar">
            <div className="bj-chip-rack" role="radiogroup" aria-label="Select chip value">
              {CHIP_DENOMINATIONS.map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`bj-chip-btn${selectedChip === val ? ' is-selected-chip' : ''}`}
                  onClick={() => {
                    sound.play('chipClick');
                    setSelectedChip(val);
                  }}
                  data-silent
                  title={`Select ${formatChips(val)} chip`}
                >
                  <CasinoChipSvg value={val} size={46} />
                </button>
              ))}
            </div>

            <div className="bj-wager-bar">
              <div className="bj-wager-display">
                <span className="muted small">
                  {t('bj.yourWager')} ({t('room.min')} {formatChips(tableMinBet)})
                </span>
                <strong className="bj-wager-display__amount tabular">
                  {formatChips(draftTotal)} {t('room.chips')}
                </strong>
              </div>

              <div className="row">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={undoLastBet}
                  disabled={draftBets.length === 0 || actionBusy || wheelSpinning}
                  data-silent
                >
                  {t('rl.undo')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={clearBets}
                  disabled={draftBets.length === 0 || actionBusy || wheelSpinning}
                  data-silent
                >
                  {t('rl.clear')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={doubleBets}
                  disabled={
                    draftBets.length === 0 ||
                    actionBusy ||
                    wheelSpinning ||
                    (balance !== null && draftTotal * 2 > balance)
                  }
                  data-silent
                >
                  {t('rl.doubleSlip')}
                </button>
                <button
                  type="button"
                  className="btn btn--gold"
                  onClick={() => void submitSpin()}
                  disabled={
                    !canPlaceBets ||
                    actionBusy ||
                    wheelSpinning ||
                    draftTotal < tableMinBet ||
                    (balance !== null && draftTotal > balance)
                  }
                >
                  {actionBusy || wheelSpinning
                    ? t('rl.spinning')
                    : phase === 'betting'
                      ? `${t('rl.lockInBets')} (${formatChips(draftTotal)})`
                      : `${t('rl.spinWheel')} ${formatChips(draftTotal)}`}
                </button>
                {seats.length > 1 && (phase === 'lobby' || phase === 'settled') && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void onStartRound()}
                    disabled={actionBusy || wheelSpinning}
                  >
                    {t('room.openTableBetting')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 15s Turn Timer & Outcome Banner */}
      {turnPlayer && turnSeconds !== null && (
        <div className="table-felt__center">
          <div className="turn-spotlight">
            <div className="turn-spotlight__title">
              {isMyTurn ? (
                <span className="gold-text">{t('bj.yourTurnBet')}</span>
              ) : (
                <span>{t('bj.awaitingBet', { player: turnPlayer.username })}</span>
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
        </div>
      )}

      {!wheelSpinning && phase === 'settled' && myTicket && myTicket.total_bet > 0 && (
        <div
          className={`bj-outcome-banner ${
            myTicket.payout > 0 ? 'bj-outcome-banner--win' : 'bj-outcome-banner--lose'
          }`}
          role="status"
        >
          {myTicket.payout > 0 ? (
            <>
              <strong>
                ROULETTE PAYOUT: {formatChips(myTicket.payout)} {t('room.chips').toUpperCase()}!
              </strong>
              <span>
                Wagered {formatChips(myTicket.total_bet)} · Net:{' '}
                {myTicket.net >= 0 ? `+${formatChips(myTicket.net)}` : formatChips(myTicket.net)}
              </span>
            </>
          ) : (
            <>
              <strong>NO WINNING BETS ON #{winningNumber}</strong>
              <span>-{formatChips(myTicket.total_bet)} {t('room.chips')}</span>
            </>
          )}
        </div>
      )}

      {/* Seated Players & Tickets */}
      <div className="seats-grid seats-grid--arc">
        {seats.map((seat) => {
          const isTurn = gameState?.turn_user_id === seat.user_id;
          const isMe = currentUserId === seat.user_id;
          const tkt = ticketsMap[seat.user_id];
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
                  {room.host_id === seat.user_id && <span className="badge">{t('room.host')}</span>}
                  {seat.status === 'afk' ? (
                    <span className="badge badge--timeout">AFK</span>
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
                    {tkt && tkt.total_bet > 0
                      ? `${formatChips(tkt.total_bet)} ${t('room.chips')}`
                      : t('room.tableReady')}
                  </span>
                </div>
                <img
                  src={cardBackUrl}
                  alt="Equipped card back"
                  className="seat-card__cardback"
                  width={24}
                  height={34}
                  draggable={false}
                />
              </div>

              {tkt && tkt.bets.length > 0 && (
                <div className="bj-seat-hand">
                  <div className="rl-ticket-list">
                    {tkt.bets.slice(0, 4).map((b, idx) => (
                      <span
                        key={idx}
                        className={`badge ${b.won ? 'badge--bj-win' : ''}`}
                      >
                        {formatBetLabel(b)}: {formatChips(b.amount)}
                      </span>
                    ))}
                    {tkt.bets.length > 4 && <span className="muted small">+{tkt.bets.length - 4} more</span>}
                  </div>
                  {phase === 'settled' && !wheelSpinning && (
                    <div className="bj-seat-outcome">
                      <span className={`badge ${tkt.payout > 0 ? 'badge--bj-win' : 'badge--timeout'}`}>
                        {tkt.payout > 0
                          ? `+${formatChips(tkt.payout)} (Net +${formatChips(tkt.net)})`
                          : `-${formatChips(tkt.total_bet)}`}
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
