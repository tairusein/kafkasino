import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { AuthShell } from '../components/AuthShell';
import { AvatarPicker } from '../components/AvatarPicker';
import { friendlyError } from '../lib/errors';
import {
  downloadRecoveryPhraseTxt,
  generateRecoveryPhrase,
  hashRecoveryPhraseClient,
} from '../lib/recovery';
import {
  getRememberMe,
  setRememberMe,
  supabase,
  usernameToInternalEmail,
} from '../lib/supabase';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function RegisterPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { session, setPendingRecoveryAck } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [remember, setRemember] = useState(getRememberMe());
  const [usernameState, setUsernameState] = useState<'idle' | 'checking' | 'free' | 'taken'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recovery Phrase Modal state (shown after registration, blocks entry until downloaded or copied)
  const [recoveryWords, setRecoveryWords] = useState<string[] | null>(null);
  const [hasSavedPhrase, setHasSavedPhrase] = useState(false);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [downloadedNotice, setDownloadedNotice] = useState(false);

  const usernameValid = USERNAME_RE.test(username.trim());

  async function checkUsername() {
    const trimmed = username.trim();
    if (!USERNAME_RE.test(trimmed)) {
      setUsernameState('idle');
      return;
    }
    setUsernameState('checking');
    const { data, error: err } = await supabase.rpc('is_username_available', {
      p_username: trimmed,
    });
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

    const trimmedUsername = username.trim();
    const internalEmail = usernameToInternalEmail(trimmedUsername);

    // 1. Generate 12-word recovery phrase and pre-hash it with SHA-256 before leaving the browser
    const words = generateRecoveryPhrase();
    const recoveryDigest = await hashRecoveryPhraseClient(words);

    // 2. Activate the Recovery Phrase modal blocker BEFORE signUp so <PublicOnly>
    //    does not redirect away before the user downloads or copies their phrase.
    setPendingRecoveryAck(true);

    const { data, error: err } = await supabase.auth.signUp({
      email: internalEmail,
      password,
      // Read by the server-side signup trigger, which validates username/avatar,
      // bcrypt-hashes `recovery_digest` into `public.user_recovery_secrets` (and removes
      // it from metadata), and grants the 10x starting balance.
      options: {
        data: {
          username: trimmedUsername,
          avatar_id: avatarId,
          recovery_digest: recoveryDigest,
        },
      },
    });

    if (err) {
      setPendingRecoveryAck(false);
      setError(friendlyError(err));
      setBusy(false);
      return;
    }

    // If Supabase project had email confirmation enabled before the auto-confirm trigger ran,
    // immediately sign in with password so the user has an active session ready.
    if (!data.session) {
      await supabase.auth.signInWithPassword({
        email: internalEmail,
        password,
      });
    }

    setRecoveryWords(words);
    setHasSavedPhrase(false);
    setCopiedNotice(false);
    setDownloadedNotice(false);
    setBusy(false);
  }

  function onDownloadTxt() {
    if (!recoveryWords) return;
    downloadRecoveryPhraseTxt(username.trim(), recoveryWords);
    setDownloadedNotice(true);
    setHasSavedPhrase(true);
  }

  async function onCopyPhrase() {
    if (!recoveryWords) return;
    const phraseText = recoveryWords.join(' ');
    try {
      await navigator.clipboard.writeText(phraseText);
    } catch {
      // Fallback copy via temporary textarea if clipboard permission is restricted
      const ta = document.createElement('textarea');
      ta.value = phraseText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedNotice(true);
    setHasSavedPhrase(true);
  }

  function onContinueToLobby() {
    if (!hasSavedPhrase) return;
    setPendingRecoveryAck(false);
    if (session) {
      navigate('/lobby', { replace: true });
    } else {
      navigate('/login', { replace: true, state: location.state });
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Choose an identity. You start with a generous stack."
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
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameState('idle');
            }}
            onBlur={() => void checkUsername()}
            disabled={busy || Boolean(recoveryWords)}
          />
          <small className={`hint hint--${usernameState}`}>
            {usernameState === 'checking' && 'Checking…'}
            {usernameState === 'free' && 'Available'}
            {usernameState === 'taken' && 'Already taken'}
            {usernameState === 'idle' && '3–20 letters, numbers or underscores'}
          </small>
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
              disabled={busy || Boolean(recoveryWords)}
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
              disabled={busy || Boolean(recoveryWords)}
            />
          </label>
        </div>

        <fieldset className="field field--avatars">
          <legend>Choose your avatar</legend>
          <AvatarPicker
            value={avatarId}
            onChange={setAvatarId}
            disabled={busy || Boolean(recoveryWords)}
          />
        </fieldset>

        <label className="check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy || Boolean(recoveryWords)}
          />
          <span>Remember me on this device</span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="btn btn--gold btn--block"
          type="submit"
          disabled={busy || Boolean(recoveryWords)}
        >
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="auth-switch">
        Already have an account?{' '}
        <Link to="/login" state={location.state}>
          Sign in
        </Link>
      </p>

      {/* Mandatory 12-Word Recovery Phrase Modal Blocker */}
      {recoveryWords && (
        <div
          className="recovery-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recovery-modal-title"
        >
          <div className="recovery-modal">
            <div className="recovery-modal__header">
              <span className="eyebrow">Mandatory Security Backup</span>
              <h2 id="recovery-modal-title">Save Your 12-Word Recovery Phrase</h2>
              <p className="muted small">
                Kafkasino does not use email addresses. This 12-word Recovery Phrase is the{' '}
                <strong>only way</strong> to reset your password if you ever forget it. Save it now
                before entering the lobby.
              </p>
            </div>

            <div className="recovery-phrase-grid" aria-label="12-word recovery phrase">
              {recoveryWords.map((word, idx) => (
                <div key={idx} className="recovery-word-chip">
                  <span className="recovery-word-chip__index">{idx + 1}.</span>
                  <strong className="recovery-word-chip__word">{word}</strong>
                </div>
              ))}
            </div>

            <div className="recovery-modal__actions">
              <button
                type="button"
                className="btn btn--gold"
                onClick={onDownloadTxt}
              >
                {downloadedNotice ? '✓ Downloaded .txt' : 'Download .txt'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void onCopyPhrase()}
              >
                {copiedNotice ? '✓ Copied Phrase' : 'Copy Phrase'}
              </button>
            </div>

            <div className="recovery-modal__footer">
              {!hasSavedPhrase ? (
                <p className="recovery-modal__warning">
                  Click <strong>Download .txt</strong> or <strong>Copy Phrase</strong> above to
                  unlock the <strong>Continue to Lobby</strong> button.
                </p>
              ) : (
                <p className="form-ok" style={{ margin: 0 }}>
                  Recovery Phrase saved. You may now continue to the lobby.
                </p>
              )}

              <button
                type="button"
                className="btn btn--gold btn--block"
                disabled={!hasSavedPhrase}
                onClick={onContinueToLobby}
              >
                Continue to Lobby
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthShell>
  );
}
