import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { AvatarPicker } from '../components/AvatarPicker';
import { friendlyError } from '../lib/errors';
import { formatChips, formatDate } from '../lib/format';
import { supabase } from '../lib/supabase';
import { useWallet } from '../wallet/WalletProvider';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function ProfilePage() {
  const { user, profile, refreshProfile } = useAuth();
  // Read-only live mirror: RLS lets a user read ONLY their own wallet; no client write path exists.
  const { balance } = useWallet();
  const [username, setUsername] = useState(profile?.username ?? '');
  const [avatarId, setAvatarId] = useState<string | null>(profile?.avatar_id ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (!profile || !user) return null;

  const dirty = username !== profile.username || avatarId !== profile.avatar_id;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!USERNAME_RE.test(username)) {
      setMessage({ kind: 'error', text: 'Username must be 3–20 characters: letters, numbers or underscores.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.rpc('update_profile', {
      p_username: username !== profile!.username ? username : null,
      p_avatar_id: avatarId !== profile!.avatar_id ? avatarId : null,
    });
    if (error) {
      setMessage({ kind: 'error', text: friendlyError(error) });
    } else {
      await refreshProfile();
      setMessage({ kind: 'ok', text: 'Profile updated.' });
    }
    setBusy(false);
  }

  return (
    <div className="page">
      <header className="profile-head">
        <Avatar avatarId={profile.avatar_id} userId={user.id} size={96} />
        <div>
          <p className="eyebrow">Profile</p>
          <h1>{profile.username}</h1>
          <p className="muted">Member since {formatDate(profile.created_at)}</p>
        </div>
        <div className="balance-card">
          <span className="muted small">Balance</span>
          <strong>{formatChips(balance)}</strong>
        </div>
      </header>

      <section>
        <h2>Edit profile</h2>
        <form className="form" onSubmit={onSave}>
          <label className="field">
            <span>Username</span>
            <input
              type="text"
              value={username}
              minLength={3}
              maxLength={20}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </label>
          <fieldset className="field field--avatars">
            <legend>Avatar</legend>
            <AvatarPicker value={avatarId} onChange={setAvatarId} disabled={busy} />
          </fieldset>
          {message && (
            <p className={message.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
              {message.text}
            </p>
          )}
          <div className="row">
            <button className="btn btn--gold" type="submit" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

