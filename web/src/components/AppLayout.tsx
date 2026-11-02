import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand-lockup" aria-label="Kafkasino home">
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <span className="brand">Kafkasino</span>
        </Link>

        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/lobby">Lobby</NavLink>
          <NavLink to="/tournaments">Tournaments</NavLink>
          <NavLink to="/shop">Shop</NavLink>
          <NavLink to="/profile">Profile</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>

        <div className="app-header__right">
          <div className="balance-area">
            <BalanceChip />
            <ClaimBonus />
          </div>
          <SoundToggle />
          {profile && user && (
            <Link to="/profile" className="user-chip" title="Your profile">
              <Avatar avatarId={profile.avatar_id} userId={user.id} size={36} />
              <span className="user-chip__name">{profile.username}</span>
            </Link>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
