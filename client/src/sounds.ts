// Sound effects for CodeMap Hotel using Web Audio API
// Tasteful, subtle sounds that aren't annoying

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;

// Safe read of the platform store: localStorage may be missing or broken at module
// load (Node v25 ships a broken global, SSR has none). Falls back to null.
const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

let isMuted = readStored('codemap-muted') === 'true';

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

// Master volume (0..1), applied to every sound. Single source of truth: synthesized
// sounds route through masterGain, the custom notification clip reads getVolume().
let volume = clamp01(parseFloat(readStored('codemap-audio-volume') ?? '1'));

export const getMuted = () => isMuted;

export const setMuted = (muted: boolean) => {
  isMuted = muted;
  localStorage.setItem('codemap-muted', muted ? 'true' : 'false');
};

export const getVolume = () => volume;

export const setVolume = (v: number) => {
  volume = clamp01(v);
  localStorage.setItem('codemap-audio-volume', String(volume));
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

// Notification sound: 'default' (synthesized chime) or a base64 data URL (custom upload).
let notificationSound = readStored('codemap-notification-sound') || 'default';
let notificationAudio: HTMLAudioElement | null = null;

export const getNotificationSound = () => notificationSound;

export const setNotificationSound = (value: string) => {
  notificationSound = value || 'default';
  localStorage.setItem('codemap-notification-sound', notificationSound);
  notificationAudio = null; // rebuilt lazily on next play with the new source
};

// Soft click/tap for reads - short, gentle
export const playReadSound = () => {
  if (isMuted) return;
  try {
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
  } catch (e) {
    // Audio not available
  }
};

// Soft chime for writes - slightly longer, warmer
export const playWriteSound = () => {
  if (isMuted) return;
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const oscillator2 = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    oscillator2.connect(gainNode);
    gainNode.connect(getMasterGain(ctx));

    // Main tone
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(523, ctx.currentTime); // C5
    oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.06); // E5

    // Harmony
    oscillator2.type = 'sine';
    oscillator2.frequency.setValueAtTime(659, ctx.currentTime); // E5
    oscillator2.frequency.setValueAtTime(784, ctx.currentTime + 0.06); // G5

    gainNode.gain.setValueAtTime(0.06, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

    oscillator.start(ctx.currentTime);
    oscillator2.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.15);
    oscillator2.stop(ctx.currentTime + 0.15);
  } catch (e) {
    // Audio not available
  }
};

// Attention sound for waiting agents - gentle ping that repeats
let lastWaitingSoundTime = 0;
const WAITING_SOUND_INTERVAL = 3000; // Only play every 3 seconds max

// Default synthesized two-note attention chime ("ding-ding"), routed through masterGain.
const playSynthesizedNotification = () => {
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

  // Rising two-note chime: "ding-ding"
  playNote(880, ctx.currentTime, 0.15);        // A5
  playNote(1047, ctx.currentTime + 0.12, 0.2); // C6
};

// Emit the notification once (no throttle). Custom sound plays through an
// HTMLAudioElement (won't pass masterGain), so apply the master volume directly.
const emitNotification = () => {
  if (isMuted) return;
  try {
    if (notificationSound === 'default') {
      playSynthesizedNotification();
      return;
    }
    if (!notificationAudio) {
      notificationAudio = new Audio(notificationSound);
    }
    notificationAudio.volume = volume;
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(() => { /* autoplay blocked / decode error */ });
  } catch (e) {
    // Audio not available
  }
};

export const playWaitingSound = () => {
  if (isMuted) return;
  const now = Date.now();
  if (now - lastWaitingSoundTime < WAITING_SOUND_INTERVAL) {
    return; // Throttle to avoid annoying repetition
  }
  lastWaitingSoundTime = now;
  emitNotification();
};

// Play the notification immediately, bypassing the throttle (used by the settings "Test" button).
export const previewNotificationSound = () => emitNotification();

// Initialize audio context on first user interaction
export const initAudio = () => {
  if (!audioContext) {
    audioContext = new AudioContext();
    // Resume if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }
};
