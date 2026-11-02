import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

const RETURN_TO_KEY = 'kafkasino.return_to';

function saveReturnDestination(pathname: string, search: string, hash: string) {
  if (pathname === '/login' || pathname === '/register') return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, `${pathname}${search}${hash}`);
  } catch {
    /* sessionStorage unavailable */
  }
}

function consumeReturnDestination(stateFrom?: {
  pathname?: string;
  search?: string;
  hash?: string;
}): string {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
  } catch {
    /* sessionStorage unavailable */
  }

  if (stateFrom?.pathname && stateFrom.pathname !== '/login' && stateFrom.pathname !== '/register') {
    return `${stateFrom.pathname}${stateFrom.search ?? ''}${stateFrom.hash ?? ''}`;
  }
  if (stored && !stored.startsWith('/login') && !stored.startsWith('/register')) {
    return stored;
  }
  return '/';
}

export function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div className="fullscreen-center">
      <div className="brand brand--large">Kafkasino</div>
      <div className="muted">{children}</div>
    </div>
  );
}

/** Pages that need a signed-in user. Redirects to /login and remembers where to return (including /room/:roomId invites). */
export function RequireAuth() {
  const { session, loading, profileError, signOut } = useAuth();
  const location = useLocation();

  if (loading) return <div className="app-boot-placeholder" aria-hidden="true" />;
  if (!session) {
    saveReturnDestination(location.pathname, location.search, location.hash);
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (profileError) {
    return (
      <FullScreenMessage>
        <p>We could not load your profile.</p>
        <div className="row row--center">
          <button className="btn btn--gold" onClick={() => window.location.reload()}>
            Retry
          </button>
          <button className="btn btn--ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </FullScreenMessage>
    );
  }
  return <Outlet />;
}

/**
 * Enforces Admin-only routes in the router.
 * All privileged mutations are independently verified server-side via RLS and `public.is_admin()`.
 */
export function RequireAdmin() {
  const { session, isAdmin, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="app-boot-placeholder" aria-hidden="true" />;
  if (!session) {
    saveReturnDestination(location.pathname, location.search, location.hash);
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (!isAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Login / register: signed-in users are bounced to where they were heading (or home). */
export function PublicOnly() {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="app-boot-placeholder" aria-hidden="true" />;
  if (session) {
    const fromState = (
      location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null
    )?.from;
    const destination = consumeReturnDestination(fromState);
    return <Navigate to={destination} replace />;
  }
  return <Outlet />;
}
