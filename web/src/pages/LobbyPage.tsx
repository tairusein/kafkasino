import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useSound } from '../audio/SoundProvider';
import { Avatar } from '../components/Avatar';
import { useNavigate } from '../components/GuardLink';
import { useI18n } from '../i18n/I18nProvider';
import { humanizeError } from '../lib/errors';
import { formatChips } from '../lib/format';
import { supabase } from '../lib/supabase';
import type { GameCatalogEntry, Room, RoomVisibility } from '../lib/types';

interface RoomRow extends Room {
  host_username?: string;
  host_avatar_id?: string;
  player_count: number;
  is_member: boolean;
}

const DEFAULT_GAMES: GameCatalogEntry[] = [
  { slug: 'blackjack', name: 'Blackjack', min_players: 1, max_players: 5, is_enabled: true },
  { slug: 'checkers', name: 'Checkers', min_players: 2, max_players: 2, is_enabled: true },
  { slug: 'chess', name: 'Chess', min_players: 2, max_players: 2, is_enabled: true },
  { slug: 'durak', name: 'Durak', min_players: 2, max_players: 4, is_enabled: true },
  { slug: 'roulette', name: 'Roulette', min_players: 1, max_players: 8, is_enabled: true },
  { slug: 'slots', name: 'Slots', min_players: 1, max_players: 1, is_enabled: true },
  { slug: 'poker', name: "Texas Hold'em", min_players: 2, max_players: 6, is_enabled: true },
];

const GAME_ICONS: Record<string, string> = {
  blackjack: '♠',
  poker: '♦',
  roulette: '◎',
  slots: '777',
  durak: '♣',
  chess: '♔',
  checkers: '⛃',
};

