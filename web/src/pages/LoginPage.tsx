import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell';
import { friendlyError } from '../lib/errors';
import {
  getRememberMe,
  setRememberMe,
  signInWithUsername,
} from '../lib/supabase';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function LoginPage() {
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(getRememberMe());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedUsername = username.trim();
    if (!USERNAME_RE.test(trimmedUsername)) {
      setError('Enter a valid username (3–20 letters, numbers or underscores).');
      return;
    }

    setError(null);
    setBusy(true);
    // Must be set BEFORE signing in so the session is written to the right storage.
    setRememberMe(remember);

    const { error: err } = await signInWithUsername(trimmedUsername, password);

    if (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
    // On success AuthProvider picks up the session and <PublicOnly> redirects.
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in with your username to take your seat.">
      <form className="form" onSubmit={onSubmit} noValidate={false}>
        <label className="field">
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            required
            minLength={3}
            maxLength={20}
            placeholder="Your club username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>Password</span>
            <Link
              to="/reset-password"
              state={location.state}
              className="small"
              style={{ color: 'var(--gold-300)' }}
            >
              Forgot password?
            </Link>
          </div>
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
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy}
          />
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
