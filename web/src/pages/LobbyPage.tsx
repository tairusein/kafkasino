import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSound } from '../audio/SoundProvider';
import { useAuth } from '../auth/AuthProvider';
import { OnlinePlayers } from '../components/OnlinePlayers';
import { friendlyError } from '../lib/errors';
import { formatChips } from '../lib/format';
import { supabase } from '../lib/supabase';
import type { GameCatalogEntry, LobbyRoom, Room, RoomVisibility } from '../lib/types';

export function LobbyPage() {
  const { user, profile } = useAuth();
  const { sound } = useSound();
  const navigate = useNavigate();

  const [games, setGames] = useState<GameCatalogEntry[]>([]);
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create room inline form
  const [showCreate, setShowCreate] = useState(false);
  const [newGameType, setNewGameType] = useState('blackjack');
  const [newName, setNewName] = useState('');
  const [newVisibility, setNewVisibility] = useState<RoomVisibility>('public');
  const [newMaxPlayers, setNewMaxPlayers] = useState('6');
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
      const catalog = g.data as GameCatalogEntry[];
      setGames(catalog);
      setRooms(r.data as unknown as LobbyRoom[]);
      const firstEnabled = catalog.find((x) => x.is_enabled);
      if (firstEnabled) {
        setNewGameType((prev) => prev || firstEnabled.slug);
      }
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

  async function onCreateRoom(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = newName.trim();
    if (!trimmed) {
      setError('Please enter a table name.');
      return;
    }

    setCreating(true);
    const { data, error: err } = await supabase.rpc('create_room', {
      p_game_type: newGameType,
      p_name: trimmed,
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

  const gameName = (slug: string) => games.find((g) => g.slug === slug)?.name ?? slug;
  const visible = filter === 'all' ? rooms : rooms.filter((r) => r.game_type === filter);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Lobby</p>
          <h1>Choose your table</h1>
        </div>
        <div className="row">
          <button type="button" className="btn btn--gold" onClick={openCreateForm}>
            {showCreate ? 'Close Table Creator' : '+ Create Table'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {/* Active Seated Room Banner */}
      {currentRoom && (
        <div className="active-room-banner" role="status">
          <div>
            <span className="eyebrow">Active Seat Reserved</span>
            <div>
              You are currently seated at <strong>{currentRoom.name}</strong> ({gameName(currentRoom.game_type)}).
            </div>
          </div>
          <div className="row">
            <Link className="btn btn--gold btn--sm" to={`/games/${currentRoom.game_type}/${currentRoom.id}`}>
              Rejoin Table →
            </Link>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onLeaveCurrentRoom()}>
              Leave Table
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
          <p className="eyebrow">Host a Table</p>
          <h2>Create Public or Private Room</h2>
          <form className="form" onSubmit={onCreateRoom}>
            <div className="field-row">
              <label className="field">
                <span>Table Name</span>
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
                <span>Game</span>
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
                  {games
                    .filter((g) => g.is_enabled)
                    .map((g) => (
                      <option key={g.slug} value={g.slug}>
                        {g.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <div className="field-row">
              <label className="field">
                <span>Room Visibility</span>
                <select
                  value={newVisibility}
                  onChange={(e) => setNewVisibility(e.target.value as RoomVisibility)}
                  disabled={creating}
                >
                  <option value="public">Public (Visible in Lobby)</option>
                  <option value="private">Private (Accessible via 6-Character PIN)</option>
                </select>
              </label>
              <label className="field">
                <span>
                  Max Seats (
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
                <span>Minimum Bet (Chips)</span>
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
                  {creating
                    ? 'Opening Table…'
                    : newVisibility === 'private'
                      ? 'Create Private Room & Generate PIN'
                      : 'Create Public Room'}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* Join Private Room by PIN Bar */}
      <section className="pin-join-bar" aria-label="Join private room by PIN">
        <div>
          <span className="eyebrow">Private Salon Access</span>
          <strong>Have a 6-character Room PIN?</strong>
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
            {joiningPin ? 'Joining…' : 'Join Private Room'}
          </button>
        </form>
      </section>

      <section aria-label="Games" className="game-grid">
        {games.map((g) => (
          <button
            key={g.slug}
            className={`game-card${filter === g.slug ? ' is-active' : ''}${g.is_enabled ? '' : ' is-soon'}`}
            onClick={() => setFilter(filter === g.slug ? 'all' : g.slug)}
          >
            <span className="game-card__name">{g.name}</span>
            <span className="game-card__meta">
              {g.min_players === g.max_players ? `${g.min_players}` : `${g.min_players}–${g.max_players}`} players
            </span>
            <span className={`badge${g.is_enabled ? ' badge--open' : ''}`}>{g.is_enabled ? 'Open' : 'Coming soon'}</span>
          </button>
        ))}
      </section>

      <section aria-label="Public rooms">
        <h2>Public rooms</h2>
        {loading ? (
          <p className="muted">Loading rooms…</p>
        ) : visible.length === 0 ? (
          <p className="muted">No public rooms are open right now. Click &ldquo;+ Create Table&rdquo; above to open one.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Game</th>
                <th>Players</th>
                <th>Min bet</th>
                <th>Status</th>
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
                    <td>{r.status === 'playing' ? 'In play' : 'Waiting'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--gold btn--sm"
                        onClick={() => void onJoinPublicRoom(r)}
                        disabled={(full && !isMyCurrent) || joiningRoomId === r.id}
                      >
                        {isMyCurrent ? 'Rejoin' : full ? 'Full' : 'Join Table'}
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
