import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell';
import { AvatarPicker } from '../components/AvatarPicker';
import { friendlyError } from '../lib/errors';
import { getRememberMe, setRememberMe, supabase } from '../lib/supabase';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function RegisterPage() {
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [remember, setRemember] = useState(getRememberMe());
  const [usernameState, setUsernameState] = useState<'idle' | 'checking' | 'free' | 'taken'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  const usernameValid = USERNAME_RE.test(username);

  async function checkUsername() {
    if (!usernameValid) {
      setUsernameState('idle');
      return;
    }
    setUsernameState('checking');
    const { data, error: err } = await supabase.rpc('is_username_available', { p_username: username });
    if (err) {
      setUsernameState('idle'); // the server re-validates on submit
      return;
    }
    setUsernameState(data === true ? 'free' : 'taken');
  }

  function validate(): string | null {
    if (!usernameValid) return 'Username must be 3–20 characters: letters, numbers or underscores.';
    if (usernameState === 'taken') return 'That username is already taken.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirm) return 'Passwords do not match.';
    if (!avatarId) return 'Please choose an avatar.';
    return null;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    setRememberMe(remember);
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      // Read by the server-side signup trigger, which validates both values and
      // grants the starting balance (exactly 10x the daily bonus).
      options: { data: { username, avatar_id: avatarId } },
    });
    if (err) {
      setError(friendlyError(err));
      setBusy(false);
      return;
    }
    if (!data.session) {
      // Project requires email confirmation before a session is issued.
      setNeedsConfirmation(true);
      setBusy(false);
    }
    // Otherwise a session exists: AuthProvider + <PublicOnly> take over and redirect home.
  }

  if (needsConfirmation) {
    return (
      <AuthShell title="Check your inbox" subtitle={`We sent a confirmation link to ${email.trim()}.`}>
        <p className="muted">Confirm your address, then sign in to claim your seat and starting chips.</p>
        <Link className="btn btn--gold btn--block" to="/login">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="Choose an identity. You start with a generous stack.">
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            required
            minLength={3}
            maxLength={20}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameState('idle');
            }}
            onBlur={() => void checkUsername()}
            disabled={busy}
          />
          <small className={`hint hint--${usernameState}`}>
            {usernameState === 'checking' && 'Checking…'}
            {usernameState === 'free' && 'Available'}
            {usernameState === 'taken' && 'Already taken'}
            {usernameState === 'idle' && '3–20 letters, numbers or underscores'}
          </small>
        </label>
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
        <div className="field-row">
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>

        <fieldset className="field field--avatars">
          <legend>Choose your avatar</legend>
          <AvatarPicker value={avatarId} onChange={setAvatarId} disabled={busy} />
        </fieldset>

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
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="auth-switch">
        Already have an account?{' '}
        <Link to="/login" state={location.state}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

