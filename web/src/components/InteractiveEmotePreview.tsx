import { Avatar } from './Avatar';
import { EMOTE_SPECS } from '../lib/shop';
import type { InteractiveEmoteAnimation } from '../lib/types';

export function EmoteVectorIcon({
  animation,
  size = 44,
}: {
  animation: InteractiveEmoteAnimation;
  size?: number;
}) {
  switch (animation) {
    case 'slap':
      return (
        <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true">
          <path
            d="M10 38 C22 18, 42 14, 56 22"
            stroke="#c9a24b"
            strokeWidth="2"
            strokeDasharray="3 3"
            strokeLinecap="round"
          />
          <path
            d="M20 44 L16 28 C15 24 19 22 21 26 L24 33 L25 18 C25 14 30 14 30 18 L30 31 L33 16 C34 12 39 13 38 17 L36 31 L40 20 C41 16 46 18 44 22 L40 36 L46 31 C49 29 52 33 48 36 L37 46 C31 51 23 50 20 44 Z"
            fill="#f2ebdd"
            stroke="#6b1424"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <rect x="18" y="45" width="20" height="8" rx="3" fill="#6b1424" stroke="#c9a24b" strokeWidth="1.5" />
        </svg>
      );
    case 'punch':
      return (
        <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true">
          <path
            d="M48 12 L51 20 L59 19 L53 25 L57 32 L49 29 L44 35 L45 27 L38 23 L46 20 Z"
            fill="#e8cf8f"
          />
          <rect x="12" y="36" width="16" height="14" rx="3" transform="rotate(-18 12 36)" fill="#c9a24b" />
          <path
            d="M20 24 C20 16 32 14 40 18 C46 21 48 30 44 38 C40 44 28 46 22 40 C18 36 18 29 20 24 Z"
            fill="#821a2e"
            stroke="#e8cf8f"
            strokeWidth="2.2"
          />
          <path d="M26 28 C32 26 38 28 41 33" stroke="#e8cf8f" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'poop':
      return (
        <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true">
          <path d="M22 14 C20 10 24 8 22 4 M42 16 C40 12 44 10 42 6" stroke="#c9a24b" strokeWidth="1.8" strokeLinecap="round" />
          <path
            d="M32 12 C37 12 39 17 36 20 C42 21 44 27 40 31 C47 32 49 41 42 45 H22 C15 41 17 32 24 31 C20 27 22 21 28 20 C25 17 27 12 32 12 Z"
            fill="#6b4423"
            stroke="#e8cf8f"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="27" cy="33" r="2.2" fill="#f2ebdd" />
          <circle cx="37" cy="33" r="2.2" fill="#f2ebdd" />
          <path d="M28 39 Q32 42 36 39" stroke="#f2ebdd" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'tomato':
      return (
        <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true">
          <circle cx="32" cy="34" r="16" fill="#b3202e" stroke="#e8cf8f" strokeWidth="2" />
          <path
            d="M32 14 L35 21 L42 18 L37 24 L43 28 L35 26 L32 32 L29 26 L21 28 L27 24 L22 18 L29 21 Z"
            fill="#2ecc71"
            stroke="#16161a"
            strokeWidth="1.2"
          />
          <circle cx="14" cy="24" r="3" fill="#b3202e" />
          <circle cx="50" cy="28" r="2.5" fill="#b3202e" />
          <circle cx="48" cy="46" r="3.2" fill="#b3202e" />
        </svg>
      );
    case 'toast':
      return (
        <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true">
          <path d="M32 10 L34 15 L39 17 L34 19 L32 24 L30 19 L25 17 L30 15 Z" fill="#e8cf8f" />
          <path d="M18 18 H28 L26 34 C25 38 21 38 20 34 Z" fill="#d9b863" fillOpacity="0.65" stroke="#f2ebdd" strokeWidth="1.8" />
          <line x1="23" y1="37" x2="23" y2="48" stroke="#f2ebdd" strokeWidth="1.8" />
          <line x1="18" y1="48" x2="28" y2="48" stroke="#f2ebdd" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M36 18 H46 L44 34 C43 38 39 38 38 34 Z" fill="#d9b863" fillOpacity="0.65" stroke="#f2ebdd" strokeWidth="1.8" />
          <line x1="41" y1="37" x2="41" y2="48" stroke="#f2ebdd" strokeWidth="1.8" />
          <line x1="36" y1="48" x2="46" y2="48" stroke="#f2ebdd" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}

interface InteractiveEmoteStageProps {
  animation: InteractiveEmoteAnimation;
  senderAvatarId: string;
  targetAvatarId: string;
  /** Incrementing key or boolean flag that triggers the targeted projectile & recoil animation. */
  playKey: number;
}

/**
 * Renders a targeted avatar-to-avatar interaction stage:
 * When `playKey > 0`, the sender avatar launches the emote across the felt at the opponent's
 * avatar, which recoils on impact with a crisp callout badge.
 */
export function InteractiveEmoteStage({
  animation,
  senderAvatarId,
  targetAvatarId,
  playKey,
}: InteractiveEmoteStageProps) {
  const spec = EMOTE_SPECS[animation];
  const isPlaying = playKey > 0;

  return (
    <div className="emote-stage" aria-label={`${spec.badge} preview`}>
      <div
        key={`sender-${playKey}`}
        className={`emote-stage__avatar emote-stage__sender${isPlaying ? ' is-casting' : ''}`}
      >
        <Avatar avatarId={senderAvatarId} size={52} />
        <span className="emote-stage__role">You</span>
      </div>

      <div className="emote-stage__lane">
        <div className="emote-stage__track-line" />
        <div
          key={`proj-${playKey}`}
          className={`emote-stage__projectile emote-stage__projectile--${animation}${isPlaying ? ' is-flying' : ''}`}
        >
          <EmoteVectorIcon animation={animation} size={42} />
        </div>
      </div>

      <div
        key={`target-${playKey}`}
        className={`emote-stage__avatar emote-stage__target emote-stage__target--${animation}${
          isPlaying ? ' is-hit' : ''
        }`}
      >
        <Avatar avatarId={targetAvatarId} size={52} />
        <span className="emote-stage__role">Opponent</span>
        {isPlaying && (
          <span key={`burst-${playKey}`} className="emote-stage__impact">
            {spec.impactWord}
          </span>
        )}
      </div>
    </div>
  );
}

