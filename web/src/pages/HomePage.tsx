import { useAuth } from '../auth/AuthProvider';
import { Avatar } from '../components/Avatar';
import { Link } from '../components/GuardLink';
import { TournamentBanner } from '../components/TournamentBanner';
import { useI18n } from '../i18n/I18nProvider';
import { usePresence } from '../presence/PresenceProvider';

export function HomePage() {
  const { user, profile } = useAuth();
  const { onlineList, count } = usePresence();
  const { t } = useI18n();

  return (
    <section>
      <TournamentBanner />

      <div className="hero">
        <p className="eyebrow">{t('home.eyebrow')}</p>
        <h1>Kafkasino</h1>
        <p className="muted hero__lead">{t('home.subtitle')}</p>
        <div className="row">
          <Link to="/lobby" className="btn btn--gold">
            {t('home.enterLobby')}
          </Link>
          {user && profile ? (
            <Link to="/profile" className="btn btn--ghost">
              {t('home.viewProfile')}
            </Link>
          ) : (
            <Link to="/register" className="btn btn--ghost">
              {t('nav.register')}
            </Link>
          )}
        </div>
      </div>

      <section style={{ marginTop: '2.5rem' }}>
        <h2>
          {t('home.playersOnline')} <span className="count-pill">{count}</span>
        </h2>
        {onlineList.length === 0 ? (
          <p className="muted">{t('home.noOneOnline')}</p>
        ) : (
          <ul className="online-list">
            {onlineList.map((p) => (
              <li key={p.user_id} className="online-list__item">
                <Avatar avatarId={p.avatar_id} userId={p.user_id} size={44} online />
                <div>
                  <strong>{p.username}</strong>
                  {user?.id === p.user_id && <span className="muted small"> {t('home.you')}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
