import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env.local and fill it in.',
  );
}

/**
 * "Remember me" support.
 *
 * The Supabase session is stored in localStorage (survives browser restarts) when the user
 * ticks "Remember me", otherwise in sessionStorage (dies with the tab/window).
 * The preference itself is a tiny flag kept in localStorage. Reads check both stores so an
 * existing session is always found; writes go to the preferred store and purge the other,
 * so the token never lingers in the wrong place (including after silent token refreshes).
 */
const REMEMBER_KEY = 'kafkasino.remember';

export function setRememberMe(remember: boolean): void {
  localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
}

export function getRememberMe(): boolean {
  return localStorage.getItem(REMEMBER_KEY) !== '0';
}

const authStorage = {
  getItem(key: string): string | null {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    const remember = getRememberMe();
    (remember ? sessionStorage : localStorage).removeItem(key);
    (remember ? localStorage : sessionStorage).setItem(key, value);
  },
  removeItem(key: string): void {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

