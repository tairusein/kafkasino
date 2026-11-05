import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { usePresenceReady } from '../presence/PresenceProvider';

/**
 * Premium Global Loader (Initial State)
 *
 * Covers the viewport with a solid dark graphite/black backdrop and a smoothly
 * pulsing gold "Kafkasino" emblem while initial Supabase Auth, user profile/RBAC,
 * and Realtime Presence handshake complete. Fades out gracefully with zero layout shift.
 */
export function GlobalLoader() {
  const { loading: authLoading, user, pendingRecoveryAck } = useAuth();
  const presenceReady = usePresenceReady();

  // Wait for auth + profile resolution, and if signed in, initial Realtime presence connection.
  // Never cover the Recovery Phrase backup modal right after registration.
  const isBooting = !pendingRecoveryAck && (authLoading || (Boolean(user) && !presenceReady));

  const [visible, setVisible] = useState(true);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    if (isBooting) {
      setVisible(true);
      setFadingOut(false);
      return;
    }

    // Brief settle frame so underlying route DOM is painted before fade-out begins.
    const fadeTimer = window.setTimeout(() => {
      setFadingOut(true);
    }, 120);

    const unmountTimer = window.setTimeout(() => {
      setVisible(false);
    }, 800);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(unmountTimer);
    };
  }, [isBooting]);

  if (!visible) return null;

  return (
    <div
      className={`global-loader${fadingOut ? ' global-loader--hidden' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Loading Kafkasino"
    >
      <div className="global-loader__inner">
        <div className="global-loader__crest" aria-hidden="true">
          <svg viewBox="0 0 80 80" width={68} height={68}>
            <defs>
              <linearGradient id="kafkasino-loader-gold" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#f5df9e" />
                <stop offset="50%" stopColor="#c9a24b" />
                <stop offset="100%" stopColor="#8c6922" />
              </linearGradient>
            </defs>
            <polygon
              points="40,4 74,40 40,76 6,40"
              fill="#141418"
              stroke="url(#kafkasino-loader-gold)"
              strokeWidth="2.2"
            />
            <polygon
              points="40,12 66,40 40,68 14,40"
              fill="none"
              stroke="url(#kafkasino-loader-gold)"
              strokeWidth="0.9"
              strokeDasharray="3 3"
            />
            <path
              d="M40 21 C31 32 24 37 24 44 C24 49 28 52 32.5 52 C35.5 52 37.8 50.5 39 48.2 L36 56 H44 L41 48.2 C42.2 50.5 44.5 52 47.5 52 C52 52 56 49 56 44 C56 37 49 32 40 21 Z"
              fill="url(#kafkasino-loader-gold)"
            />
          </svg>
        </div>
        <div className="global-loader__wordmark">Kafkasino</div>
        <div className="global-loader__rule" aria-hidden="true" />
        <div className="global-loader__sub">Private Club &amp; Grand Salon</div>
      </div>
    </div>
  );
}
