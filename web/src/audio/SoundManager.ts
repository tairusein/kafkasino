import { SYNTHS, startRouletteBall, startSlotSpin, type LoopName, type SoundName } from './synth';

/**
 * Optional recorded assets for one-shot effects, e.g.
 *   chipClick: '/sounds/chip-click.mp3'
 * Leave empty to use the built-in procedural synth (src/audio/synth.ts).
 */
export const SOUND_FILES: Partial<Record<SoundName, string>> = {};

const STORAGE_KEY = 'kafkasino.sound';

export interface SoundSnapshot {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

/**
 * Central audio engine (single instance for the whole app).
 *
 * - Lazy AudioContext: browsers block audio until a user gesture; call unlock() from one
 *   (SoundProvider does this on the first pointer/key event).
 * - One master gain → mute/volume apply instantly to everything, including running loops.
 * - Settings persist in localStorage. State is exposed through subscribe()/getSnapshot()
 *   (stable object identity between changes) so React can use useSyncExternalStore.
 * - Game code just calls sound.play('chipClick') / sound.startSlotSpin() / ...
 */
class SoundManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private listeners = new Set<() => void>();
  private snapshot: SoundSnapshot;

  constructor() {
    this.snapshot = this.loadSettings();
  }

  // ----- React external-store API (arrow fns: safe to pass directly) -----
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): SoundSnapshot => this.snapshot;

  // ----- settings -----
  setMuted(muted: boolean): void {
    this.update({ ...this.snapshot, muted });
  }
  setVolume(volume: number): void {
    this.update({ ...this.snapshot, volume: Math.min(1, Math.max(0, volume)) });
  }

  // ----- lifecycle -----
  /** Create/resume the AudioContext. Must run inside a user-gesture handler the first time. */
  unlock(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  // ----- playback -----
  play(name: SoundName): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const buffer = this.buffers.get(name);
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.master);
      src.start();
      return;
    }
    SYNTHS[name](ctx, this.master, ctx.currentTime + 0.005);
  }

  /** Reel rattle until the returned stop() is called. */
  startSlotSpin(): () => void {
    return this.loop('slotSpin', (ctx, out) => startSlotSpin(ctx, out));
  }

  /** Roulette ball roll that decelerates over `durationMs`. */
  playRouletteBall(durationMs: number): () => void {
    return this.loop('rouletteBall', (ctx, out) => startRouletteBall(ctx, out, durationMs));
  }

  // ----- internals -----
  private loop(
    _name: LoopName,
    start: (ctx: AudioContext, out: AudioNode) => () => void,
  ): () => void {
    const ctx = this.ready();
    if (!ctx || !this.master) return () => undefined;
    return start(ctx, this.master);
  }

  /** Context if audio is currently allowed (not muted, unlocked). */
  private ready(): AudioContext | null {
    if (this.snapshot.muted) return null;
    const ctx = this.ensureContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.effectiveGain();
    this.master.connect(this.ctx.destination);
    void this.loadFiles(this.ctx);
    return this.ctx;
  }

  private async loadFiles(ctx: AudioContext): Promise<void> {
    await Promise.all(
      (Object.entries(SOUND_FILES) as [SoundName, string][]).map(async ([name, url]) => {
        try {
          const res = await fetch(url);
          const data = await res.arrayBuffer();
          this.buffers.set(name, await ctx.decodeAudioData(data));
        } catch {
          /* keep the synth fallback */
        }
      }),
    );
  }

  private effectiveGain(): number {
    // Squared curve feels more natural than linear for a volume slider.
    return this.snapshot.muted ? 0 : this.snapshot.volume ** 2;
  }

  private update(next: SoundSnapshot): void {
    this.snapshot = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable (private mode) — keep in memory */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.effectiveGain(), this.ctx.currentTime, 0.015);
    }
    this.listeners.forEach((l) => l());
  }

  private loadSettings(): SoundSnapshot {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<SoundSnapshot>;
        return {
          muted: p.muted === true,
          volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 0.7,
        };
      }
    } catch {
      /* fall through to defaults */
    }
    return { muted: false, volume: 0.7 };
  }
}

export const sound = new SoundManager();
export type { SoundName, LoopName };

