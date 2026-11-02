import { avatarLabel, avatarUrl } from '../lib/avatars';
import { usePresence } from '../presence/PresenceProvider';

interface AvatarProps {
  avatarId: string;
  /** Pass the owner's user id to show the live green "online" dot. Omit for neutral previews. */
  userId?: string | null;
  size?: number;
  className?: string;
}

/**
 * Round avatar portrait. When `userId` is online (Supabase Presence), a crisp green dot sits
 * on the bottom-right of the avatar — the same component is used across the whole site, so the
 * indicator is consistent everywhere.
 */
export function Avatar({ avatarId, userId, size = 40, className = '' }: AvatarProps) {
  const online = usePresence(userId);
  const dot = Math.max(9, Math.round(size * 0.27));

  return (
    <span className={`avatar ${className}`} style={{ width: size, height: size }}>
      <span className="avatar__clip">
        <img src={avatarUrl(avatarId)} alt={avatarLabel(avatarId)} width={size} height={size} draggable={false} />
      </span>
      {online && (
        <span className="avatar__status" style={{ width: dot, height: dot }} role="img" aria-label="Online" title="Online" />
      )}
    </span>
  );
}
