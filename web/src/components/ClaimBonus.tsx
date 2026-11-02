import { useCallback, useEffect, useState } from 'react';
import { useSound } from '../audio/SoundProvider';
import { formatChips } from '../lib/format';
import { supabase } from '../lib/supabase';
import type { BonusClaimResult, BonusStatus } from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';

const COIN_INDICES = [0, 1, 2, 3, 4, 5] as const;

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Daily Bonus control displayed next to the user's balance in the global header.
 *
 * - Queries server-authoritative `get_bonus_status()` (resets at 03:00 AM server time).
 * - When claimable, renders the "Claim Bonus" button.
 * - On click: the button disappears immediately, a smooth vector coin-adding animation
 *   arcs into the balance chip, the wallet counts up, and a countdown timer to 03:00 AM
 *   replaces the button.
 */
export function ClaimBonus() {
  const { refresh: refreshWallet } = useWallet();
  const { sound } = useSound();

  const [canClaim, setCanClaim] = useState<boolean | null>(null);
  const [bonusAmount, setBonusAmount] = useState<number>(1000);
  const [nextResetMs, setNextResetMs] = useState<number | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [claiming, setClaiming] = useState(false);
  const [animatingBurst, setAnimatingBurst] = useState<number | null>(null);

  const loadStatus = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_bonus_status');
    if (error || !data) return;
    const status = data as BonusStatus;
    const serverTime = new Date(status.server_now).getTime();
    const resetTime = new Date(status.next_reset_at).getTime();
    if (!Number.isNaN(serverTime)) {
      setServerOffsetMs(serverTime - Date.now());
    }
    setCanClaim(Boolean(status.can_claim));
    setBonusAmount(Number(status.amount) || 1000);
    setNextResetMs(Number.isNaN(resetTime) ? null : resetTime);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Tick every second while waiting for the 03:00 AM reset.
  useEffect(() => {
    if (canClaim !== false) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (nextResetMs !== null && current + serverOffsetMs >= nextResetMs) {
        void loadStatus();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [canClaim, nextResetMs, serverOffsetMs, loadStatus]);

  async function onClaim() {
    if (claiming || !canClaim) return;
    setClaiming(true);
    // Button disappears immediately upon click.
    setCanClaim(false);

    const { data, error } = await supabase.rpc('claim_daily_bonus');
    if (error || !data) {
      // Re-sync with the server if already claimed in another tab or transient error.
      await loadStatus();
      setClaiming(false);
      return;
    }

    const res = data as BonusClaimResult;
    const serverTime = new Date(res.server_now).getTime();
    const resetTime = new Date(res.next_reset_at).getTime();
    if (!Number.isNaN(serverTime)) {
      setServerOffsetMs(serverTime - Date.now());
    }
    setNextResetMs(Number.isNaN(resetTime) ? null : resetTime);

    const granted = Number(res.amount) || bonusAmount;
    setAnimatingBurst(granted);
    sound.play('chipStack');
    window.setTimeout(() => sound.play('win'), 220);

    await refreshWallet();
    setClaiming(false);

    window.setTimeout(() => {
      setAnimatingBurst(null);
    }, 1250);
  }

  if (canClaim === null) return null;

  const remainingMs = nextResetMs !== null ? Math.max(0, nextResetMs - (nowMs + serverOffsetMs)) : 0;

  return (
    <div className="bonus-control">
      {animatingBurst !== null && (
        <div className="bonus-coin-burst" aria-hidden="true">
          {COIN_INDICES.map((idx) => (
            <svg
              key={idx}
              className={`bonus-coin bonus-coin--${idx}`}
              viewBox="0 0 24 24"
              width="18"
              height="18"
            >
              <circle cx="12" cy="12" r="10" fill="#d9b863" stroke="#6b1424" strokeWidth="2" />
              <circle cx="12" cy="12" r="6" fill="none" stroke="#16161a" strokeWidth="1" strokeDasharray="2 2" />
            </svg>
          ))}
          <span className="bonus-coin-burst__amount">+{formatChips(animatingBurst)}</span>
        </div>
      )}

      {canClaim ? (
        <button
          type="button"
          className="btn btn--gold btn--sm bonus-claim-btn"
          onClick={() => void onClaim()}
          disabled={claiming}
          data-silent
          title={`Claim your daily ${formatChips(bonusAmount)} chip bonus (resets daily at 03:00 AM)`}
        >
          Claim Bonus (+{formatChips(bonusAmount)})
        </button>
      ) : (
        <div
          className="bonus-countdown"
          role="timer"
          aria-label={`Next daily bonus at 03:00 AM, in ${formatHms(remainingMs)}`}
          title="Daily bonus resets at 03:00 AM"
        >
          <span className="bonus-countdown__label">03:00 Bonus</span>
          <span className="bonus-countdown__time tabular">{formatHms(remainingMs)}</span>
        </div>
      )}
    </div>
  );
}

