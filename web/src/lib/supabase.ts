import { createClient } from '@supabase/supabase-js';

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)
  ?.trim()
  .replace(/^["']|["']$/g, '');
const rawAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)
  ?.trim()
  .replace(/^["']|["']$/g, '');

if (!rawUrl || !rawAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env.local and fill it in.',
  );
}

export const supabaseUrl =
  rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;

export const supabaseAnonKey = rawAnonKey;

/**
 * Converts a username into a deterministic internal email for Supabase Auth (`auth.users`).
 * The user never sees or types an email address anywhere in the UI.
 *
 * Uses a valid ICANN domain (`kafkasino.com`) by default so hosted Supabase Cloud
 * GoTrue email validation succeeds without requiring custom auth server flags, while
 * remaining backward-compatible with `@kafkasino.local`.
 */
export function usernameToInternalEmail(
  username: string,
  domain: 'kafkasino.com' | 'kafkasino.local' = 'kafkasino.com',
): string {
  const normalized = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  const safeLocal =
    /^[a-z0-9].*[a-z0-9]$/.test(normalized) || /^[a-z0-9]$/.test(normalized)
      ? normalized
      : `u.${normalized}.u`;
  return `${safeLocal}@${domain}`;
}

export function usernameToInternalEmails(username: string): string[] {
  const normalized = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  const candidates = [
    usernameToInternalEmail(username, 'kafkasino.com'),
    usernameToInternalEmail(username, 'kafkasino.local'),
    `${normalized}@kafkasino.local`,
    `${normalized}@kafkasino.com`,
  ];
  return Array.from(new Set(candidates));
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

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/**
 * Signs up a user purely by username + password, transparently mapping the username
 * to an internal Supabase Auth identifier under the hood.
 */
export async function signUpWithUsername(
  username: string,
  password: string,
  metadata: Record<string, unknown>,
) {
  const primaryEmail = usernameToInternalEmail(username, 'kafkasino.com');
  const firstAttempt = await supabase.auth.signUp({
    email: primaryEmail,
    password,
    options: { data: metadata },
  });

  if (
    firstAttempt.error &&
    /invalid.*email|email.*invalid|unable to validate/i.test(firstAttempt.error.message ?? '')
  ) {
    const fallbackEmail = usernameToInternalEmail(username, 'kafkasino.local');
    return supabase.auth.signUp({
      email: fallbackEmail,
      password,
      options: { data: metadata },
    });
  }

  return firstAttempt;
}

/**
 * Signs in a user purely by username + password, trying both current (`@kafkasino.com`)
 * and legacy (`@kafkasino.local`) internal formats transparently.
 */
export async function signInWithUsername(username: string, password: string) {
  const emails = usernameToInternalEmails(username);
  let lastResult = await supabase.auth.signInWithPassword({
    email: emails[0],
    password,
  });

  if (!lastResult.error) {
    return lastResult;
  }

  for (let i = 1; i < emails.length; i++) {
    if (!/invalid login credentials/i.test(lastResult.error?.message ?? '')) {
      break;
    }
    const nextResult = await supabase.auth.signInWithPassword({
      email: emails[i],
      password,
    });
    if (!nextResult.error) {
      return nextResult;
    }
    lastResult = nextResult;
  }

  return lastResult;
}
