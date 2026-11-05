import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** True when the signed-in user holds the primary 'admin' role in public.user_roles. */
  isAdmin: boolean;
  /** true until the stored session AND (if signed in) the profile/role have been resolved */
  loading: boolean;
  profileError: boolean;
  /**
   * True right after registration while the user is required to download or copy
   * their 12-word Recovery Phrase before entering the application.
   */
  pendingRecoveryAck: boolean;
  setPendingRecoveryAck: (pending: boolean) => void;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [profileError, setProfileError] = useState(false);
  const [pendingRecoveryAck, setPendingRecoveryAck] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setInitializing(false);
    });
    // Keep this callback synchronous: calling supabase APIs inside it can deadlock the client.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setInitializing(false);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id ?? null;

  const fetchUserState = useCallback(async (id: string): Promise<{ profile: Profile | null; isAdmin: boolean }> => {
    const [profRes, roleRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('user_roles').select('role').eq('user_id', id).eq('role', 'admin').maybeSingle(),
    ]);
    return {
      profile: profRes.error ? null : (profRes.data as Profile),
      isAdmin: !roleRes.error && roleRes.data !== null,
    };
  }, []);

  // Load the profile & role whenever the signed-in user changes (not on every token refresh).
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setIsAdmin(false);
      setProfileError(false);
      return;
    }
    let cancelled = false;
    setProfileError(false);
    void fetchUserState(userId).then((res) => {
      if (cancelled) return;
      setProfile(res.profile);
      setIsAdmin(res.isAdmin);
      setProfileError(res.profile === null);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, fetchUserState]);

  const refreshProfile = useCallback(async () => {
    if (!userId) return;
    const res = await fetchUserState(userId);
    setProfile(res.profile);
    setIsAdmin(res.isAdmin);
    setProfileError(res.profile === null);
  }, [userId, fetchUserState]);

  const signOut = useCallback(async () => {
    setPendingRecoveryAck(false);
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      isAdmin,
      loading: initializing || (userId !== null && profile === null && !profileError),
      profileError,
      pendingRecoveryAck,
      setPendingRecoveryAck,
      refreshProfile,
      signOut,
    }),
    [
      session,
      profile,
      isAdmin,
      initializing,
      userId,
      profileError,
      pendingRecoveryAck,
      refreshProfile,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
