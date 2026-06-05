// Sound effects for CodeTown Hotel using Web Audio API.
// Sounds are organized as configurable "channels" (read, write, notification):
// each can be toggled on/off and given a custom uploaded clip, on top of the
// global mute + volume. Synthesized defaults route through a single master gain.

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;

// Safe access to the platform store: localStorage may be missing or broken at
// module load (Node v25 ships a broken global, SSR has none).
const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota exceeded or store unavailable
  }
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

let isMuted = readStored('codetown-muted') === 'true';

// Master volume (0..1), applied to every sound. Single source of truth: synthesized
// sounds route through masterGain, custom clips read getVolume().
let volume = clamp01(parseFloat(readStored('codetown-audio-volume') ?? '1'));

export const getMuted = () => isMuted;

export const setMuted = (muted: boolean) => {
  isMuted = muted;
  writeStored('codetown-muted', muted ? 'true' : 'false');
};

export const getVolume = () => volume;

export const setVolume = (v: number) => {
  volume = clamp01(v);
  writeStored('codetown-audio-volume', String(volume));
  if (masterGain) masterGain.gain.value = volume;
};

const getAudioContext = (): AudioContext => {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
};

// Single GainNode between every synthesized source and the speakers, so the
// master volume lives in exactly one place (mirrors the audioContext singleton).
const getMasterGain = (ctx: AudioContext): GainNode => {
  if (!masterGain) {
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(ctx.destination);
  }
  return masterGain;
};

// --- Synthesized default players (each routes through masterGain) ---

// Soft click/tap for reads - short, gentle.
const synthRead = () => {
  const ctx = getAudioContext();
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(getMasterGain(ctx));

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(800, ctx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.05);

  gainNode.gain.setValueAtTime(0.08, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.08);
};

// Soft chime for writes - slightly longer, warmer.
const synthWrite = () => {
  const ctx = getAudioContext();
  const oscillator = ctx.createOscillator();
  const oscillator2 = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.connect(gainNode);
  oscillator2.connect(gainNode);
  gainNode.connect(getMasterGain(ctx));

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(523, ctx.currentTime); // C5
  oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.06); // E5

  oscillator2.type = 'sine';
  oscillator2.frequency.setValueAtTime(659, ctx.currentTime); // E5
  oscillator2.frequency.setValueAtTime(784, ctx.currentTime + 0.06); // G5

  gainNode.gain.setValueAtTime(0.06, ctx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

  oscillator.start(ctx.currentTime);
  oscillator2.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.15);
  oscillator2.stop(ctx.currentTime + 0.15);
};

// Rising two-note attention chime ("ding-ding") for waiting agents.
const synthNotification = () => {
  const ctx = getAudioContext();
  const dest = getMasterGain(ctx);

  const playNote = (freq: number, startTime: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(dest);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.1, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.start(startTime);
    osc.stop(startTime + duration);
  };

  playNote(880, ctx.currentTime, 0.15);        // A5
  playNote(1047, ctx.currentTime + 0.12, 0.2); // C6
};

// --- Channels ---

export type SoundKey = 'read' | 'write' | 'notification';

interface SoundChannel {
  key: SoundKey;
  label: string;
  playDefault: () => void;
  throttleMs: number; // 0 = no throttle; notification limits repeats
}

export const SOUND_CHANNELS: SoundChannel[] = [
  { key: 'read', label: 'Lecture', playDefault: synthRead, throttleMs: 0 },
  { key: 'write', label: 'Écriture', playDefault: synthWrite, throttleMs: 0 },
  { key: 'notification', label: 'Agent coincé', playDefault: synthNotification, throttleMs: 3000 },
];

const channelByKey = Object.fromEntries(
  SOUND_CHANNELS.map((c) => [c.key, c]),
) as Record<SoundKey, SoundChannel>;

interface ChannelState {
  enabled: boolean;
  source: string; // 'default' or a data URL
  audio: HTMLAudioElement | null;
  lastPlayed: number;
}

const enabledStoreKey = (key: SoundKey) => `codetown-sound-${key}-enabled`;
const sourceStoreKey = (key: SoundKey) => `codetown-sound-${key}-src`;

const makeState = (key: SoundKey): ChannelState => ({
  enabled: readStored(enabledStoreKey(key)) !== 'false', // default: enabled
  source: readStored(sourceStoreKey(key)) || 'default',
  audio: null,
  lastPlayed: 0,
});

const channelState: Record<SoundKey, ChannelState> = {
  read: makeState('read'),
  write: makeState('write'),
  notification: makeState('notification'),
};

export const getSoundEnabled = (key: SoundKey) => channelState[key].enabled;

export const setSoundEnabled = (key: SoundKey, enabled: boolean) => {
  channelState[key].enabled = enabled;
  writeStored(enabledStoreKey(key), enabled ? 'true' : 'false');
};

export const getSoundSource = (key: SoundKey) => channelState[key].source;

export const setSoundSource = (key: SoundKey, value: string) => {
  const state = channelState[key];
  state.source = value || 'default';
  writeStored(sourceStoreKey(key), state.source);
  state.audio = null; // rebuilt lazily on next play with the new source
};

// Play a channel once, honoring mute only. Custom clip plays via an
// HTMLAudioElement (won't pass masterGain), so apply the master volume directly.
const playChannel = (key: SoundKey) => {
  if (isMuted) return;
  const state = channelState[key];
  try {
    if (state.source === 'default') {
      channelByKey[key].playDefault();
      return;
    }
    if (!state.audio) state.audio = new Audio(state.source);
    state.audio.volume = volume;
    state.audio.currentTime = 0;
    state.audio.play().catch(() => { /* autoplay blocked / decode error */ });
  } catch {
    // Audio not available
  }
};

// Live trigger from event handlers: respects the channel's enabled flag + throttle.
const trigger = (key: SoundKey) => {
  if (!channelState[key].enabled) return;
  const { throttleMs } = channelByKey[key];
  if (throttleMs > 0) {
    const now = Date.now();
    if (now - channelState[key].lastPlayed < throttleMs) return;
    channelState[key].lastPlayed = now;
  }
  playChannel(key);
};

export const playReadSound = () => trigger('read');
export const playWriteSound = () => trigger('write');
export const playWaitingSound = () => trigger('notification');

// Play a channel's current sound now, bypassing throttle and the enabled flag
// (used by the settings "Test" button, so you can hear a clip while tuning it).
export const previewSound = (key: SoundKey) => playChannel(key);

// Initialize audio context on first user interaction.
export const initAudio = () => {
  if (!audioContext) {
    audioContext = new AudioContext();
    // Resume if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }
};
