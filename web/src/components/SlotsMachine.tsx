import { useEffect, useMemo, useRef, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { formatChips } from '../lib/format';
import type { GameStateRow, Room, SlotHistoryEntry, SlotSymbol } from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';
import { CasinoChipSvg } from './PlayingCardSvg';

const CHIP_DENOMINATIONS = [50, 100, 250, 500, 1000, 5000] as const;

const SYMBOL_LABELS: Record<SlotSymbol, string> = {
  crown: 'Imperial Crown',
  seven: 'Gold Seven',
  diamond: 'Burgundy Diamond',
  bell: 'Liberty Bell',
  bar: 'Bullion BAR',
  cherry: 'Vintage Cherry',
};

const PAYTABLE_ROWS: readonly {
  tier: string;
  symbols: [SlotSymbol, SlotSymbol, SlotSymbol | 'any'];
  label: string;
  multiplier: number;
  combos: string;
}[] = [
  { tier: 'grand_jackpot', symbols: ['crown', 'crown', 'crown'], label: '3× Imperial Crown', multiplier: 250, combos: '1 / 8,000' },
  { tier: 'triple_seven', symbols: ['seven', 'seven', 'seven'], label: '3× Gold Seven', multiplier: 80, combos: '8 / 8,000' },
  { tier: 'triple_diamond', symbols: ['diamond', 'diamond', 'diamond'], label: '3× Burgundy Diamond', multiplier: 35, combos: '27 / 8,000' },
  { tier: 'triple_bell', symbols: ['bell', 'bell', 'bell'], label: '3× Liberty Bell', multiplier: 18, combos: '64 / 8,000' },
  { tier: 'triple_bar', symbols: ['bar', 'bar', 'bar'], label: '3× Bullion BAR', multiplier: 10, combos: '125 / 8,000' },
  { tier: 'triple_cherry', symbols: ['cherry', 'cherry', 'cherry'], label: '3× Vintage Cherry', multiplier: 8, combos: '125 / 8,000' },
  { tier: 'double_cherry', symbols: ['cherry', 'cherry', 'any'], label: 'Any 2× Vintage Cherry', multiplier: 2, combos: '1,125 / 8,000' },
  { tier: 'single_cherry', symbols: ['cherry', 'bar', 'any'], label: 'Reel 1 Vintage Cherry', multiplier: 1, combos: '1,125 / 8,000' },
] as const;

/** Crisp vector (SVG) artwork for each of the 6 vintage slot machine symbols. */
export function SlotSymbolSvg({ symbol, size = 78 }: { symbol: SlotSymbol; size?: number }) {
  switch (symbol) {
    case 'crown':
      return (
        <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="Imperial Crown">
          <circle cx="48" cy="48" r="42" fill="#231218" stroke="#c9a24b" strokeWidth="2" />
          <path
            d="M20 64 L26 32 L40 46 L48 24 L56 46 L70 32 L76 64 Z"
            fill="#d9b863"
            stroke="#6b1424"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <rect x="22" y="64" width="52" height="9" rx="3" fill="#8b182c" stroke="#e8cf8f" strokeWidth="1.8" />
          <circle cx="48" cy="21" r="4" fill="#f5df9e" />
          <circle cx="25" cy="29" r="3.2" fill="#8b182c" stroke="#f5df9e" strokeWidth="1.2" />
          <circle cx="71" cy="29" r="3.2" fill="#8b182c" stroke="#f5df9e" strokeWidth="1.2" />
        </svg>
      );
    case 'seven':
      return (
        <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="Gold Seven">
          <circle cx="48" cy="48" r="42" fill="#1b1b21" stroke="#c9a24b" strokeWidth="2" />
          <path
            d="M26 24 H72 L45 76 H33 L57 34 H26 Z"
            fill="#e8cf8f"
            stroke="#8b182c"
            strokeWidth="3"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'diamond':
      return (
        <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="Burgundy Diamond">
          <circle cx="48" cy="48" r="42" fill="#1b1b21" stroke="#c9a24b" strokeWidth="2" />
          <polygon
            points="48,16 74,40 48,80 22,40"
            fill="#8b182c"
            stroke="#f5df9e"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <polyline points="22,40 74,40" stroke="#e8cf8f" strokeWidth="1.6" />
          <polyline points="35,28 48,40 61,28" fill="none" stroke="#e8cf8f" strokeWidth="1.4" />
          <polyline points="36,40 48,80 60,40" fill="none" stroke="#e8cf8f" strokeWidth="1.4" />
        </svg>
      );
    case 'bell':
      return (
        <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="Liberty Bell">
          <circle cx="48" cy="48" r="42" fill="#1b1b21" stroke="#c9a24b" strokeWidth="2" />
          <circle cx="48" cy="21" r="4.5" fill="none" stroke="#e8cf8f" strokeWidth="2.4" />
          <path
            d="M32 42 C32 28 64 28 64 42 L72 64 H24 Z"
            fill="#d9b863"
            stroke="#6b1424"
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path d="M46 42 L43 55 L48 64" fill="none" stroke="#16161a" strokeWidth="2" strokeLinecap="round" />
          <circle cx="48" cy="69" r="6" fill="#8b182c" stroke="#e8cf8f" strokeWidth="1.8" />
        </svg>
      );
    case 'bar':
      return (
        <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="Bullion BAR">
          <circle cx="48" cy="48" r="42" fill="#1b1b21" stroke="#c9a24b" strokeWidth="2" />
          <rect
            x="16"
            y="32"
            width="64"
            height="32"
            rx="5"
            fill="#16161a"
            stroke="#e8cf8f"
            strokeWidth="2.5"
          />
          <rect x="20" y="36" width="56" height="24" rx="3" fill="none" stroke="#8b182c" strokeWidth="1.5" />
          <text
            x="48"
            y="54"
            textAnchor="middle"
            fill="#f5df9e"
            fontFamily="Cormorant Garamond, Georgia, serif"
            fontSize="20"
            fontWeight="700"
            letterSpacing="3"
          >
            BAR
          </text>
        </svg>
      );
    case 'cherry':
      return (
        <svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="Vintage Cherry">
          <circle cx="48" cy="48" r="42" fill="#1b1b21" stroke="#c9a24b" strokeWidth="2" />
          <path
            d="M35 54 C36 36 46 26 56 22 M61 56 C60 38 54 28 56 22"
            fill="none"
            stroke="#c9a24b"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path d="M56 22 C64 18 70 22 66 28 C60 30 56 26 56 22 Z" fill="#2e7d52" stroke="#e8cf8f" strokeWidth="1.2" />
          <circle cx="34" cy="60" r="13" fill="#8b182c" stroke="#f5df9e" strokeWidth="2" />
          <circle cx="62" cy="62" r="13" fill="#a11b32" stroke="#f5df9e" strokeWidth="2" />
          <circle cx="30" cy="56" r="3" fill="#f7f1e3" opacity="0.65" />
          <circle cx="58" cy="58" r="3" fill="#f7f1e3" opacity="0.65" />
        </svg>
      );
  }
}

interface SlotsMachineProps {
  room: Room;
  gameState: GameStateRow | null;
  actionBusy: boolean;
  onSpin: (bet: number) => Promise<void>;
}

export function SlotsMachine({ room, gameState, actionBusy, onSpin }: SlotsMachineProps) {
  const { balance } = useWallet();
  const { sound } = useSound();

  const tableMinBet = Math.max(room.min_bet || 0, 50);
  const [wager, setWager] = useState<number>(tableMinBet);

  // Visual reel state for staggered mechanical stopping
  const [displayedReels, setDisplayedReels] = useState<[SlotSymbol, SlotSymbol, SlotSymbol]>([
    'crown',
    'seven',
    'diamond',
  ]);
  const [reelSpinning, setReelSpinning] = useState<[boolean, boolean, boolean]>([false, false, false]);
  const [settledBannerVisible, setSettledBannerVisible] = useState(false);

  const stopRattleRef = useRef<(() => void) | null>(null);
  const timersRef = useRef<number[]>([]);
  const prevRoundRef = useRef<number>(gameState?.state?.round_number ?? 0);

  useEffect(() => {
    setWager((prev) => (prev < tableMinBet ? tableMinBet : prev));
  }, [tableMinBet]);

  const serverRound = gameState?.state?.round_number ?? 0;
  const serverReels = gameState?.state?.reels as [SlotSymbol, SlotSymbol, SlotSymbol] | undefined;
  const serverMultiplier = gameState?.state?.multiplier ?? 0;
  const serverPayout = gameState?.state?.payout ?? 0;
  const serverNet = gameState?.state?.net ?? 0;
  const serverBet = gameState?.state?.bet ?? wager;
  const serverTier = gameState?.state?.tier ?? 'no_win';

  const history = useMemo(
    () => ((gameState?.state?.history ?? []) as SlotHistoryEntry[]).filter((h) => Array.isArray(h.reels)),
    [gameState?.state?.history],
  );

  // Sync displayed reels on initial mount if a spin already exists on the room.
  useEffect(() => {
    if (serverReels && serverReels.length === 3 && prevRoundRef.current === serverRound) {
      setDisplayedReels(serverReels);
    }
  }, [serverReels, serverRound]);

  // Staggered reel-stop sequence when a new server round arrives.
  useEffect(() => {
    if (!serverReels || serverReels.length !== 3 || serverRound <= prevRoundRef.current) return;
    prevRoundRef.current = serverRound;

    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];

    const t1 = window.setTimeout(() => {
      setDisplayedReels((prev) => [serverReels[0], prev[1], prev[2]]);
      setReelSpinning([false, true, true]);
      sound.play('slotStop');
    }, 360);

    const t2 = window.setTimeout(() => {
      setDisplayedReels((prev) => [serverReels[0], serverReels[1], prev[2]]);
      setReelSpinning([false, false, true]);
      sound.play('slotStop');
    }, 680);

    const t3 = window.setTimeout(() => {
      setDisplayedReels([serverReels[0], serverReels[1], serverReels[2]]);
      setReelSpinning([false, false, false]);
      stopRattleRef.current?.();
      stopRattleRef.current = null;
      sound.play('slotStop');
      setSettledBannerVisible(true);

      if (serverMultiplier > 1) {
        sound.play('win');
      } else if (serverMultiplier === 1) {
        sound.play('notify');
      } else {
        sound.play('lose');
      }
    }, 1000);

    timersRef.current = [t1, t2, t3];
  }, [serverRound, serverReels, serverMultiplier, sound]);

  useEffect(() => {
    return () => {
      stopRattleRef.current?.();
      timersRef.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const isAnyReelSpinning = reelSpinning[0] || reelSpinning[1] || reelSpinning[2];

  async function handleSpin() {
    if (actionBusy || isAnyReelSpinning) return;
    if (balance !== null && wager > balance) return;

    setSettledBannerVisible(false);
    setReelSpinning([true, true, true]);
    stopRattleRef.current?.();
    stopRattleRef.current = sound.startSlotSpin();

    try {
      await onSpin(wager);
    } catch (err) {
      stopRattleRef.current?.();
      stopRattleRef.current = null;
      setReelSpinning([false, false, false]);
      throw err;
    }
  }

  return (
    <section className="table-felt slots-felt" aria-label="Vintage 3-reel slot machine">
      <div className="slots-layout">
        {/* Left: Vintage 3-Reel Mechanical Cabinet */}
        <div className="slots-cabinet">
          <header className="slots-cabinet__crest">
            <span className="eyebrow">The Imperial Automat · Est. 1924</span>
            <h2 className="slots-cabinet__title">Sovereign Three-Reel</h2>
            <span className="badge tabular">RTP: 94.53% · House Edge: 5.47%</span>
          </header>

          {/* 3 Mechanical Reel Windows with Center Payline */}
          <div className="slots-window-frame">
            <div className="slots-payline-marker slots-payline-marker--left">PAYLINE ▸</div>
            <div className="slots-payline-marker slots-payline-marker--right">◂ PAYLINE</div>
            <div className="slots-payline-rule" aria-hidden="true" />

            <div className="slots-reels-grid">
              {[0, 1, 2].map((idx) => {
                const sym = displayedReels[idx] ?? 'crown';
                const spinning = reelSpinning[idx];
                return (
                  <div
                    key={idx}
                    className={`slots-reel-box${spinning ? ' is-spinning' : ''}${
                      settledBannerVisible && serverMultiplier > 0 ? ' is-winning-reel' : ''
                    }`}
                  >
                    <div className="slots-reel-box__symbol">
                      <SlotSymbolSvg symbol={sym} size={86} />
                    </div>
                    <span className="slots-reel-box__caption">
                      {spinning ? 'SPINNING…' : SYMBOL_LABELS[sym]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Outcome Readout Plate */}
          <div className="slots-readout" role="status" aria-live="polite">
            {isAnyReelSpinning ? (
              <span className="gold-text">Reels in motion…</span>
            ) : settledBannerVisible && serverRound > 0 ? (
              serverMultiplier > 1 ? (
                <div className="slots-readout__win">
                  <strong>
                    WINNER! {serverMultiplier}× PAYOUT — +{formatChips(serverPayout)} CHIPS
                  </strong>
                  <span className="muted small">
                    Spin #{serverRound} · Net Profit: +{formatChips(serverNet)} Chips
                  </span>
                </div>
              ) : serverMultiplier === 1 ? (
                <div className="slots-readout__push">
                  <strong>REEL 1 CHERRY — 1× PUSH ({formatChips(serverPayout)} CHIPS RETURNED)</strong>
                  <span className="muted small">Spin #{serverRound} · Wager refunded</span>
                </div>
              ) : (
                <div className="slots-readout__lose">
                  <span>Spin #{serverRound} · No payline match (-{formatChips(serverBet)} chips)</span>
                </div>
              )
            ) : (
              <span className="muted small">Select your chip wager and pull the handle to spin.</span>
            )}
          </div>

          {/* Wager Selector & Spin Handle */}
          <div className="bj-betting-console">
            <div className="bj-chip-rack" role="group" aria-label="Select spin wager">
              {CHIP_DENOMINATIONS.map((val) => (
                <button
                  key={val}
                  type="button"
                  className={`bj-chip-btn${wager === val ? ' is-selected-chip' : ''}`}
                  onClick={() => {
                    sound.play('chipClick');
                    setWager(Math.max(tableMinBet, val));
                  }}
                  disabled={actionBusy || isAnyReelSpinning || (balance !== null && balance < val)}
                  data-silent
                  title={`Set spin wager to ${formatChips(val)} chips`}
                >
                  <CasinoChipSvg value={val} size={44} />
                </button>
              ))}
            </div>

            <div className="bj-wager-bar">
              <div className="bj-wager-display">
                <span className="muted small">Spin Wager (Min {formatChips(tableMinBet)})</span>
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
                  disabled={actionBusy || isAnyReelSpinning || wager === tableMinBet}
                  data-silent
                >
                  Min
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    sound.play('chipClick');
                    setWager((prev) => Math.min(100000, balance !== null ? Math.min(balance, prev * 2) : prev * 2));
                  }}
                  disabled={actionBusy || isAnyReelSpinning || (balance !== null && wager * 2 > balance)}
                  data-silent
                >
                  2× Wager
                </button>
                <button
                  type="button"
                  className="btn btn--gold slots-spin-btn"
                  onClick={() => void handleSpin()}
                  disabled={
                    actionBusy ||
                    isAnyReelSpinning ||
                    wager < tableMinBet ||
                    (balance !== null && wager > balance)
                  }
                  data-silent
                >
                  {isAnyReelSpinning ? 'Spinning Reels…' : `Pull Handle · Spin (${formatChips(wager)})`}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Brass Paytable & Mathematical RTP Breakdown */}
        <aside className="slots-paytable" aria-label="Slot machine paytable and RTP mathematics">
          <div className="slots-paytable__head">
            <span className="eyebrow">Certified Paytable · 20³ = 8,000 Stops</span>
            <h3>Payout Multipliers</h3>
          </div>

          <ul className="slots-paytable__list">
            {PAYTABLE_ROWS.map((row) => {
              const isHit = settledBannerVisible && serverTier === row.tier;
              return (
                <li
                  key={row.tier}
                  className={`slots-paytable__row${isHit ? ' is-hit-tier' : ''}`}
                >
                  <div className="slots-paytable__icons">
                    <SlotSymbolSvg symbol={row.symbols[0]} size={26} />
                    {row.tier === 'single_cherry' ? (
                      <span className="muted small">on Reel 1</span>
                    ) : (
                      <>
                        <SlotSymbolSvg symbol={row.symbols[1]} size={26} />
                        {row.symbols[2] !== 'any' ? (
                          <SlotSymbolSvg symbol={row.symbols[2]} size={26} />
                        ) : (
                          <span className="muted small">Any</span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="slots-paytable__meta">
                    <strong>{row.label}</strong>
                    <span className="muted small tabular">{row.combos}</span>
                  </div>
                  <span className="badge badge--open tabular">{row.multiplier}×</span>
                </li>
              );
            })}
          </ul>

          {history.length > 0 && (
            <div className="slots-history">
              <span className="eyebrow">Recent Spins</span>
              <div className="slots-history__list">
                {history.slice(0, 5).map((h) => (
                  <div key={h.round} className="slots-history__item tabular">
                    <span className="muted small">#{h.round}</span>
                    <span>
                      {h.reels.map((s) => SYMBOL_LABELS[s]?.split(' ').pop()).join(' · ')}
                    </span>
                    <span className={h.payout > 0 ? 'gold-text' : 'muted small'}>
                      {h.payout > 0 ? `+${formatChips(h.payout)} (${h.multiplier}×)` : `-${formatChips(h.bet)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

