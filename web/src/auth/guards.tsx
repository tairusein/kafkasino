import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

const RETURN_TO_KEY = 'kafkasino.return_to';
const AUTH_PATHS = ['/login', '/register', '/reset-password'];

function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function saveReturnDestination(pathname: string, search: string, hash: string) {
  if (isAuthPath(pathname)) return;
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

  if (stateFrom?.pathname && !isAuthPath(stateFrom.pathname)) {
    return `${stateFrom.pathname}${stateFrom.search ?? ''}${stateFrom.hash ?? ''}`;
  }
  if (stored && !AUTH_PATHS.some((p) => stored!.startsWith(p))) {
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

/**
 * Login / register / reset-password:
 * Signed-in users are bounced to where they were heading (or home),
 * EXCEPT while `pendingRecoveryAck` is true (holding the user on `/register`
 * until they download or copy their 12-word Recovery Phrase).
 */
export function PublicOnly() {
  const { session, loading, pendingRecoveryAck } = useAuth();
  const location = useLocation();

  if (loading && !pendingRecoveryAck) {
    return <div className="app-boot-placeholder" aria-hidden="true" />;
  }
  if (session && !pendingRecoveryAck) {
    const fromState = (
      location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null
    )?.from;
    const destination = consumeReturnDestination(fromState);
    return <Navigate to={destination} replace />;
  }
  return <Outlet />;
}
