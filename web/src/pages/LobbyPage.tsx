import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import { OnlinePlayers } from '../components/OnlinePlayers';
import { useI18n } from '../i18n/I18nProvider';
import { friendlyError } from '../lib/errors';
import { formatChips } from '../lib/format';
import { supabase } from '../lib/supabase';
import type { GameCatalogEntry, LobbyRoom, Room, RoomVisibility } from '../lib/types';

const DEFAULT_GAMES: GameCatalogEntry[] = [
  { slug: 'blackjack', name: 'Blackjack', min_players: 1, max_players: 5, is_enabled: true },
  { slug: 'poker', name: "Texas Hold'em", min_players: 2, max_players: 6, is_enabled: true },
  { slug: 'roulette', name: 'European Roulette', min_players: 1, max_players: 8, is_enabled: true },
  { slug: 'slots', name: 'Slots', min_players: 1, max_players: 1, is_enabled: true },
  { slug: 'durak', name: 'Durak', min_players: 2, max_players: 6, is_enabled: true },
  { slug: 'chess', name: 'Chess', min_players: 2, max_players: 2, is_enabled: true },
  { slug: 'checkers', name: 'Checkers', min_players: 2, max_players: 2, is_enabled: true },
];

const GAME_ICONS: Record<string, string> = {
  blackjack: '🂡',
  poker: '♠️',
  roulette: '🎡',
  slots: '🎰',
  durak: '🃏',
  chess: '♔',
  checkers: '⛃',
};

