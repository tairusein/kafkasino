import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../lib/supabase';

const EMPTY: ReadonlySet<string> = new Set();
const PresenceContext = createContext<ReadonlySet<string>>(EMPTY);
const PresenceReadyContext = createContext<boolean>(true);

/**
 * Site-wide online status via Supabase Realtime Presence.
 *
 * - Private channel `presence:global` (authorised by the realtime.messages RLS policy from
 *   migration 6; signed-in users only).
 * - Presence key = auth user id, so one user with several tabs counts once, and the user
 *   disappears only when their LAST tab/connection goes away (Realtime also drops dead
 *   connections via heartbeat).
 * - supabase-js re-joins and re-tracks automatically after a network drop; the `sync`
 *   event then rebuilds the full set, so the indicator can never get stuck stale.
 *
 * Presence is cosmetic (a green dot). Nothing security- or game-relevant depends on it.
 */
export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [online, setOnline] = useState<ReadonlySet<string>>(EMPTY);
  const [ready, setReady] = useState<boolean>(!userId);

  useEffect(() => {
    if (!userId) {
      setOnline(EMPTY);
      setReady(true);
      return;
    }
    let disposed = false;
    let channel: RealtimeChannel | null = null;
    setReady(false);

    // Safety fallback so an offline/blocked WebSocket never traps the global loader forever.
    const fallbackTimer = window.setTimeout(() => {
      if (!disposed) setReady(true);
    }, 1800);

    void (async () => {
      // Private channels need the user's JWT on the realtime socket before joining.
      const { data } = await supabase.auth.getSession();
      await supabase.realtime.setAuth(data.session?.access_token ?? null);
      if (disposed) return;

      const ch = supabase.channel('presence:global', {
        config: { private: true, presence: { key: userId } },
      });
      channel = ch;
      ch.on('presence', { event: 'sync' }, () => {
        if (!disposed) {
          setOnline(new Set(Object.keys(ch.presenceState())));
          setReady(true);
        }
      }).subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          void ch.track({ online_at: new Date().toISOString() });
          setReady(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setReady(true);
        }
      });
    })();

    return () => {
      disposed = true;
      window.clearTimeout(fallbackTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);

  const value = useMemo(() => online, [online]);
  return (
    <PresenceReadyContext.Provider value={ready}>
      <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>
    </PresenceReadyContext.Provider>
  );
}

/** Is this user online right now? (false outside the provider or for unknown ids) */
export function usePresence(userId: string | null | undefined): boolean {
  const online = useContext(PresenceContext);
  return userId ? online.has(userId) : false;
}

export function useOnlineIds(): ReadonlySet<string> {
  return useContext(PresenceContext);
}

/** True once the initial Supabase Realtime presence handshake has completed (or fallen back). */
export function usePresenceReady(): boolean {
  return useContext(PresenceReadyContext);
}

