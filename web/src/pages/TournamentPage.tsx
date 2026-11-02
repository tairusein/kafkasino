import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { friendlyError } from '../lib/errors';
import { formatChips, formatDateTime } from '../lib/format';
import { supabase } from '../lib/supabase';
import { resolveTournamentImageUrl } from '../lib/tournaments';
import type { Profile, Tournament, TournamentParticipant } from '../lib/types';
import { useWallet } from '../wallet/WalletProvider';

interface ParticipantWithProfile extends TournamentParticipant {
  username: string;
  avatar_id: string;
}

function formatCountdown(targetIso: string, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((new Date(targetIso).getTime() - nowMs) / 1000));
  if (diffSec <= 0) return 'Starting now';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

export function TournamentPage() {
  const { id: routeId } = useParams<{ id?: string }>();
  const { user, isAdmin } = useAuth();
  const { balance, refresh: refreshWallet } = useWallet();
  const { sound } = useSound();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [participants, setParticipants] = useState<ParticipantWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick every second for the live countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const loadTournaments = useCallback(async (): Promise<Tournament[]> => {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .order('is_featured', { ascending: false })
      .order('starts_at', { ascending: true });

    if (error || !data) return [];
    const list = data as Tournament[];
    setTournaments(list);
    return list;
  }, []);

  const activeTournament = useMemo<Tournament | null>(() => {
    if (tournaments.length === 0) return null;
    if (routeId) {
      return tournaments.find((t) => t.id === routeId) ?? null;
    }
    return tournaments.find((t) => t.is_featured) ?? tournaments[0] ?? null;
  }, [tournaments, routeId]);

  const activeId = activeTournament?.id ?? null;

  const loadParticipants = useCallback(async (tournamentId: string) => {
    const { data, error } = await supabase
      .from('tournament_participants')
      .select('tournament_id, user_id, fee_paid, registered_at')
      .eq('tournament_id', tournamentId)
      .order('registered_at', { ascending: true });

    if (error || !data) {
      setParticipants([]);
      return;
    }

    const rows = data as TournamentParticipant[];
    if (rows.length === 0) {
      setParticipants([]);
      return;
    }

    const userIds = rows.map((r) => r.user_id);
    const { data: profData } = await supabase
      .from('profiles')
      .select('id, username, avatar_id')
      .in('id', userIds);

    const profMap = new Map<string, Pick<Profile, 'id' | 'username' | 'avatar_id'>>();
    (profData as Pick<Profile, 'id' | 'username' | 'avatar_id'>[] | null)?.forEach((p) => {
      profMap.set(p.id, p);
    });

    setParticipants(
      rows.map((r) => {
        const p = profMap.get(r.user_id);
        return {
          ...r,
          username: p?.username ?? `player_${r.user_id.slice(0, 6)}`,
          avatar_id: p?.avatar_id ?? 'fox',
        };
      }),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadTournaments().then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadTournaments]);

  useEffect(() => {
    if (!activeId) {
      setParticipants([]);
      return;
    }
    setFeedback(null);
    void loadParticipants(activeId);
  }, [activeId, loadParticipants]);

  // Realtime sync on tournaments and tournament_participants.
  useEffect(() => {
    const channel = supabase
      .channel('tournaments-page-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, () => {
        void loadTournaments();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_participants' }, () => {
        if (activeId) void loadParticipants(activeId);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadTournaments, loadParticipants, activeId]);

  const isRegistered = useMemo(
    () => (user ? participants.some((p) => p.user_id === user.id) : false),
    [participants, user],
  );

  async function onRegister() {
    if (!activeTournament) return;
    setBusy(true);
    setFeedback(null);
    sound.play('chipClick');

    const { error } = await supabase.rpc('register_for_tournament', {
      p_tournament_id: activeTournament.id,
    });

    if (error) {
      sound.play('lose');
      setFeedback({ kind: 'error', text: friendlyError(error) });
    } else {
      sound.play('win');
      await Promise.all([loadParticipants(activeTournament.id), refreshWallet()]);
      setFeedback({
        kind: 'ok',
        text: `You are registered for ${activeTournament.title}. Your seat is reserved.`,
      });
    }
    setBusy(false);
  }

  async function onUnregister() {
    if (!activeTournament) return;
    setBusy(true);
    setFeedback(null);

    const { error } = await supabase.rpc('unregister_from_tournament', {
      p_tournament_id: activeTournament.id,
    });

    if (error) {
      setFeedback({ kind: 'error', text: friendlyError(error) });
    } else {
      sound.play('notify');
      await Promise.all([loadParticipants(activeTournament.id), refreshWallet()]);
      setFeedback({
        kind: 'ok',
        text:
          activeTournament.entry_fee > 0
            ? 'Registration withdrawn and entry fee refunded to your balance.'
            : 'Registration withdrawn.',
      });
    }
    setBusy(false);
  }

  if (loading) {
    return (
      <div className="page">
        <p className="muted">Loading tournament…</p>
      </div>
    );
  }

  if (routeId && !activeTournament) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <p className="eyebrow">Tournaments</p>
            <h1>Tournament not found</h1>
          </div>
          <Link className="btn btn--gold" to="/tournaments">
            View all tournaments
          </Link>
        </header>
        <p className="muted">The requested tournament does not exist or is not published yet.</p>
      </div>
    );
  }

  const startsInFuture = activeTournament ? new Date(activeTournament.starts_at).getTime() > nowMs : false;
  const isFull =
    activeTournament?.max_participants != null && participants.length >= activeTournament.max_participants;
  const canRegister =
    activeTournament !== null &&
    activeTournament.status === 'upcoming' &&
    startsInFuture &&
    !isRegistered &&
    !isFull;
  const canWithdraw =
    activeTournament !== null &&
    activeTournament.status === 'upcoming' &&
    startsInFuture &&
    isRegistered;
  const insufficientBalance =
    activeTournament !== null && balance !== null && balance < activeTournament.entry_fee;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">House Championships</p>
          <h1>Tournaments</h1>
        </div>
        <div className="row">
          {isAdmin && (
            <Link className="btn btn--ghost" to="/admin">
              Manage in Admin Panel
            </Link>
          )}
          <Link className="btn btn--ghost" to="/">
            ← Back to Home
          </Link>
        </div>
      </header>

      {!activeTournament ? (
        <p className="muted">No tournaments have been scheduled yet.</p>
      ) : (
        <>
          <article className="tournament-detail" aria-label={activeTournament.title}>
            <div className="tournament-detail__grid">
              <div className="tournament-detail__main">
                <div className="row">
                  {activeTournament.is_featured && <span className="badge badge--open">Featured Banner</span>}
                  <span
                    className={`badge ${
                      activeTournament.status === 'upcoming' || activeTournament.status === 'live' ? 'badge--open' : ''
                    }`}
                  >
                    {activeTournament.status}
                  </span>
                  {activeTournament.game_type && (
                    <span className="badge">{activeTournament.game_type}</span>
                  )}
                </div>

                <h2 className="tournament-detail__title">{activeTournament.title}</h2>
                {activeTournament.description && (
                  <p className="muted tournament-detail__desc">{activeTournament.description}</p>
                )}

                <dl className="tournament-stats-grid">
                  <div className="tournament-stat-box">
                    <dt>Grand Prize</dt>
                    <dd className="tournament-stat-box__gold">{activeTournament.prize_name}</dd>
                  </div>
                  <div className="tournament-stat-box">
                    <dt>Scheduled Start</dt>
                    <dd>{formatDateTime(activeTournament.starts_at)}</dd>
                  </div>
                  <div className="tournament-stat-box">
                    <dt>Countdown</dt>
                    <dd className="tabular">
                      {activeTournament.status === 'upcoming'
                        ? formatCountdown(activeTournament.starts_at, nowMs)
                        : activeTournament.status.toUpperCase()}
                    </dd>
                  </div>
                  <div className="tournament-stat-box">
                    <dt>Entry Fee</dt>
                    <dd>
                      {activeTournament.entry_fee > 0
                        ? `${formatChips(activeTournament.entry_fee)} Chips`
                        : 'Complimentary'}
                    </dd>
                  </div>
                  <div className="tournament-stat-box">
                    <dt>Registered Contenders</dt>
                    <dd>
                      {participants.length}
                      {activeTournament.max_participants != null
                        ? ` / ${activeTournament.max_participants}`
                        : ' (Unlimited)'}
                    </dd>
                  </div>
                </dl>

                {feedback && (
                  <p className={feedback.kind === 'ok' ? 'form-ok' : 'form-error'} role="status">
                    {feedback.text}
                  </p>
                )}

                <div className="tournament-detail__actions">
                  {isRegistered ? (
                    <div className="tournament-registered-bar">
                      <span className="badge badge--open">✓ Registered Contender</span>
                      {canWithdraw && (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => void onUnregister()}
                          disabled={busy}
                        >
                          {busy
                            ? 'Withdrawing…'
                            : activeTournament.entry_fee > 0
                              ? `Withdraw & Refund ${formatChips(activeTournament.entry_fee)} Chips`
                              : 'Withdraw Registration'}
                        </button>
                      )}
                    </div>
                  ) : canRegister ? (
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--gold"
                        onClick={() => void onRegister()}
                        disabled={busy || insufficientBalance}
                      >
                        {busy
                          ? 'Registering…'
                          : activeTournament.entry_fee > 0
                            ? `Register to Participate (${formatChips(activeTournament.entry_fee)} Chips)`
                            : 'Register to Participate (Free Entry)'}
                      </button>
                      {insufficientBalance && (
                        <span className="hint hint--taken">
                          Insufficient balance ({formatChips(balance)} / {formatChips(activeTournament.entry_fee)} chips)
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="muted">
                      {isFull
                        ? 'This tournament has reached maximum capacity.'
                        : activeTournament.status !== 'upcoming'
                          ? `Registration is closed (${activeTournament.status}).`
                          : 'Registration window has closed.'}
                    </p>
                  )}
                </div>
              </div>

              <div className="tournament-detail__showcase">
                <div className="tournament-banner__art-frame">
                  <img
                    src={resolveTournamentImageUrl(activeTournament.prize_image_path)}
                    alt={activeTournament.prize_name}
                    draggable={false}
                  />
                </div>
                <div className="tournament-banner__prize-tag">
                  <span className="eyebrow">Championship Trophy &amp; Prize</span>
                  <strong>{activeTournament.prize_name}</strong>
                </div>
              </div>
            </div>
          </article>

          <section aria-label="Registered participants">
            <h2>
              Registered Contenders <span className="count-pill">{participants.length}</span>
            </h2>
            {participants.length === 0 ? (
              <p className="muted">No contenders registered yet. Be the first to claim a seat.</p>
            ) : (
              <ul className="online-list">
                {participants.map((p, idx) => (
                  <li key={p.user_id} className="online-list__item">
                    <span className="muted small tabular">#{idx + 1}</span>
                    <Avatar avatarId={p.avatar_id} userId={p.user_id} size={40} />
                    <div>
                      <div>{p.username}</div>
                      <div className="muted small">{formatDateTime(p.registered_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {tournaments.length > 1 && (
        <section aria-label="All tournaments">
          <h2>All Championships</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Tournament</th>
                <th>Prize</th>
                <th>Starts</th>
                <th>Entry Fee</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tournaments.map((t) => (
                <tr key={t.id} className={t.id === activeId ? 'is-selected-row' : ''}>
                  <td>
                    <strong>{t.title}</strong>
                    {t.is_featured && <span className="badge badge--open ml-sm">Featured</span>}
                  </td>
                  <td>{t.prize_name}</td>
                  <td>{formatDateTime(t.starts_at)}</td>
                  <td>{t.entry_fee > 0 ? formatChips(t.entry_fee) : 'Free'}</td>
                  <td>{t.status}</td>
                  <td>
                    <Link className="btn btn--ghost btn--sm" to={`/tournaments/${t.id}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

