import { useSound } from '../audio/SoundProvider';

export function SoundToggle() {
  const { muted, volume, setMuted, setVolume, sound } = useSound();

  return (
    <div className="sound-toggle">
      <button
        type="button"
        className="icon-btn"
        aria-pressed={muted}
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        title={muted ? 'Sound off' : 'Sound on'}
        data-silent
        onClick={() => {
          const next = !muted;
          setMuted(next);
          if (!next) sound.play('notify'); // audible confirmation when turning sound on
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" fillOpacity="0.15" />
          {muted ? (
            <path d="M16 9.5l5 5M21 9.5l-5 5" />
          ) : (
            <>
              <path d="M15.5 9a4 4 0 0 1 0 6" />
              <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
            </>
          )}
        </svg>
      </button>
      <input
        className="sound-toggle__slider"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        aria-label="Volume"
        onChange={(e) => {
          const v = Number(e.target.value);
          setVolume(v);
          if (muted && v > 0) setMuted(false);
        }}
      />
    </div>
  );
}

