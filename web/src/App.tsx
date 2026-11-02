import { Route, Routes } from 'react-router-dom';
import { PublicOnly, RequireAdmin, RequireAuth } from './auth/guards';
import { AppLayout, AuthedProviders } from './components/AppLayout';
import { GlobalLoader } from './components/GlobalLoader';
import { AdminPage } from './pages/AdminPage';
import { GameRoomPage } from './pages/GameRoomPage';
import { HomePage } from './pages/HomePage';
import { LobbyPage } from './pages/LobbyPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { ShopPage } from './pages/ShopPage';
import { TournamentPage } from './pages/TournamentPage';

/**
 * Every core section is a dedicated, fully routable page (no modals):
 *   /login  /register                    public only
 *   /  /lobby  /tournaments(/:id)        authenticated
 *   /shop  /profile                      authenticated
 *   /games/:gameType/:roomId             authenticated (Realtime Game Room)
 *   /room/:roomId                        authenticated (Direct Room Invite Link)
 *   /admin                               authenticated + RequireAdmin
 */
export function App() {
  return (
    <>
      <GlobalLoader />
      <Routes>
        <Route element={<PublicOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route element={<AuthedProviders />}>
            <Route element={<AppLayout />}>
              <Route index element={<HomePage />} />
              <Route path="lobby" element={<LobbyPage />} />
              <Route path="tournaments" element={<TournamentPage />} />
              <Route path="tournaments/:id" element={<TournamentPage />} />
              <Route path="shop" element={<ShopPage />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="games/:gameType/:roomId" element={<GameRoomPage />} />
              <Route path="room/:roomId" element={<GameRoomPage />} />

              <Route element={<RequireAdmin />}>
                <Route path="admin" element={<AdminPage />} />
              </Route>
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
