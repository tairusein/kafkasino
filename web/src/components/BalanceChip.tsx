import { useEffect, useRef, useState } from 'react';
import { formatChips } from '../lib/format';
import { useWallet } from '../wallet/WalletProvider';

/**
 * Header balance (read-only mirror of the server balance).
 * Smoothly counts up/down via requestAnimationFrame whenever the server balance changes.
 */
export function BalanceChip() {
  const { balance } = useWallet();
  const [displayed, setDisplayed] = useState<number | null>(balance);
  const [pulsing, setPulsing] = useState(false);
  const prevRef = useRef<number | null>(null);

  useEffect(() => {
    if (balance === null) {
      setDisplayed(null);
      prevRef.current = null;
      return;
    }
    const from = prevRef.current;
    prevRef.current = balance;

    if (from === null || from === balance) {
      setDisplayed(balance);
      return;
    }

    if (balance > from) setPulsing(true);

    const start = performance.now();
    const duration = 680;
    let raf = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Cubic ease-out
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(Math.round(from + (balance - from) * eased));
      if (t < 1) {
        raf = window.requestAnimationFrame(step);
      } else {
        setDisplayed(balance);
        setPulsing(false);
      }
    };

    raf = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(raf);
      setPulsing(false);
    };
  }, [balance]);

  return (
    <div
      className={`balance-chip${pulsing ? ' balance-chip--pulse' : ''}`}
      title="Your balance"
      aria-label={`Balance ${formatChips(balance)} chips`}
    >
      <svg className="balance-chip__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <circle cx="12" cy="12" r="10.5" fill="#6b1424" stroke="#c9a24b" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="6.6" fill="none" stroke="#c9a24b" strokeWidth="1" strokeDasharray="2.2 2.2" />
        <circle cx="12" cy="12" r="2.2" fill="#c9a24b" />
      </svg>
      <span className="balance-chip__value">{formatChips(displayed)}</span>
    </div>
  );
}
