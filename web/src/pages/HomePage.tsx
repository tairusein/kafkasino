import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { OnlinePlayers } from '../components/OnlinePlayers';
import { TournamentBanner } from '../components/TournamentBanner';
import { useI18n } from '../i18n/I18nProvider';

export function HomePage() {
  const { profile } = useAuth();
  const { t } = useI18n();

  return (
    <div className="page">
      <TournamentBanner />

      <section className="hero">
        <p className="eyebrow">
          {t('home.eyebrow')}
          {profile ? ` · ${profile.username}` : ''}
        </p>
        <h1>The house is open.</h1>
        <p className="muted hero__lead">{t('home.subtitle')}</p>
        <div className="row">
          <Link className="btn btn--gold" to="/lobby">
            {t('home.enterLobby')}
          </Link>
          <Link className="btn btn--ghost" to="/tournaments">
            {t('nav.tournaments')}
          </Link>
          <Link className="btn btn--ghost" to="/shop">
            {t('nav.shop')}
          </Link>
          <Link className="btn btn--ghost" to="/profile">
            {t('home.viewProfile')}
          </Link>
        </div>
      </section>

      <OnlinePlayers />
    </div>
  );
}
