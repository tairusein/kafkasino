import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useOnlineIds } from '../presence/PresenceProvider';
import { Avatar } from './Avatar';

interface Row {
  id: string;
  username: string;
  avatar_id: string;
}

const MAX = 24;

/** Who is online right now (Presence ids → profile rows). */
export function OnlinePlayers() {
  const ids = useOnlineIds();
  const [rows, setRows] = useState<Row[]>([]);
  // Stable key so the effect only reruns when membership actually changes.
  const key = [...ids].sort().slice(0, MAX).join(',');

  useEffect(() => {
    if (!key) {
      setRows([]);
      return;
    }
    let cancelled = false;
    void supabase
      .from('profiles')
      .select('id, username, avatar_id')
      .in('id', key.split(','))
      .then(({ data }) => {
        if (!cancelled && data) setRows(data as Row[]);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return (
    <section aria-label="Players online">
      <h2>
        Online now <span className="count-pill">{ids.size}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="muted">Nobody else is around yet.</p>
      ) : (
        <ul className="online-list">
          {rows.map((r) => (
            <li key={r.id} className="online-list__item">
              <Avatar avatarId={r.avatar_id} userId={r.id} size={40} />
              <span>{r.username}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

