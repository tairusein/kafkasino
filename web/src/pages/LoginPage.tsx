import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell';
import { friendlyError } from '../lib/errors';
import { getRememberMe, setRememberMe, supabase } from '../lib/supabase';

export function LoginPage() {
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(getRememberMe());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Must be set BEFORE signing in so the session is written to the right storage.
    setRememberMe(remember);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
    // On success AuthProvider picks up the session and <PublicOnly> redirects.
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to take your seat.">
      <form className="form" onSubmit={onSubmit} noValidate={false}>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
          <span>Remember me on this device</span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--gold btn--block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth-switch">
        New to Kafkasino?{' '}
        <Link to="/register" state={location.state}>
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}

