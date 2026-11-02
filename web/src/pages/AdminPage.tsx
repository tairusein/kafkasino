import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { friendlyError } from '../lib/errors';
import { formatChips, formatDateTime, toDatetimeLocalValue } from '../lib/format';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_PRIZE_IMAGE,
  PRIZE_ART_PRESETS,
  resolveTournamentImageUrl,
  uploadTournamentPrizeImage,
} from '../lib/tournaments';
import type { AppConfigRow, GameCatalogEntry, Profile, Tournament, TournamentStatus } from '../lib/types';

function defaultStartLocal(): string {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  return toDatetimeLocalValue(d.toISOString());
}

export function AdminPage() {
  const { user } = useAuth();
  const { sound } = useSound();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [games, setGames] = useState<GameCatalogEntry[]>([]);
  const [configs, setConfigs] = useState<AppConfigRow[]>([]);
  const [players, setPlayers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  // Tournament editor state (null = creating new)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prizeName, setPrizeName] = useState('');
  const [prizeImagePath, setPrizeImagePath] = useState(DEFAULT_PRIZE_IMAGE);
  const [startsAtLocal, setStartsAtLocal] = useState(defaultStartLocal);
  const [gameType, setGameType] = useState<string>('blackjack');
  const [entryFee, setEntryFee] = useState('1000');
  const [maxParticipants, setMaxParticipants] = useState('64');
  const [status, setStatus] = useState<TournamentStatus>('upcoming');
  const [makeFeatured, setMakeFeatured] = useState(true);
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [savingTournament, setSavingTournament] = useState(false);
  const [tournamentMsg, setTournamentMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Config editor state
  const [dailyBonus, setDailyBonus] = useState('1000');
  const [resetHour, setResetHour] = useState('3');
  const [timezone, setTimezone] = useState('Europe/Berlin');
  const [turnTimeout, setTurnTimeout] = useState('15');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Ledger balance adjustment state
  const [selectedUserId, setSelectedUserId] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [savingAdjust, setSavingAdjust] = useState(false);
  const [adjustMsg, setAdjustMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const selectTournamentForEdit = useCallback((t: Tournament | null) => {
    setTournamentMsg(null);
    if (!t) {
      setEditingId(null);
      setTitle('');
      setPrizeName('');
      setPrizeImagePath(DEFAULT_PRIZE_IMAGE);
      setStartsAtLocal(defaultStartLocal());
      setGameType('blackjack');
      setEntryFee('1000');
      setMaxParticipants('64');
      setStatus('upcoming');
      setMakeFeatured(false);
      setDescription('');
      return;
    }
    setEditingId(t.id);
    setTitle(t.title);
    setPrizeName(t.prize_name);
    setPrizeImagePath(t.prize_image_path ?? DEFAULT_PRIZE_IMAGE);
    setStartsAtLocal(toDatetimeLocalValue(t.starts_at));
    setGameType(t.game_type ?? '');
    setEntryFee(String(t.entry_fee));
    setMaxParticipants(t.max_participants != null ? String(t.max_participants) : '');
    setStatus(t.status);
    setMakeFeatured(t.is_featured);
    setDescription(t.description ?? '');
  }, []);

  const loadAll = useCallback(async () => {
    const [tRes, gRes, cRes, pRes] = await Promise.all([
      supabase
        .from('tournaments')
        .select('*')
        .order('is_featured', { ascending: false })
        .order('starts_at', { ascending: true }),
      supabase.from('game_catalog').select('*').order('name'),
      supabase.from('app_config').select('*').order('key'),
      supabase.from('profiles').select('*').order('username').limit(100),
    ]);

    if (!tRes.error && tRes.data) {
      const list = tRes.data as Tournament[];
      setTournaments(list);
      const featured = list.find((x) => x.is_featured) ?? list[0] ?? null;
      selectTournamentForEdit(featured);
    }
    if (!gRes.error && gRes.data) setGames(gRes.data as GameCatalogEntry[]);
    if (!cRes.error && cRes.data) {
      const rows = cRes.data as AppConfigRow[];
      setConfigs(rows);
      for (const row of rows) {
        if (row.key === 'daily_bonus_amount') setDailyBonus(String(row.value));
        if (row.key === 'bonus_reset_hour') setResetHour(String(row.value));
        if (row.key === 'bonus_timezone') setTimezone(String(row.value));
        if (row.key === 'turn_timeout_seconds') setTurnTimeout(String(row.value));
      }
    }
    if (!pRes.error && pRes.data) {
      const profs = pRes.data as Profile[];
      setPlayers(profs);
      if (profs.length > 0) setSelectedUserId((prev) => prev || profs[0].id);
    }
    setLoading(false);
  }, [selectTournamentForEdit]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function onUploadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setTournamentMsg(null);
    setUploading(true);
    try {
      const objectPath = await uploadTournamentPrizeImage(file);
      setPrizeImagePath(objectPath);
      sound.play('notify');
      setTournamentMsg({ kind: 'ok', text: 'Prize image uploaded to storage.' });
    } catch (err) {
      setTournamentMsg({ kind: 'error', text: friendlyError(err) });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function onSaveTournament(e: FormEvent) {
    e.preventDefault();
    setTournamentMsg(null);

    const trimmedTitle = title.trim();
    const trimmedPrize = prizeName.trim();
    if (!trimmedTitle || !trimmedPrize) {
      setTournamentMsg({ kind: 'error', text: 'Title and prize name are required.' });
      return;
    }
    const parsedDate = new Date(startsAtLocal);
    if (Number.isNaN(parsedDate.getTime())) {
      setTournamentMsg({ kind: 'error', text: 'Please provide a valid start date and time.' });
      return;
    }
    if (makeFeatured && status === 'draft') {
      setTournamentMsg({
        kind: 'error',
        text: 'A featured homepage banner tournament cannot have Draft status.',
      });
      return;
    }

    setSavingTournament(true);
    const payload = {
      title: trimmedTitle,
      prize_name: trimmedPrize,
      prize_image_path: prizeImagePath.trim() || DEFAULT_PRIZE_IMAGE,
      starts_at: parsedDate.toISOString(),
      game_type: gameType || null,
      entry_fee: Math.max(0, Math.floor(Number(entryFee) || 0)),
      max_participants: maxParticipants.trim() === '' ? null : Math.max(1, Math.floor(Number(maxParticipants))),
      status,
      description: description.trim(),
    };

    let targetId = editingId;

    if (editingId) {
      const { error } = await supabase.from('tournaments').update(payload).eq('id', editingId);
      if (error) {
        setTournamentMsg({ kind: 'error', text: friendlyError(error) });
        setSavingTournament(false);
        return;
      }
    } else {
      const { data, error } = await supabase
        .from('tournaments')
        .insert({ ...payload, is_featured: false, created_by: user?.id ?? null })
        .select('id')
        .single();
      if (error || !data) {
        setTournamentMsg({ kind: 'error', text: friendlyError(error) });
        setSavingTournament(false);
        return;
      }
      targetId = (data as { id: string }).id;
    }

    if (makeFeatured && targetId) {
      const { error: featErr } = await supabase.rpc('admin_set_featured_tournament', {
        p_tournament_id: targetId,
      });
      if (featErr) {
        setTournamentMsg({ kind: 'error', text: friendlyError(featErr) });
        setSavingTournament(false);
        return;
      }
    }

    await loadAll();
    sound.play('notify');
    setSavingTournament(false);
    setTournamentMsg({
      kind: 'ok',
      text: editingId ? 'Tournament updated.' : 'Tournament created.',
    });
  }

  async function onFeatureTournament(id: string) {
    setTournamentMsg(null);
    const { error } = await supabase.rpc('admin_set_featured_tournament', { p_tournament_id: id });
    if (error) {
      setTournamentMsg({ kind: 'error', text: friendlyError(error) });
    } else {
      sound.play('notify');
      await loadAll();
      setTournamentMsg({ kind: 'ok', text: 'Homepage hero banner updated.' });
    }
  }

  async function onDeleteTournament(id: string) {
    setTournamentMsg(null);
    const { error } = await supabase.from('tournaments').delete().eq('id', id);
    if (error) {
      setTournamentMsg({ kind: 'error', text: friendlyError(error) });
    } else {
      await loadAll();
      setTournamentMsg({ kind: 'ok', text: 'Tournament deleted.' });
    }
  }

  async function onSaveConfig(e: FormEvent) {
    e.preventDefault();
    setConfigMsg(null);
    setSavingConfig(true);

    const updates: [string, unknown][] = [
      ['daily_bonus_amount', Number(dailyBonus)],
      ['bonus_reset_hour', Number(resetHour)],
      ['bonus_timezone', timezone.trim()],
      ['turn_timeout_seconds', Number(turnTimeout)],
    ];

    for (const [key, val] of updates) {
      const { error } = await supabase.rpc('admin_set_config', { p_key: key, p_value: val });
      if (error) {
        setConfigMsg({ kind: 'error', text: `${key}: ${friendlyError(error)}` });
        setSavingConfig(false);
        return;
      }
    }

    await loadAll();
    sound.play('notify');
    setSavingConfig(false);
    setConfigMsg({ kind: 'ok', text: 'House configuration saved.' });
  }

  async function onAdjustBalance(e: FormEvent) {
    e.preventDefault();
    setAdjustMsg(null);
    const amt = Math.trunc(Number(adjustAmount));
    if (!selectedUserId || !amt) {
      setAdjustMsg({ kind: 'error', text: 'Select a player and enter a non-zero chip amount.' });
      return;
    }
    if (adjustReason.trim().length < 3) {
      setAdjustMsg({ kind: 'error', text: 'Please enter a reason (at least 3 characters).' });
      return;
    }

    setSavingAdjust(true);
    const { data, error } = await supabase.rpc('admin_adjust_balance', {
      p_user: selectedUserId,
      p_amount: amt,
      p_reason: adjustReason.trim(),
    });

    if (error) {
      setAdjustMsg({ kind: 'error', text: friendlyError(error) });
    } else {
      sound.play('chipClick');
      setAdjustAmount('');
      setAdjustReason('');
      setAdjustMsg({
        kind: 'ok',
        text: `Adjustment recorded in ledger. Player’s new balance: ${formatChips(Number(data))} chips.`,
      });
    }
    setSavingAdjust(false);
  }

  if (loading) {
    return (
      <div className="page">
        <p className="muted">Loading Admin Panel…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Primary Administrator · RBAC Enforced</p>
          <h1>House Administration</h1>
        </div>
        <div className="row">
          <Link className="btn btn--ghost" to="/">
            View Homepage Banner
          </Link>
          <Link className="btn btn--ghost" to="/tournaments">
            Tournament Page
          </Link>
        </div>
      </header>

      {/* 1. Tournament & Homepage Banner Editor */}
      <section className="admin-panel-card" aria-label="Homepage banner and tournament editor">
        <div className="admin-panel-card__head">
          <div>
            <p className="eyebrow">Homepage Hero Banner &amp; Championships</p>
            <h2>{editingId ? 'Edit Tournament' : 'Create New Tournament'}</h2>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => selectTournamentForEdit(null)}
          >
            + New Tournament
          </button>
        </div>

        <form className="form" onSubmit={onSaveTournament}>
          <div className="tournament-banner__editor-grid">
            <div className="tournament-banner__editor-fields">
              <div className="field-row">
                <label className="field">
                  <span>Tournament Title</span>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={savingTournament}
                  />
                </label>
                <label className="field">
                  <span>Prize Name (shown on banner)</span>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={prizeName}
                    onChange={(e) => setPrizeName(e.target.value)}
                    disabled={savingTournament}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Start Date &amp; Time (shown on banner)</span>
                  <input
                    type="datetime-local"
                    required
                    value={startsAtLocal}
                    onChange={(e) => setStartsAtLocal(e.target.value)}
                    disabled={savingTournament}
                  />
                </label>
                <label className="field">
                  <span>Game Discipline</span>
                  <select
                    value={gameType}
                    onChange={(e) => setGameType(e.target.value)}
                    disabled={savingTournament}
                  >
                    <option value="">Any / Multi-game</option>
                    {games.map((g) => (
                      <option key={g.slug} value={g.slug}>
                        {g.name}
                      </option>
                    ))}
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
                    disabled={savingTournament}
                  />
                </label>
                <label className="field">
                  <span>Max Participants (blank = unlimited)</span>
                  <input
                    type="number"
                    min={2}
                    placeholder="Unlimited"
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(e.target.value)}
                    disabled={savingTournament}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Status</span>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as TournamentStatus)}
                    disabled={savingTournament}
                  >
                    <option value="upcoming">Upcoming (Registration Open)</option>
                    <option value="live">Live</option>
                    <option value="finished">Finished</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="draft">Draft (Hidden from public)</option>
                  </select>
                </label>
                <label className="check admin-feature-check">
                  <input
                    type="checkbox"
                    checked={makeFeatured}
                    onChange={(e) => setMakeFeatured(e.target.checked)}
                    disabled={savingTournament}
                  />
                  <span>Feature on Homepage Hero Banner</span>
                </label>
              </div>

              <label className="field">
                <span>Prize Image Path or URL</span>
                <input
                  type="text"
                  value={prizeImagePath}
                  onChange={(e) => setPrizeImagePath(e.target.value)}
                  disabled={savingTournament || uploading}
                />
              </label>

              <div className="row">
                {PRIZE_ART_PRESETS.map((preset) => (
                  <button
                    key={preset.path}
                    type="button"
                    className={`btn btn--ghost btn--sm${prizeImagePath === preset.path ? ' is-selected-pill' : ''}`}
                    onClick={() => setPrizeImagePath(preset.path)}
                    disabled={savingTournament || uploading}
                  >
                    {preset.label}
                  </button>
                ))}
                <label className="btn btn--ghost btn--sm file-upload-btn">
                  <span>{uploading ? 'Uploading…' : 'Upload PNG/JPG/WebP'}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => void onUploadFile(e)}
                    disabled={savingTournament || uploading}
                  />
                </label>
              </div>

              <label className="field">
                <span>Description</span>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={savingTournament}
                />
              </label>
            </div>

            <div className="tournament-banner__preview-pane">
              <span className="eyebrow">Banner Prize Preview</span>
              <div className="tournament-banner__art-frame">
                <img src={resolveTournamentImageUrl(prizeImagePath)} alt={prizeName || 'Prize preview'} />
              </div>
              <div className="tournament-banner__prize-tag">
                <span className="muted small">Prize Display</span>
                <strong>{prizeName || '—'}</strong>
              </div>
            </div>
          </div>

          {tournamentMsg && (
            <p className={tournamentMsg.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
              {tournamentMsg.text}
            </p>
          )}

          <div className="row">
            <button type="submit" className="btn btn--gold" disabled={savingTournament || uploading}>
              {savingTournament
                ? 'Saving…'
                : editingId
                  ? 'Save Tournament Changes'
                  : 'Create Tournament'}
            </button>
            {editingId && (
              <Link className="btn btn--ghost" to={`/tournaments/${editingId}`}>
                Open Tournament Page
              </Link>
            )}
          </div>
        </form>

        {tournaments.length > 0 && (
          <div className="admin-table-wrap">
            <h3>All Tournaments</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Prize</th>
                  <th>Starts</th>
                  <th>Fee</th>
                  <th>Status</th>
                  <th>Banner</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tournaments.map((t) => (
                  <tr key={t.id} className={t.id === editingId ? 'is-selected-row' : ''}>
                    <td>{t.title}</td>
                    <td>{t.prize_name}</td>
                    <td>{formatDateTime(t.starts_at)}</td>
                    <td>{formatChips(t.entry_fee)}</td>
                    <td>{t.status}</td>
                    <td>
                      {t.is_featured ? (
                        <span className="badge badge--open">Featured</span>
                      ) : t.status !== 'draft' ? (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => void onFeatureTournament(t.id)}
                        >
                          Set as Banner
                        </button>
                      ) : (
                        <span className="muted small">Draft</span>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => selectTournamentForEdit(t)}
                        >
                          Edit
                        </button>
                        {!t.is_featured && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => void onDeleteTournament(t.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2. Economy & House Configuration */}
      <div className="admin-two-col">
        <section className="admin-panel-card" aria-label="House economy configuration">
          <p className="eyebrow">app_config · Validated Server RPC</p>
          <h2>Economy &amp; Timer Rules</h2>
          <form className="form" onSubmit={onSaveConfig}>
            <label className="field">
              <span>Daily Bonus Amount (Chips)</span>
              <input
                type="number"
                min={1}
                required
                value={dailyBonus}
                onChange={(e) => setDailyBonus(e.target.value)}
                disabled={savingConfig}
              />
              <small className="hint">
                New signups automatically receive 10× this amount ({formatChips(Number(dailyBonus) * 10)} chips).
              </small>
            </label>
            <div className="field-row">
              <label className="field">
                <span>Daily Reset Hour (0–23)</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  required
                  value={resetHour}
                  onChange={(e) => setResetHour(e.target.value)}
                  disabled={savingConfig}
                />
              </label>
              <label className="field">
                <span>Reset Timezone (IANA)</span>
                <input
                  type="text"
                  required
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  disabled={savingConfig}
                />
              </label>
            </div>
            <label className="field">
              <span>Turn Timeout (Seconds, 5–120)</span>
              <input
                type="number"
                min={5}
                max={120}
                required
                value={turnTimeout}
                onChange={(e) => setTurnTimeout(e.target.value)}
                disabled={savingConfig}
              />
            </label>
            {configMsg && (
              <p className={configMsg.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
                {configMsg.text}
              </p>
            )}
            <button type="submit" className="btn btn--gold" disabled={savingConfig}>
              {savingConfig ? 'Saving…' : 'Save Configuration'}
            </button>
          </form>
          {configs.length > 0 && <p className="muted small">All changes take effect immediately in database RPCs.</p>}
        </section>

        {/* 3. Audited Balance Adjustment */}
        <section className="admin-panel-card" aria-label="Ledgered balance adjustment">
          <p className="eyebrow">admin_adjust_balance · Append-Only Ledger</p>
          <h2>Player Balance Adjustment</h2>
          <form className="form" onSubmit={onAdjustBalance}>
            <label className="field">
              <span>Player</span>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                disabled={savingAdjust}
              >
                {players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.username}
                  </option>
                ))}
              </select>
            </label>
            {selectedUserId && (
              <div className="row">
                {(() => {
                  const p = players.find((x) => x.id === selectedUserId);
                  return p ? (
                    <>
                      <Avatar avatarId={p.avatar_id} userId={p.id} size={32} />
                      <span className="muted small">ID: {p.id.slice(0, 8)}…</span>
                    </>
                  ) : null;
                })()}
              </div>
            )}
            <label className="field">
              <span>Chip Delta (positive to grant, negative to deduct)</span>
              <input
                type="number"
                required
                placeholder="e.g. 2500 or -500"
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                disabled={savingAdjust}
              />
            </label>
            <label className="field">
              <span>Mandatory Audit Reason</span>
              <input
                type="text"
                required
                minLength={3}
                placeholder="e.g. Tournament prize payout"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                disabled={savingAdjust}
              />
            </label>
            {adjustMsg && (
              <p className={adjustMsg.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
                {adjustMsg.text}
              </p>
            )}
            <button type="submit" className="btn btn--gold" disabled={savingAdjust}>
              {savingAdjust ? 'Applying…' : 'Apply Ledger Adjustment'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

