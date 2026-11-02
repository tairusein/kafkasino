import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../lib/supabase';

interface WalletContextValue {
  /** null while loading. Read-only mirror of the server balance. */
  balance: number | null;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * Live balance. The database is the only writer; this just mirrors it:
 *  - initial SELECT (RLS: own row only),
 *  - Realtime postgres_changes on the own wallet row,
 *  - a full re-fetch every time the channel (re)subscribes, so a dropped connection
 *    can never leave a stale balance on screen.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
    if (!error && data) setBalance(Number((data as { balance: number }).balance));
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setBalance(null);
      return;
    }
    const channel = supabase
      .channel(`wallet:${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = (payload.new as { balance?: number }).balance;
          if (typeof next === 'number' || typeof next === 'string') setBalance(Number(next));
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void refresh();
      });
    void refresh();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  const value = useMemo(() => ({ balance, refresh }), [balance, refresh]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>');
  return ctx;
}