export function LobbyPage() {
  const { user } = useAuth();
  const { sound } = useSound();
  const { t, gameName } = useI18n();
  const nav = useNavigate();

  const [games, setGames] = useState<GameCatalogEntry[]>(DEFAULT_GAMES);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [myActiveRoom, setMyActiveRoom] = useState<Room | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickOpeningSlug, setQuickOpeningSlug] = useState<string | null>(null);

  // Create-Room modal / drawer state
  const [createOpen, setCreateOpen] = useState(false);
  const [newGame, setNewGame] = useState('blackjack');
  const [newName, setNewName] = useState('');
  const [newVisibility, setNewVisibility] = useState<RoomVisibility>('public');
  const [newMaxPlayers, setNewMaxPlayers] = useState(5);
  const [newMinBet, setNewMinBet] = useState(100);
  const [creating, setCreating] = useState(false);

  // Join-by-PIN state
  const [pinInput, setPinInput] = useState('');
  const [joiningPin, setJoiningPin] = useState(false);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

  const selectedCatalogGame = useMemo(
    () => games.find((g) => g.slug === newGame) ?? games[0] ?? null,
    [games, newGame],
  );

  // Clamp maxPlayers whenever the selected game changes
  useEffect(() => {
    if (!selectedCatalogGame) return;
    setNewMaxPlayers((prev) =>
      Math.min(selectedCatalogGame.max_players, Math.max(selectedCatalogGame.min_players, prev)),
    );
  }, [selectedCatalogGame]);

  const loadLobby = useCallback(async () => {
    const [gamesRes, roomsRes, mySeatRes] = await Promise.all([
      supabase.from('game_catalog').select('*').order('name'),
      supabase
        .from('rooms')
        .select('*, room_players(user_id)')
        .eq('visibility', 'public')
        .in('status', ['waiting', 'playing'])
        .order('created_at', { ascending: false })
        .limit(50),
      user
        ? supabase
            .from('room_players')
            .select('room_id, left_at, rooms(*)')
            .eq('user_id', user.id)
            .is('left_at', null)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (gamesRes.data && gamesRes.data.length > 0) {
      const bySlug = new Map<string, GameCatalogEntry>();
      for (const g of DEFAULT_GAMES) {
        bySlug.set(g.slug, { ...g, is_enabled: true });
      }
      for (const dbGame of gamesRes.data as GameCatalogEntry[]) {
        bySlug.set(dbGame.slug, { ...dbGame, is_enabled: true });
      }
      const merged = Array.from(bySlug.values()).sort((a, b) => a.name.localeCompare(b.name));
      setGames(merged);
    }

    // Check if the current user is seated in an active room (public or private)
    if (mySeatRes.data) {
      const activeSeats = (mySeatRes.data as unknown as { room_id: string; rooms: Room | null }[])
        .map((r) => r.rooms)
        .filter((r): r is Room => Boolean(r && (r.status === 'waiting' || r.status === 'playing')));
      setMyActiveRoom(activeSeats[0] ?? null);
    }

    if (roomsRes.data) {
      const rawRooms = roomsRes.data as (Room & {
        room_players?: { user_id: string; left_at?: string | null }[];
      })[];

      const hostIds = Array.from(
        new Set(rawRooms.map((r) => r.host_id).filter((id): id is string => Boolean(id))),
      );

      const hostMap = new Map<string, { username: string; avatar_id: string }>();
      if (hostIds.length > 0) {
        const { data: hosts } = await supabase
          .from('profiles')
          .select('id, username, avatar_id')
          .in('id', hostIds);
        if (hosts) {
          for (const h of hosts as { id: string; username: string; avatar_id: string }[]) {
            hostMap.set(h.id, { username: h.username, avatar_id: h.avatar_id });
          }
        }
      }

      // Query active (left_at is null) room_players counts for these rooms
      const roomIds = rawRooms.map((r) => r.id);
      const activeByRoom = new Map<string, Set<string>>();
      if (roomIds.length > 0) {
        const { data: activePlayers } = await supabase
          .from('room_players')
          .select('room_id, user_id')
          .in('room_id', roomIds)
          .is('left_at', null);
        if (activePlayers) {
          for (const ap of activePlayers as { room_id: string; user_id: string }[]) {
            const set = activeByRoom.get(ap.room_id) ?? new Set<string>();
            set.add(ap.user_id);
            activeByRoom.set(ap.room_id, set);
          }
        }
      }

      const enriched: RoomRow[] = rawRooms
        .map((r) => {
          const activeSet = activeByRoom.get(r.id) ?? new Set<string>();
          const host = r.host_id ? hostMap.get(r.host_id) : undefined;
          return {
            ...r,
            host_username: host?.username ?? 'House',
            host_avatar_id: host?.avatar_id ?? 'fox',
            player_count: activeSet.size,
            is_member: Boolean(user && activeSet.has(user.id)),
          };
        })
        // Hide abandoned rooms with 0 seated players
        .filter((r) => r.player_count > 0);

      setRooms(enriched);
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    void loadLobby();

    // Realtime subscription: keep the public room list & seat counts live
    const channel = supabase
      .channel('kafkasino:lobby')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
        void loadLobby();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players' }, () => {
        void loadLobby();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadLobby]);

  /**
   * Instant-Play handler for clicking "OPEN" on any of the 7 game cards:
   * 1. If the user is already seated in a room of this game type, re-enter it immediately.
   * 2. If there is a public waiting room for this game with open seats (and not solo slots), join it.
   * 3. Otherwise, create a fresh public room for this game and enter immediately.
   */
  async function handleQuickOpenGame(game: GameCatalogEntry) {
    if (!user) {
      nav('/login');
      return;
    }

    setError(null);
    setQuickOpeningSlug(game.slug);
    sound.play('cardSlide');

    try {
      // 1. If already seated in this exact game, go straight there
      if (myActiveRoom && myActiveRoom.game === game.slug) {
        nav(`/games/${game.slug}/${myActiveRoom.id}`);
        return;
      }

      // 2. If user is currently seated in a DIFFERENT game room, leave it cleanly first
      if (myActiveRoom && myActiveRoom.game !== game.slug) {
        await supabase.rpc('leave_room', { p_room_id: myActiveRoom.id });
      }

      // 3. Look for an open public room for this game with available seats
      const openCandidate =
        game.max_players > 1
          ? rooms.find(
              (r) =>
                r.game === game.slug &&
                (r.status === 'waiting' || r.status === 'playing') &&
                r.player_count < r.max_players,
            )
          : undefined;

      if (openCandidate) {
        const { error: joinErr } = await supabase.rpc('join_room', { p_room_id: openCandidate.id });
        if (!joinErr) {
          nav(`/games/${game.slug}/${openCandidate.id}`);
          return;
        }
      }

      // 4. Create a new public room for this game and enter immediately
      const { data: createdRoom, error: createErr } = await supabase.rpc('create_room', {
        p_game: game.slug,
        p_visibility: 'public',
        p_name: `${gameName(game.slug, game.name)} Salon`,
        p_max_players: game.max_players,
        p_min_bet: 100,
      });

      if (createErr) {
        setError(humanizeError(createErr));
        return;
      }

      const roomData = createdRoom as Room;
      nav(`/games/${roomData.game}/${roomData.id}`);
    } finally {
      setQuickOpeningSlug(null);
    }
  }

  async function handleCreateRoom(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('create_room', {
        p_game: newGame,
        p_visibility: newVisibility,
        p_name: newName.trim() || null,
        p_max_players: newMaxPlayers,
        p_min_bet: newMinBet,
      });
      if (rpcErr) {
        setError(humanizeError(rpcErr));
        return;
      }
      const created = data as Room;
      sound.play('cardSlide');
      nav(`/games/${created.game}/${created.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleJoinRoom(room: RoomRow) {
    setError(null);
    setJoiningRoomId(room.id);
    try {
      const { error: rpcErr } = await supabase.rpc('join_room', { p_room_id: room.id });
      if (rpcErr) {
        setError(humanizeError(rpcErr));
        return;
      }
      sound.play('cardSlide');
      nav(`/games/${room.game}/${room.id}`);
    } finally {
      setJoiningRoomId(null);
    }
  }

  async function handleJoinByPin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleaned = pinInput.trim().toUpperCase();
    if (cleaned.length !== 6) {
      setError('Enter the 6-character room PIN.');
      return;
    }
    setJoiningPin(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('join_room_by_pin', {
        p_pin: cleaned,
      });
      if (rpcErr) {
        setError(humanizeError(rpcErr));
        return;
      }
      const joined = data as Room;
      sound.play('cardSlide');
      setPinInput('');
      nav(`/games/${joined.game}/${joined.id}`);
    } finally {
      setJoiningPin(false);
    }
  }

  const visibleRooms = filter === 'all' ? rooms : rooms.filter((r) => r.game === filter);

  return (
    <section>
      <header className="page-head">
        <div>
          <p className="eyebrow">{t('lobby.eyebrow')}</p>
          <h1>{t('lobby.title')}</h1>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn--gold"
            onClick={() => {
              setError(null);
              setCreateOpen((v) => !v);
            }}
          >
            {createOpen ? '×' : `+ ${t('lobby.newRoom')}`}
          </button>
        </div>
      </header>

      {error && (
        <p className="form-error" role="alert" style={{ marginBottom: '1.25rem' }}>
          {error}
        </p>
      )}

      {/* Active Seated Room Banner */}
      {myActiveRoom && (
        <div className="active-room-banner">
          <div>
            <p className="eyebrow">{t('lobby.activeBannerEyebrow')}</p>
            <strong>
              {myActiveRoom.name} ({gameName(myActiveRoom.game, myActiveRoom.game)})
            </strong>
            {myActiveRoom.pin_code && (
              <span className="muted small"> · PIN: {myActiveRoom.pin_code}</span>
            )}
          </div>
          <button
            type="button"
            className="btn btn--gold btn--sm"
            onClick={() => nav(`/games/${myActiveRoom.game}/${myActiveRoom.id}`)}
          >
            {t('lobby.returnToTable')} →
          </button>
        </div>
      )}

      {/* Create Room Drawer */}
      {createOpen && (
        <form className="lobby-create-card form" onSubmit={handleCreateRoom}>
          <div className="admin-panel-card__head">
            <div>
              <p className="eyebrow">{t('lobby.hostEyebrow')}</p>
              <h2>{t('lobby.newRoom')}</h2>
            </div>
          </div>

          <div className="field-row">
            <label className="field">
              <span>{t('lobby.game')}</span>
              <select value={newGame} onChange={(e) => setNewGame(e.target.value)}>
                {games.map((g) => (
                  <option key={g.slug} value={g.slug}>
                    {gameName(g.slug, g.name)} (
                    {g.min_players === g.max_players
                      ? `${g.max_players}`
                      : `${g.min_players}–${g.max_players}`}{' '}
                    players)
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>{t('lobby.roomName')}</span>
              <input
                type="text"
                maxLength={40}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`e.g. Velvet ${selectedCatalogGame ? gameName(selectedCatalogGame.slug, selectedCatalogGame.name) : 'Salon'}`}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>{t('lobby.visibility')}</span>
              <select
                value={newVisibility}
                onChange={(e) => setNewVisibility(e.target.value as RoomVisibility)}
              >
                <option value="public">{t('lobby.publicRoom')}</option>
                <option value="private">{t('lobby.privateRoom')}</option>
              </select>
            </label>

            <div className="field-row">
              <label className="field">
                <span>
                  {t('lobby.seats')} ({selectedCatalogGame?.min_players ?? 1}–
                  {selectedCatalogGame?.max_players ?? 6})
                </span>
                <input
                  type="number"
                  min={selectedCatalogGame?.min_players ?? 1}
                  max={selectedCatalogGame?.max_players ?? 6}
                  value={newMaxPlayers}
                  onChange={(e) => setNewMaxPlayers(Number(e.target.value))}
                  required
                />
              </label>

              <label className="field">
                <span>{t('lobby.minBet')}</span>
                <input
                  type="number"
                  min={0}
                  max={1000000}
                  step={50}
                  value={newMinBet}
                  onChange={(e) => setNewMinBet(Number(e.target.value))}
                  required
                />
              </label>
            </div>
          </div>

          <div className="row">
            <button type="submit" className="btn btn--gold" disabled={creating}>
              {creating ? t('lobby.creating') : t('lobby.createAndEnter')}
            </button>
          </div>
        </form>
      )}

      {/* Join Private Room by 6-Char PIN */}
      <form className="pin-join-bar" onSubmit={handleJoinByPin}>
        <div>
          <span className="eyebrow">{t('lobby.privateAccessEyebrow')}</span>
          <p className="muted small" style={{ margin: 0 }}>
            {t('lobby.havePin')}
          </p>
        </div>
        <div className="pin-join-bar__form">
          <input
            type="text"
            maxLength={6}
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value.toUpperCase())}
            placeholder="PIN (e.g. 7K9X2M)"
            aria-label={t('lobby.enterPin')}
            className="pin-join-bar__input"
          />
          <button type="submit" className="btn btn--gold" disabled={joiningPin}>
            {joiningPin ? t('lobby.joining') : t('lobby.join')}
          </button>
        </div>
      </form>

      {/* Game Catalog Cards — Clicking OPEN immediately opens/joins/creates that game */}
      <h2>{t('lobby.chooseGame')}</h2>
      <div className="game-grid">
        {games.map((g) => {
          const isOpening = quickOpeningSlug === g.slug;
          const activeTablesForGame = rooms.filter((r) => r.game === g.slug).length;
          return (
            <div
              key={g.slug}
              className={`game-card game-card--interactive${filter === g.slug ? ' is-active' : ''}`}
              onClick={() => void handleQuickOpenGame(g)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handleQuickOpenGame(g);
                }
              }}
            >
              <div className="game-card__header">
                <span className="game-card__emblem" aria-hidden="true">
                  {GAME_ICONS[g.slug] ?? '♠'}
                </span>
                {activeTablesForGame > 0 && (
                  <span className="game-card__live-pill tabular">
                    ● {activeTablesForGame}
                  </span>
                )}
              </div>

              <span className="game-card__name">{gameName(g.slug, g.name)}</span>
              <span className="game-card__meta">
                {g.min_players === 1 && g.max_players === 1
                  ? t('lobby.singlePlayer')
                  : t('lobby.playersRange', { min: g.min_players, max: g.max_players })}
              </span>

              <div className="game-card__footer">
                <button
                  type="button"
                  className="btn btn--gold btn--sm game-card__open-btn"
                  disabled={isOpening}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleQuickOpenGame(g);
                  }}
                >
                  {isOpening ? t('lobby.entering') : `${t('lobby.open')} →`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Public Rooms Table + Filter Pills */}
      <div className="shop-section-head" style={{ marginTop: '2rem' }}>
        <h2>{t('lobby.openPublicRooms')}</h2>
        <div className="row">
          <div className="lobby-filter-pills" role="group" aria-label="Filter rooms by game">
            <button
              type="button"
              className={`btn btn--ghost btn--sm${filter === 'all' ? ' is-selected-pill' : ''}`}
              onClick={() => setFilter('all')}
            >
              {t('lobby.allGames')}
            </button>
            {games.map((g) => (
              <button
                key={g.slug}
                type="button"
                className={`btn btn--ghost btn--sm${filter === g.slug ? ' is-selected-pill' : ''}`}
                onClick={() => setFilter(filter === g.slug ? 'all' : g.slug)}
              >
                {gameName(g.slug, g.name)}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadLobby()}>
            {t('lobby.refresh')}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="muted">{t('lobby.loadingRooms')}</p>
      ) : visibleRooms.length === 0 ? (
        <p className="muted">{t('lobby.noOpenRooms')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('lobby.colRoom')}</th>
              <th>{t('lobby.colGame')}</th>
              <th>{t('lobby.colHost')}</th>
              <th>{t('lobby.colPlayers')}</th>
              <th>{t('lobby.colMinBet')}</th>
              <th>{t('lobby.colStatus')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleRooms.map((r) => {
              const full = r.player_count >= r.max_players && !r.is_member;
              return (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>{gameName(r.game, r.game)}</td>
                  <td>
                    <div className="row" style={{ gap: '0.5rem' }}>
                      {r.host_id && (
                        <Avatar avatarId={r.host_avatar_id} userId={r.host_id} size={26} />
                      )}
                      <span>{r.host_username}</span>
                    </div>
                  </td>
                  <td className="tabular">
                    {r.player_count} / {r.max_players}
                  </td>
                  <td className="tabular">{formatChips(r.min_bet)}</td>
                  <td>
                    <span
                      className={`badge ${r.status === 'waiting' ? 'badge--open' : ''}`}
                      style={{ marginTop: 0 }}
                    >
                      {r.status === 'waiting'
                        ? t('lobby.status.waiting')
                        : r.status === 'playing'
                          ? t('lobby.status.playing')
                          : t('lobby.status.finished')}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className={r.is_member ? 'btn btn--gold btn--sm' : 'btn btn--ghost btn--sm'}
                      disabled={full || joiningRoomId === r.id}
                      onClick={() => void handleJoinRoom(r)}
                    >
                      {joiningRoomId === r.id
                        ? t('lobby.joining')
                        : r.is_member
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
  );
}
