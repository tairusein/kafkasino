import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { sound, type SoundSnapshot } from './SoundManager';

/**
 * Wires the sound engine to the page:
 *  - unlocks audio on the first user gesture (browser autoplay policy),
 *  - plays a very quiet UI tick for buttons and navigation links (event delegation,
 *    so individual components do not need to know about sound).
 */
export function SoundProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const unlock = () => sound.unlock();
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('button, a.btn, .app-nav a') : null;
      if (el && !el.hasAttribute('data-silent') && !(el as HTMLButtonElement).disabled) {
        sound.play('uiClick');
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return <>{children}</>;
}

/** Reactive sound settings + the engine itself for game code: `const { sound } = useSound()`. */
export function useSound(): SoundSnapshot & {
  sound: typeof sound;
  setMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
} {
  const snap = useSyncExternalStore(sound.subscribe, sound.getSnapshot);
  return {
    ...snap,
    sound,
    setMuted: (m) => sound.setMuted(m),
    setVolume: (v) => sound.setVolume(v),
  };
}

