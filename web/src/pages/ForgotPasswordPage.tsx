import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell';
import { friendlyError } from '../lib/errors';
import { hashRecoveryPhraseClient, normalizeRecoveryPhrase } from '../lib/recovery';
import { signInWithUsername, supabase } from '../lib/supabase';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function ForgotPasswordPage() {
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetComplete, setResetComplete] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedUsername = username.trim();
    if (!USERNAME_RE.test(trimmedUsername)) {
      setError('Enter a valid username (3–20 letters, numbers or underscores).');
      return;
    }

    const normalizedPhrase = normalizeRecoveryPhrase(recoveryPhrase);
    const wordCount = normalizedPhrase ? normalizedPhrase.split(' ').length : 0;
    if (wordCount < 6) {
      setError('Please enter your complete 12-word Recovery Phrase.');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setError(null);
    setBusy(true);

    try {
      const recoveryDigest = await hashRecoveryPhraseClient(normalizedPhrase);
      const { data, error: rpcErr } = await supabase.rpc('reset_password_with_recovery', {
        p_username: trimmedUsername,
        p_recovery_digest: recoveryDigest,
        p_new_password: newPassword,
      });

      if (rpcErr) {
        setError(friendlyError(rpcErr));
        setBusy(false);
        return;
      }

      const result = data as { ok?: boolean; error?: string } | null;
      if (!result?.ok) {
        setError(friendlyError(result?.error ?? 'invalid_recovery_phrase'));
        setBusy(false);
        return;
      }

      // Automatically sign the player in with their newly set password
      const { error: signInErr } = await signInWithUsername(trimmedUsername, newPassword);

      if (signInErr) {
        setResetComplete(true);
        setBusy(false);
      }
      // If signIn succeeded, AuthProvider + <PublicOnly> will redirect to the lobby.
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  }

  if (resetComplete) {
    return (
      <AuthShell
        title="Password updated"
        subtitle="Your password has been reset using your Recovery Phrase."
      >
        <div className="stack">
          <p className="muted">
            You can now sign in with your username <strong>{username.trim()}</strong> and your new
            password.
          </p>
          <Link className="btn btn--gold btn--block" to="/login" state={location.state}>
            Return to Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Account Recovery"
      subtitle="Enter your username and 12-word Recovery Phrase to set a new password."
    >
      <form className="form" onSubmit={onSubmit}>
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
          <span>12-Word Recovery Phrase</span>
          <textarea
            rows={3}
            required
            placeholder="Enter your 12 words separated by spaces…"
            value={recoveryPhrase}
            onChange={(e) => setRecoveryPhrase(e.target.value)}
            disabled={busy}
            className="recovery-textarea"
          />
          <small className="hint hint--idle">
            From the kafkasino-recovery-.txt file you saved when creating your account
          </small>
        </label>

        <div className="field-row">
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn--gold btn--block" type="submit" disabled={busy}>
          {busy ? 'Verifying Recovery Phrase…' : 'Reset Password'}
        </button>
      </form>

      <p className="auth-switch">
        Remembered your password?{' '}
        <Link to="/login" state={location.state}>
          Back to Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
