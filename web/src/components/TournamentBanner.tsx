import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import { friendlyError } from '../lib/errors';
import { formatChips, formatDateTime, toDatetimeLocalValue } from '../lib/format';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_PRIZE_IMAGE,
  PRIZE_ART_PRESETS,
  resolveTournamentImageUrl,
  uploadTournamentPrizeImage,
} from '../lib/tournaments';
import type { Tournament, TournamentStatus } from '../lib/types';

function defaultStartIso(): string {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export function TournamentBanner() {
  const { isAdmin, user } = useAuth();
  const { sound } = useSound();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [participantCount, setParticipantCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  // Editable banner fields (Admin)
  const [title, setTitle] = useState('');
  const [prizeName, setPrizeName] = useState('');
  const [prizeImagePath, setPrizeImagePath] = useState(DEFAULT_PRIZE_IMAGE);
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [entryFee, setEntryFee] = useState('1000');
  const [maxParticipants, setMaxParticipants] = useState('64');
  const [status, setStatus] = useState<TournamentStatus>('upcoming');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const populateForm = useCallback((t: Tournament | null) => {
    if (t) {
      setTitle(t.title);
      setPrizeName(t.prize_name);
      setPrizeImagePath(t.prize_image_path ?? DEFAULT_PRIZE_IMAGE);
      setStartsAtLocal(toDatetimeLocalValue(t.starts_at));
      setEntryFee(String(t.entry_fee));
      setMaxParticipants(t.max_participants != null ? String(t.max_participants) : '');
      setStatus(t.status === 'draft' ? 'upcoming' : t.status);
      setDescription(t.description ?? '');
    } else {
      setTitle('The Grand House Invitational');
      setPrizeName('Royal Gold Chronograph & 50,000 Chips');
      setPrizeImagePath(DEFAULT_PRIZE_IMAGE);
      setStartsAtLocal(toDatetimeLocalValue(defaultStartIso()));
      setEntryFee('1000');
      setMaxParticipants('64');
      setStatus('upcoming');
      setDescription(
        'High-stakes championship across the house tables. Registered contenders compete for the house crest and the grand prize.',
      );
    }
  }, []);

  const loadBanner = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('tournaments')
      .select('*')
      .eq('is_featured', true)
      .maybeSingle();

    if (err) {
      setLoading(false);
      return;
    }

    const row = (data as Tournament | null) ?? null;
    setTournament(row);
    if (row) {
      const { count } = await supabase
        .from('tournament_participants')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', row.id);
      setParticipantCount(count ?? 0);
    } else {
      setParticipantCount(0);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadBanner();
    const channel = supabase
      .channel('homepage-featured-tournament')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, () => {
        void loadBanner();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_participants' }, () => {
        void loadBanner();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadBanner]);

  function openEditor() {
    populateForm(tournament);
    setError(null);
    setEditing(true);
  }

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const objectPath = await uploadTournamentPrizeImage(file);
      setPrizeImagePath(objectPath);
      sound.play('notify');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function onSaveBanner(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedTitle = title.trim();
    const trimmedPrize = prizeName.trim();
    if (!trimmedTitle || !trimmedPrize) {
      setError('Tournament title and prize name are required.');
      return;
    }
    const parsedDate = new Date(startsAtLocal);
    if (Number.isNaN(parsedDate.getTime())) {
      setError('Please enter a valid tournament date and time.');
      return;
    }
    const parsedFee = Math.max(0, Math.floor(Number(entryFee) || 0));
    const parsedMax = maxParticipants.trim() === '' ? null : Math.max(1, Math.floor(Number(maxParticipants)));

    setSaving(true);
    const payload = {
      title: trimmedTitle,
      prize_name: trimmedPrize,
      prize_image_path: prizeImagePath.trim() || DEFAULT_PRIZE_IMAGE,
      starts_at: parsedDate.toISOString(),
      entry_fee: parsedFee,
      max_participants: parsedMax,
      status: status === 'draft' ? 'upcoming' : status,
      description: description.trim(),
    };

    if (tournament) {
      const { error: updErr } = await supabase.from('tournaments').update(payload).eq('id', tournament.id);
      if (updErr) {
        setError(friendlyError(updErr));
        setSaving(false);
        return;
      }
    } else {
      const { data: created, error: insErr } = await supabase
        .from('tournaments')
        .insert({ ...payload, is_featured: false, created_by: user?.id ?? null })
        .select('id')
        .single();
      if (insErr || !created) {
        setError(friendlyError(insErr));
        setSaving(false);
        return;
      }
      const { error: featErr } = await supabase.rpc('admin_set_featured_tournament', {
        p_tournament_id: (created as { id: string }).id,
      });
      if (featErr) {
        setError(friendlyError(featErr));
        setSaving(false);
        return;
      }
    }

    await loadBanner();
    sound.play('notify');
    setSaving(false);
    setEditing(false);
  }

  if (loading) {
    return (
      <section className="tournament-banner tournament-banner--skeleton" aria-label="Featured tournament">
        <p className="muted">Loading featured tournament…</p>
      </section>
    );
  }

  if (!tournament && !editing) {
    if (!isAdmin) return null;
    return (
      <section className="tournament-banner" aria-label="Featured tournament">
        <div className="tournament-banner__empty">
          <div>
            <p className="eyebrow">Featured Tournament Banner</p>
            <h2>No featured tournament is set</h2>
            <p className="muted">Create a featured tournament to display the homepage hero banner.</p>
          </div>
          <button type="button" className="btn btn--gold" onClick={openEditor}>
            Create Banner Tournament
          </button>
        </div>
      </section>
    );
  }

  if (editing && isAdmin) {
    return (
      <section className="tournament-banner tournament-banner--editing" aria-label="Edit featured tournament banner">
        <div className="tournament-banner__admin-bar">
          <span className="eyebrow">Admin · Edit Homepage Tournament Banner</span>
          <div className="row">
            <Link className="btn btn--ghost btn--sm" to="/admin">
              Full Admin Panel
            </Link>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>

        <form className="form tournament-banner__form" onSubmit={onSaveBanner}>
          <div className="tournament-banner__editor-grid">
            <div className="tournament-banner__editor-fields">
              <div className="field-row">
                <label className="field">
                  <span>Prize Name</span>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={prizeName}
                    onChange={(e) => setPrizeName(e.target.value)}
                    disabled={saving}
                  />
                </label>
                <label className="field">
                  <span>Tournament Date & Time</span>
                  <input
                    type="datetime-local"
                    required
                    value={startsAtLocal}
                    onChange={(e) => setStartsAtLocal(e.target.value)}
                    disabled={saving}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Tournament Title</span>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={saving}
                  />
                </label>
                <label className="field">
                  <span>Status</span>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as TournamentStatus)}
                    disabled={saving}
                  >
                    <option value="upcoming">Upcoming (Registration Open)</option>
                    <option value="live">Live Now</option>
                    <option value="finished">Finished</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Entry Fee (Chips)</span>
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={entryFee}
                    onChange={(e) => setEntryFee(e.target.value)}
                    disabled={saving}
                  />
                </label>
                <label className="field">
                  <span>Max Participants (optional)</span>
                  <input
                    type="number"
                    min={2}
                    placeholder="Unlimited"
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(e.target.value)}
                    disabled={saving}
                  />
                </label>
              </div>

              <label className="field">
                <span>Prize Image (Vector Preset, Storage Upload, or URL)</span>
                <input
                  type="text"
                  value={prizeImagePath}
                  onChange={(e) => setPrizeImagePath(e.target.value)}
                  placeholder="/tournaments/royal-chronograph.svg"
                  disabled={saving || uploading}
                />
              </label>

              <div className="row">
                {PRIZE_ART_PRESETS.map((preset) => (
                  <button
                    key={preset.path}
                    type="button"
                    className={`btn btn--ghost btn--sm${prizeImagePath === preset.path ? ' is-selected-pill' : ''}`}
                    onClick={() => setPrizeImagePath(preset.path)}
                    disabled={saving || uploading}
                  >
                    {preset.label}
                  </button>
                ))}
                <label className="btn btn--ghost btn--sm file-upload-btn">
                  <span>{uploading ? 'Uploading…' : 'Upload PNG/JPG/WebP'}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => void onFileSelected(e)}
                    disabled={saving || uploading}
                  />
                </label>
              </div>

              <label className="field">
                <span>Description</span>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={saving}
                />
              </label>
            </div>

            <div className="tournament-banner__preview-pane">
              <span className="eyebrow">Live Prize Preview</span>
              <div className="tournament-banner__art-frame">
                <img src={resolveTournamentImageUrl(prizeImagePath)} alt={prizeName || 'Prize preview'} />
              </div>
              <div className="tournament-banner__prize-tag">
                <span className="muted small">Grand Prize</span>
                <strong>{prizeName || '—'}</strong>
              </div>
            </div>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="row">
            <button type="submit" className="btn btn--gold" disabled={saving || uploading}>
              {saving ? 'Saving Banner…' : 'Save Homepage Banner'}
            </button>
            {tournament && (
              <Link className="btn btn--ghost" to={`/tournaments/${tournament.id}`}>
                Open Tournament Page
              </Link>
            )}
          </div>
        </form>
      </section>
    );
  }

  if (!tournament) return null;

  const imageUrl = resolveTournamentImageUrl(tournament.prize_image_path);
  const statusLabel =
    tournament.status === 'live'
      ? 'Live Championship'
      : tournament.status === 'upcoming'
        ? 'Featured Championship · Registration Open'
        : `Featured Championship · ${tournament.status}`;

  return (
    <section className="tournament-banner" aria-label="Featured tournament">
      {isAdmin && (
        <div className="tournament-banner__admin-bar">
          <span className="eyebrow">Admin Controls · Featured Homepage Banner</span>
          <div className="row">
            <button type="button" className="btn btn--ghost btn--sm" onClick={openEditor}>
              Edit Banner (Date / Prize / Image)
            </button>
            <Link className="btn btn--ghost btn--sm" to="/admin">
              Admin Panel
            </Link>
          </div>
        </div>
      )}

      <Link
        to={`/tournaments/${tournament.id}`}
        className="tournament-banner__link"
        aria-label={`${tournament.title} — Prize: ${tournament.prize_name} — Click to view and register`}
      >
        <div className="tournament-banner__content">
          <div className="row">
            <span className={`badge ${tournament.status === 'upcoming' || tournament.status === 'live' ? 'badge--open' : ''}`}>
              {statusLabel}
            </span>
            <span className="muted small">
              {participantCount}
              {tournament.max_participants != null ? ` / ${tournament.max_participants}` : ''} registered
            </span>
          </div>

          <h2 className="tournament-banner__title">{tournament.title}</h2>
          {tournament.description && <p className="muted tournament-banner__desc">{tournament.description}</p>}

          <dl className="tournament-banner__highlights">
            <div className="tournament-banner__stat">
              <dt>Grand Prize</dt>
              <dd className="tournament-banner__prize-name">{tournament.prize_name}</dd>
            </div>
            <div className="tournament-banner__stat">
              <dt>Tournament Date</dt>
              <dd>{formatDateTime(tournament.starts_at)}</dd>
            </div>
            <div className="tournament-banner__stat">
              <dt>Entry Fee</dt>
              <dd>{tournament.entry_fee > 0 ? `${formatChips(tournament.entry_fee)} Chips` : 'Complimentary'}</dd>
            </div>
          </dl>

          <div className="tournament-banner__cta">
            <span className="btn btn--gold">Enter Tournament Page &amp; Register →</span>
          </div>
        </div>

        <div className="tournament-banner__visual">
          <div className="tournament-banner__art-frame">
            <img src={imageUrl} alt={tournament.prize_name} draggable={false} />
          </div>
          <span className="tournament-banner__caption">{tournament.prize_name}</span>
        </div>
      </Link>
    </section>
  );
}

