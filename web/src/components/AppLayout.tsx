import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useSound } from '../audio/SoundProvider';
import { LanguageSwitcher, useI18n } from '../i18n/I18nProvider';
import { formatChips, formatCountdown } from '../lib/format';
import { WalletProvider, useWallet } from '../wallet/WalletProvider';
import { Avatar } from './Avatar';
import { Link, NavLink, useNavigate } from './GuardLink';

export function AppLayout() {
  return (
    <WalletProvider>
      <AppLayoutInner />
    </WalletProvider>
  );
}

function AppLayoutInner() {
  const { user, profile, isAdmin, signOut } = useAuth();
  const {
    balance,
    canClaimBonus,
    secondsUntilBonus,
    bonusAmount,
    claimingBonus,
    lastClaimedAmount,
    claimDailyBonus,
  } = useWallet();
  const { sound, muted, volume, toggleMuted, setVolume } = useSound();
  const { t } = useI18n();
  const nav = useNavigate();

  // Drives the coin-burst flight animation whenever a bonus is claimed.
  const [burstKey, setBurstKey] = useState(0);
  useEffect(() => {
    if (lastClaimedAmount && lastClaimedAmount > 0) {
      setBurstKey((k) => k + 1);
    }
  }, [lastClaimedAmount]);

  async function handleClaimBonus() {
    const res = await claimDailyBonus();
    if (res.granted) {
      sound.play('bonus');
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand brand-lockup" aria-label="Kafkasino — home">
          <img src="/logo.svg" alt="" width={34} height={34} />
          <span>Kafkasino</span>
        </Link>

        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" end>
            {t('nav.home')}
          </NavLink>
          <NavLink to="/lobby">{t('nav.lobby')}</NavLink>
          <NavLink to="/tournaments">{t('nav.tournaments')}</NavLink>
          <NavLink to="/shop">{t('nav.shop')}</NavLink>
          {user && <NavLink to="/profile">{t('nav.profile')}</NavLink>}
          {isAdmin && <NavLink to="/admin">{t('nav.admin')}</NavLink>}
        </nav>

        <div className="app-header__right">
          <LanguageSwitcher />

          <div className="sound-toggle" role="group" aria-label="Sound controls">
            <button
              type="button"
              className="icon-btn"
              onClick={toggleMuted}
              aria-pressed={muted}
              aria-label={muted ? t('header.unmute') : t('header.mute')}
              title={muted ? t('header.unmute') : t('header.mute')}
              data-silent
            >
              {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label={t('header.volume')}
              className="sound-toggle__slider"
            />
          </div>

          {user && profile ? (
            <>
              <div className="balance-area">
                <div
                  className={`balance-chip${burstKey > 0 ? ' balance-chip--pulse' : ''}`}
                  title="Your chip balance"
                >
                  <CoinIcon />
                  <span className="balance-chip__value">{formatChips(balance)}</span>
                </div>

                <div className="bonus-control">
                  {canClaimBonus ? (
                    <button
                      type="button"
                      className="btn btn--gold btn--sm bonus-claim-btn"
                      onClick={() => void handleClaimBonus()}
                      disabled={claimingBonus}
                      title={`Claim your ${formatChips(bonusAmount)} chip daily bonus (resets daily at 03:00)`}
                    >
                      {claimingBonus
                        ? t('header.claiming')
                        : `+${formatChips(bonusAmount)} ${t('header.dailyBonus')}`}
                    </button>
                  ) : (
                    <div
                      className="bonus-countdown"
                      title="Next daily bonus unlocks at 03:00 (Europe/Berlin)"
                      aria-label={`${t('header.bonusIn')} ${formatCountdown(secondsUntilBonus)}`}
                    >
                      <span className="bonus-countdown__label">{t('header.bonusIn')}</span>
                      <span className="bonus-countdown__time tabular">
                        {formatCountdown(secondsUntilBonus)}
                      </span>
                    </div>
                  )}

                  {burstKey > 0 && lastClaimedAmount && (
                    <div key={burstKey} className="bonus-coin-burst" aria-hidden="true">
                      <span className="bonus-coin bonus-coin--0">
                        <CoinIcon />
                      </span>
                      <span className="bonus-coin bonus-coin--1">
                        <CoinIcon />
                      </span>
                      <span className="bonus-coin bonus-coin--2">
                        <CoinIcon />
                      </span>
                      <span className="bonus-coin bonus-coin--3">
                        <CoinIcon />
                      </span>
                      <span className="bonus-coin bonus-coin--4">
                        <CoinIcon />
                      </span>
                      <span className="bonus-coin bonus-coin--5">
                        <CoinIcon />
                      </span>
                      <span className="bonus-coin-burst__amount">
                        +{formatChips(lastClaimedAmount)}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <Link to="/profile" className="user-chip">
                <Avatar avatarId={profile.avatar_id} userId={user.id} size={36} />
                <span className="user-chip__name">{profile.username}</span>
              </Link>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={async () => {
                  await signOut();
                  nav('/login');
                }}
              >
                {t('nav.signOut')}
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn--ghost btn--sm">
                {t('nav.signIn')}
              </Link>
              <Link to="/register" className="btn btn--gold btn--sm">
                {t('nav.register')}
              </Link>
            </>
          )}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

function CoinIcon() {
  return (
    <svg className="balance-chip__icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#c9a24b" stroke="#e8cf8f" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="7" fill="none" stroke="#16161a" strokeWidth="1" strokeDasharray="2 2" />
      <text x="12" y="15.5" textAnchor="middle" fontSize="10" fontWeight="700" fill="#16161a" fontFamily="Georgia, serif">
        K
      </text>
    </svg>
  );
}

function SpeakerOnIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 010 7" />
      <path d="M18.5 5.5a9 9 0 010 13" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}
