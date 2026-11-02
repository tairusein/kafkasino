/**
 * Procedural sound definitions (Web Audio API). Every effect works with ZERO audio files,
 * so the app has sound from day one. To use studio recordings instead, drop files into
 * web/public/sounds/ and register them in SOUND_FILES (src/audio/SoundManager.ts);
 * a loaded file always takes precedence over the synth below.
 */

export type SoundName =
  | 'uiClick'
  | 'notify'
  | 'chipClick'
  | 'chipStack'
  | 'cardShuffle'
  | 'cardDeal'
  | 'cardFlip'
  | 'win'
  | 'lose'
  | 'slotStop';

/** Looping / long effects — returned handle stops them. */
export type LoopName = 'slotSpin' | 'rouletteBall';

type Synth = (ctx: AudioContext, out: AudioNode, t: number) => void;

let noiseCache: AudioBuffer | null = null;
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!noiseCache || noiseCache.sampleRate !== ctx.sampleRate) {
    const len = ctx.sampleRate * 1; // 1s of white noise, reused
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseCache = buf;
  }
  return noiseCache;
}

export function tone(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  freq: number,
  dur: number,
  type: OscillatorType = 'sine',
  gain = 0.2,
  endFreq?: number,
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export function noiseBurst(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  dur: number,
  filterType: BiquadFilterType,
  freq: number,
  q = 1,
  gain = 0.3,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

function chip(ctx: AudioContext, out: AudioNode, t: number, pitch = 1): void {
  noiseBurst(ctx, out, t, 0.025, 'bandpass', 3400 * pitch, 7, 0.5);
  tone(ctx, out, t, 2300 * pitch, 0.05, 'triangle', 0.12, 1700 * pitch);
}

export const SYNTHS: Record<SoundName, Synth> = {
  // Very quiet tick for buttons / navigation.
  uiClick: (ctx, out, t) => {
    tone(ctx, out, t, 1700, 0.035, 'sine', 0.08, 1100);
  },
  // Subtle two-note chime for notifications.
  notify: (ctx, out, t) => {
    tone(ctx, out, t, 880, 0.28, 'sine', 0.12);
    tone(ctx, out, t + 0.1, 1318.5, 0.38, 'sine', 0.1);
  },
  chipClick: (ctx, out, t) => {
    chip(ctx, out, t);
    chip(ctx, out, t + 0.05, 1.15);
  },
  chipStack: (ctx, out, t) => {
    let at = t;
    for (let i = 0; i < 5; i++) {
      chip(ctx, out, at, 0.9 + Math.random() * 0.3);
      at += 0.035 + Math.random() * 0.04;
    }
  },
  cardShuffle: (ctx, out, t) => {
    // Riffle: dense stream of tiny filtered-noise flaps, loudest in the middle.
    const n = 26;
    for (let i = 0; i < n; i++) {
      const at = t + i * 0.028 + Math.random() * 0.012;
      const env = Math.sin((i / (n - 1)) * Math.PI);
      noiseBurst(ctx, out, at, 0.03, 'highpass', 2600 + Math.random() * 1400, 0.8, 0.08 + env * 0.22);
    }
  },
  cardDeal: (ctx, out, t) => {
    noiseBurst(ctx, out, t, 0.09, 'bandpass', 1900, 1.2, 0.4);
    noiseBurst(ctx, out, t + 0.05, 0.03, 'lowpass', 900, 1, 0.18);
  },
  cardFlip: (ctx, out, t) => {
    noiseBurst(ctx, out, t, 0.05, 'bandpass', 2600, 1.5, 0.3);
    noiseBurst(ctx, out, t + 0.045, 0.04, 'bandpass', 1500, 1.5, 0.22);
  },
  win: (ctx, out, t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(ctx, out, t + i * 0.09, f, 0.5, 'triangle', 0.16);
      tone(ctx, out, t + i * 0.09, f * 2, 0.35, 'sine', 0.05);
    });
  },
  lose: (ctx, out, t) => {
    tone(ctx, out, t, 220, 0.35, 'triangle', 0.14, 196);
    tone(ctx, out, t + 0.16, 174.6, 0.5, 'triangle', 0.12, 150);
  },
  slotStop: (ctx, out, t) => {
    tone(ctx, out, t, 170, 0.12, 'sine', 0.3, 90);
    noiseBurst(ctx, out, t, 0.05, 'lowpass', 800, 1, 0.25);
  },
};

/** Starts the slot reel "rattle". Returns stop(). */
export function startSlotSpin(ctx: AudioContext, out: AudioNode): () => void {
  const id = window.setInterval(() => {
    const t = ctx.currentTime;
    noiseBurst(ctx, out, t, 0.02, 'bandpass', 1300 + Math.random() * 500, 3, 0.22);
    tone(ctx, out, t, 420 + Math.random() * 60, 0.03, 'square', 0.03);
  }, 65);
  return () => window.clearInterval(id);
}

/**
 * Roulette ball: low rumble plus wheel-pocket ticks that spread out as the ball slows,
 * pre-scheduled on the audio clock for `durationMs` (so timing stays tight under UI load).
 * Returns stop() for early cancel (e.g. leaving the page).
 */
export function startRouletteBall(ctx: AudioContext, out: AudioNode, durationMs: number): () => void {
  const t0 = ctx.currentTime + 0.02;
  const dur = Math.max(1, durationMs / 1000);

  const master = ctx.createGain();
  master.connect(out);

  // Rumble of the ball on the track: filtered noise fading out.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(900, t0);
  bp.frequency.exponentialRampToValueAtTime(260, t0 + dur);
  bp.Q.value = 2;
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0.0001, t0);
  rg.gain.exponentialRampToValueAtTime(0.16, t0 + 0.25);
  rg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(rg).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);

  // Pocket ticks: interval grows from ~45ms to ~420ms.
  let at = t0 + 0.2;
  while (at < t0 + dur) {
    const progress = (at - t0) / dur;
    const interval = 0.045 + Math.pow(progress, 2.2) * 0.38;
    const vol = 0.12 + (1 - progress) * 0.12;
    noiseBurst(ctx, master, at, 0.018, 'bandpass', 2800 + Math.random() * 600, 6, vol);
    tone(ctx, master, at, 1900 + Math.random() * 200, 0.025, 'triangle', vol * 0.35);
    at += interval;
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.05);
  };
}

