import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { TournamentBanner } from '../components/TournamentBanner';

export function HomePage() {
  const { profile } = useAuth();

  return (
    <div className="page">
      <TournamentBanner />

      <section className="hero">
        <p className="eyebrow">Welcome{profile ? `, ${profile.username}` : ''}</p>
        <h1>The house is open.</h1>
        <p className="muted hero__lead">
          Blackjack, roulette, slots, poker and the classics — played with friends at tables of your choosing.
        </p>
        <div className="row">
          <Link className="btn btn--gold" to="/lobby">
            Enter the lobby
          </Link>
          <Link className="btn btn--ghost" to="/tournaments">
            Tournaments
          </Link>
          <Link className="btn btn--ghost" to="/shop">
            Customization Shop
          </Link>
          <Link className="btn btn--ghost" to="/profile">
            Your profile
          </Link>
        </div>
      </section>
    </div>
  );
}
