import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { LanguageSwitcher, useI18n } from '../i18n/I18nProvider';
import { WalletProvider } from '../wallet/WalletProvider';
import { Avatar } from './Avatar';
import { BalanceChip } from './BalanceChip';
import { ClaimBonus } from './ClaimBonus';
import { SoundToggle } from './SoundToggle';

/** Providers that only make sense for a signed-in user (live balance). */
export function AuthedProviders() {
  return (
    <WalletProvider>
      <Outlet />
    </WalletProvider>
  );
}

/** Global premium header + page frame, shared by every authenticated page. */
export function AppLayout() {
  const { profile, user, isAdmin, signOut } = useAuth();
  const { t } = useI18n();

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand-lockup" aria-label="Kafkasino home">
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <span className="brand">Kafkasino</span>
        </Link>

        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" end>
            {t('nav.home')}
          </NavLink>
          <NavLink to="/lobby">{t('nav.lobby')}</NavLink>
          <NavLink to="/tournaments">{t('nav.tournaments')}</NavLink>
          <NavLink to="/shop">{t('nav.shop')}</NavLink>
          <NavLink to="/profile">{t('nav.profile')}</NavLink>
          {isAdmin && <NavLink to="/admin">{t('nav.admin')}</NavLink>}
        </nav>

        <div className="app-header__right">
          <LanguageSwitcher />
          <div className="balance-area">
            <BalanceChip />
            <ClaimBonus />
          </div>
          <SoundToggle />
          {profile && user && (
            <Link to="/profile" className="user-chip" title={t('nav.profile')}>
              <Avatar avatarId={profile.avatar_id} userId={user.id} size={36} />
              <span className="user-chip__name">{profile.username}</span>
            </Link>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => void signOut()}>
            {t('nav.signOut')}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
