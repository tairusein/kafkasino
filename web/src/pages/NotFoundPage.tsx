import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="fullscreen-center">
      <div className="brand brand--large">Kafkasino</div>
      <h1>Page not found</h1>
      <Link className="btn btn--gold" to="/">
        Back to the house
      </Link>
    </div>
  );
}