export function LobbyPage() {
  const { user, profile } = useAuth();
  const { sound } = useSound();
  const { t, gameName } = useI18n();
  const navigate = useNavigate();

  const [games, setGames] = useState<GameCatalogEntry[]>(DEFAULT_GAMES);
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingGameSlug, setOpeningGameSlug] = useState<string | null>(null);

  // Create room inline form
  const [showCreate, setShowCreate] = useState(false);
  const [newGameType, setNewGameType] = useState('blackjack');
  const [newName, setNewName] = useState('');
  const [newVisibility, setNewVisibility] = useState<RoomVisibility>('public');
  const [newMaxPlayers, setNewMaxPlayers] = useState('5');
  const [newMinBet, setNewMinBet] = useState('100');
  const [creating, setCreating] = useState(false);

  // Join by PIN form
  const [pinInput, setPinInput] = useState('');
  const [joiningPin, setJoiningPin] = useState(false);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [g, r] = await Promise.all([
      supabase.from('game_catalog').select('*').order('name'),
      supabase
        .from('rooms')
        .select('id, game_type, name, status, max_players, min_bet, created_at, room_players(count)')
        .eq('visibility', 'public')
        .neq('status', 'closed')
        .order('created_at', { ascending: false }),
    ]);
    if (g.error || r.error) {
      setError(friendlyError(g.error ?? r.error));
    } else {
      const dbCatalog = (g.data as GameCatalogEntry[]) ?? [];
      const bySlug = new Map<string, GameCatalogEntry>();
      for (const def of DEFAULT_GAMES) {
        bySlug.set(def.slug, { ...def, is_enabled: true });
      }
      for (const row of dbCatalog) {
        bySlug.set(row.slug, { ...row, is_enabled: true });
      }
      const merged = Array.from(bySlug.values());
      setGames(merged);
      setRooms((r.data as unknown as LobbyRoom[]) ?? []);
    }

    if (user) {
      const { data: seatRow } = await supabase
        .from('room_players')
        .select('room_id')
        .eq('user_id', user.id)
        .maybeSingle();

      const activeRoomId = (seatRow as { room_id?: string } | null)?.room_id;
      if (activeRoomId) {
        const { data: roomData } = await supabase
          .from('rooms')
          .select('*')
          .eq('id', activeRoomId)
          .neq('status', 'closed')
          .maybeSingle();
        setCurrentRoom((roomData as Room | null) ?? null);
      } else {
        setCurrentRoom(null);
      }
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    void load();
    const channel = supabase
      .channel('lobby-rooms-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
        void load();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players' }, () => {
        void load();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const selectedGameDef = useMemo(
    () => games.find((g) => g.slug === newGameType) ?? null,
    [games, newGameType],
  );

  function openCreateForm() {
    if (!newName && profile) {
      setNewName(`${profile.username}'s Table`);
    }
    setShowCreate((prev) => !prev);
  }

  /**
   * Clicking any game card or its OPEN button immediately joins an open table
   * for that game or creates a fresh salon table and navigates into it.
   */
  async function onQuickOpenGame(game: GameCatalogEntry) {
    if (openingGameSlug || creating) return;
    setError(null);
    setOpeningGameSlug(game.slug);
    sound.play('chipClick');

    try {
      if (currentRoom && currentRoom.game_type === game.slug) {
        navigate(`/games/${game.slug}/${currentRoom.id}`);
        return;
      }

      if (game.slug !== 'slots') {
        const openCandidate = rooms.find((rm) => {
          const count = rm.room_players[0]?.count ?? 0;
          return rm.game_type === game.slug && rm.status === 'waiting' && count < rm.max_players;
        });

        if (openCandidate) {
          const { error: joinErr } = await supabase.rpc('join_room', { p_room_id: openCandidate.id });
          if (!joinErr) {
            navigate(`/games/${game.slug}/${openCandidate.id}`);
            return;
          }
        }
      }

      const defaultTableName = `${profile?.username ?? 'Salon'}'s ${gameName(game.slug, game.name)}`;
      const { data, error: createErr } = await supabase.rpc('create_room', {
        p_game_type: game.slug,
        p_name: defaultTableName.slice(0, 40),
        p_visibility: 'public',
        p_max_players: game.max_players,
        p_min_bet: 100,
      });

      if (createErr || !data) {
        setError(friendlyError(createErr));
        return;
      }

      sound.play('cardShuffle');
      const created = data as { room_id: string; pin?: string | null };
      navigate(`/games/${game.slug}/${created.room_id}`);
    } finally {
      setOpeningGameSlug(null);
    }
  }

  async function onCreateRoom(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = newName.trim() || `${profile?.username ?? 'Salon'}'s Table`;

    setCreating(true);
    const { data, error: err } = await supabase.rpc('create_room', {
      p_game_type: newGameType,
      p_name: trimmed.slice(0, 40),
      p_visibility: newVisibility,
      p_max_players: Number(newMaxPlayers) || selectedGameDef?.max_players || 6,
      p_min_bet: Math.max(0, Math.floor(Number(newMinBet) || 0)),
    });

    if (err || !data) {
      setError(friendlyError(err));
      setCreating(false);
      return;
    }

    sound.play('cardShuffle');
    const created = data as { room_id: string; pin?: string | null };
    navigate(`/games/${newGameType}/${created.room_id}`);
  }

  async function onJoinPublicRoom(room: LobbyRoom) {
    setError(null);
    setJoiningRoomId(room.id);
    const { error: err } = await supabase.rpc('join_room', { p_room_id: room.id });
    if (err) {
      setError(friendlyError(err));
      setJoiningRoomId(null);
      return;
    }
    sound.play('chipClick');
    navigate(`/games/${room.game_type}/${room.id}`);
  }

  async function onJoinByPin(e: FormEvent) {
    e.preventDefault();
    const cleaned = pinInput.trim().toUpperCase();
    if (cleaned.length !== 6) {
      setError('Private room PINs are 6 characters (excluding 0, 1, I, O).');
      return;
    }
    setError(null);
    setJoiningPin(true);

    const { data, error: err } = await supabase.rpc('join_room_by_pin', { p_pin: cleaned });
    if (err) {
      setError(friendlyError(err));
      setJoiningPin(false);
      return;
    }

    const res = data as { ok: boolean; error?: string; room_id?: string };
    if (!res.ok || !res.room_id) {
      sound.play('lose');
      setError(friendlyError(res.error ?? 'invalid_pin'));
      setJoiningPin(false);
      return;
    }

    const { data: roomRow } = await supabase
      .from('rooms')
      .select('game_type')
      .eq('id', res.room_id)
      .maybeSingle();

    const gType = ((roomRow as { game_type?: string } | null)?.game_type) ?? 'blackjack';
    sound.play('chipClick');
    navigate(`/games/${gType}/${res.room_id}`);
  }

  async function onLeaveCurrentRoom() {
    if (!currentRoom) return;
    await supabase.rpc('leave_room', { p_room_id: currentRoom.id });
    await load();
  }

  const visible = filter === 'all' ? rooms : rooms.filter((r) => r.game_type === filter);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t('lobby.eyebrow')}</p>
          <h1>{t('lobby.title')}</h1>
        </div>
        <div className="row">
          <button type="button" className="btn btn--gold" onClick={openCreateForm}>
            {showCreate ? '✕' : `+ ${t('lobby.newRoom')}`}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
            {t('lobby.refresh')}
          </button>
        </div>
      </header>

      {/* Active Seated Room Banner */}
      {currentRoom && (
        <div className="active-room-banner" role="status">
          <div>
            <span className="eyebrow">{t('lobby.activeBannerEyebrow')}</span>
            <div>
              <strong>{currentRoom.name}</strong> ({gameName(currentRoom.game_type)})
            </div>
          </div>
          <div className="row">
            <Link className="btn btn--gold btn--sm" to={`/games/${currentRoom.game_type}/${currentRoom.id}`}>
              {t('lobby.returnToTable')} →
            </Link>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onLeaveCurrentRoom()}>
              {t('room.leaveTable')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {/* Inline Create Table Panel (Public or Private PIN) */}
      {showCreate && (
        <section className="lobby-create-card" aria-label="Create a table">
          <p className="eyebrow">{t('lobby.hostEyebrow')}</p>
          <h2>{t('lobby.newRoom')}</h2>
          <form className="form" onSubmit={onCreateRoom}>
            <div className="field-row">
              <label className="field">
                <span>{t('lobby.roomName')}</span>
                <input
                  type="text"
                  required
                  minLength={1}
                  maxLength={40}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={creating}
                />
              </label>
              <label className="field">
                <span>{t('lobby.game')}</span>
                <select
                  value={newGameType}
                  onChange={(e) => {
                    const slug = e.target.value;
                    setNewGameType(slug);
                    const def = games.find((g) => g.slug === slug);
                    if (def) setNewMaxPlayers(String(def.max_players));
                  }}
                  disabled={creating}
                >
                  {games.map((g) => (
                    <option key={g.slug} value={g.slug}>
                      {gameName(g.slug, g.name)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="field-row">
              <label className="field">
                <span>{t('lobby.visibility')}</span>
                <select
                  value={newVisibility}
                  onChange={(e) => setNewVisibility(e.target.value as RoomVisibility)}
                  disabled={creating}
                >
                  <option value="public">{t('lobby.publicRoom')}</option>
                  <option value="private">{t('lobby.privateRoom')}</option>
                </select>
              </label>
              <label className="field">
                <span>
                  {t('lobby.seats')} (
                  {selectedGameDef ? `${selectedGameDef.min_players}–${selectedGameDef.max_players}` : '1–6'})
                </span>
                <input
                  type="number"
                  min={selectedGameDef?.min_players ?? 1}
                  max={selectedGameDef?.max_players ?? 6}
                  required
                  value={newMaxPlayers}
                  onChange={(e) => setNewMaxPlayers(e.target.value)}
                  disabled={creating}
                />
              </label>
            </div>

            <div className="field-row">
              <label className="field">
                <span>{t('lobby.minBet')}</span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  required
                  value={newMinBet}
                  onChange={(e) => setNewMinBet(e.target.value)}
                  disabled={creating}
                />
              </label>
              <div className="lobby-create-card__submit">
                <button type="submit" className="btn btn--gold btn--block" disabled={creating}>
                  {creating ? t('lobby.creating') : t('lobby.createAndEnter')}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* Join Private Room by PIN Bar */}
      <section className="pin-join-bar" aria-label="Join private room by PIN">
        <div>
          <span className="eyebrow">{t('lobby.privateAccessEyebrow')}</span>
          <strong>{t('lobby.havePin')}</strong>
        </div>
        <form className="pin-join-bar__form" onSubmit={onJoinByPin}>
          <input
            type="text"
            maxLength={6}
            placeholder="PIN (e.g. K7M9P2)"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value.toUpperCase())}
            disabled={joiningPin}
            className="pin-join-bar__input tabular"
          />
          <button type="submit" className="btn btn--gold" disabled={joiningPin || pinInput.trim().length !== 6}>
            {joiningPin ? t('lobby.joining') : t('lobby.join')}
          </button>
        </form>
      </section>

      {/* Interactive Game Cards Grid — Clicking OPEN or the Card Launches the Game Immediately */}
      <section aria-label="Games" className="lobby-games-section">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.65rem' }}>
          <span className="eyebrow">{t('lobby.chooseGame')}</span>
        </div>
        <div className="game-grid">
          {games.map((g) => {
            const isOpening = openingGameSlug === g.slug;
            const openRoomsForGame = rooms.filter((r) => r.game_type === g.slug).length;
            return (
              <div
                key={g.slug}
                role="button"
                tabIndex={0}
                className={`game-card${filter === g.slug ? ' is-active' : ''}${isOpening ? ' is-opening' : ''}`}
                onClick={() => void onQuickOpenGame(g)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void onQuickOpenGame(g);
                  }
                }}
              >
                <div className="game-card__top">
                  <span className="game-card__icon" aria-hidden="true">
                    {GAME_ICONS[g.slug] ?? '🎲'}
                  </span>
                  {openRoomsForGame > 0 && (
                    <span className="badge tabular">{openRoomsForGame} live</span>
                  )}
                </div>
                <span className="game-card__name">{gameName(g.slug, g.name)}</span>
                <span className="game-card__meta">
                  {g.min_players === 1 && g.max_players === 1
                    ? t('lobby.singlePlayer')
                    : t('lobby.playersRange', { min: g.min_players, max: g.max_players })}
                </span>
                <div className="game-card__actions">
                  <button
                    type="button"
                    className="badge badge--open game-card__cta"
                    disabled={isOpening}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onQuickOpenGame(g);
                    }}
                  >
                    {isOpening ? t('lobby.entering') : `${t('lobby.open')} →`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Public Rooms Table with Filter Pills */}
      <section aria-label="Public rooms">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{t('lobby.openPublicRooms')}</h2>
          <div className="lobby-filter-pills" role="group" aria-label="Filter rooms by game">
            <button
              type="button"
              className={`btn btn--sm ${filter === 'all' ? 'btn--gold' : 'btn--ghost'}`}
              onClick={() => setFilter('all')}
            >
              {t('lobby.allGames')}
            </button>
            {games.map((g) => (
              <button
                key={g.slug}
                type="button"
                className={`btn btn--sm ${filter === g.slug ? 'btn--gold' : 'btn--ghost'}`}
                onClick={() => setFilter(filter === g.slug ? 'all' : g.slug)}
              >
                {gameName(g.slug, g.name)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="muted">{t('lobby.loadingRooms')}</p>
        ) : visible.length === 0 ? (
          <p className="muted">{t('lobby.noOpenRooms')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('lobby.colRoom')}</th>
                <th>{t('lobby.colGame')}</th>
                <th>{t('lobby.colPlayers')}</th>
                <th>{t('lobby.colMinBet')}</th>
                <th>{t('lobby.colStatus')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const seatedCount = r.room_players[0]?.count ?? 0;
                const full = seatedCount >= r.max_players;
                const isMyCurrent = currentRoom?.id === r.id;
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td>{gameName(r.game_type)}</td>
                    <td className="tabular">
                      {seatedCount} / {r.max_players}
                    </td>
                    <td className="tabular">{formatChips(r.min_bet)}</td>
                    <td>
                      {r.status === 'playing' ? t('lobby.status.playing') : t('lobby.status.waiting')}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--gold btn--sm"
                        onClick={() => void onJoinPublicRoom(r)}
                        disabled={(full && !isMyCurrent) || joiningRoomId === r.id}
                      >
                        {isMyCurrent
                          ? t('lobby.reEnter')
                          : full
                            ? t('lobby.seatFull')
                            : t('lobby.takeSeat')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <OnlinePlayers />
    </div>
  );
}
