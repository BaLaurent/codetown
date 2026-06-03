// Settings entry point: a gear button (placed next to MuteButton in the nav) that
// opens a pixel-art modal. Audio settings = global volume + per-channel rows
// (enable/disable + custom clip), grouped into "Activité" (read/write) and
// "Notification". State lives in sounds.ts; this component is just the UI.
import { useRef, useState, type CSSProperties } from 'react';
import { COLORS } from './InteractionModal';
import {
  getVolume, setVolume,
  getSoundEnabled, setSoundEnabled,
  getSoundSource, setSoundSource,
  previewSound,
  SOUND_CHANNELS, type SoundKey,
} from '../sounds';

const MAX_CUSTOM_BYTES = 500 * 1024; // base64 of this shares the ~5MB localStorage quota

const ACTIVITY_KEYS: SoundKey[] = ['read', 'write'];
const NOTIFICATION_KEYS: SoundKey[] = ['notification'];

const labelOf = (key: SoundKey) => SOUND_CHANNELS.find((c) => c.key === key)?.label ?? key;

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 50,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.45)', fontFamily: 'monospace',
};

const modal: CSSProperties = {
  width: 'min(440px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
  background: COLORS.cream, color: COLORS.ink,
  border: `4px solid ${COLORS.border}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
};

const titleBar: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 12px', background: COLORS.gold,
  borderBottom: `4px solid ${COLORS.border}`, fontWeight: 700,
};

const closeX: CSSProperties = {
  cursor: 'pointer', fontWeight: 700, padding: '0 6px',
  background: 'transparent', border: 'none', color: COLORS.ink, fontFamily: 'monospace', fontSize: 16,
};

const body: CSSProperties = { padding: 12, overflowY: 'auto' };

const sectionLabel: CSSProperties = {
  display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: 1,
  textTransform: 'uppercase', background: COLORS.border, color: COLORS.gold,
  padding: '2px 6px', marginBottom: 8, marginTop: 4,
};

const row: CSSProperties = { marginBottom: 14 };
const fieldLabel: CSSProperties = { fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' };

const soundRowBox: CSSProperties = {
  border: `2px solid rgba(74,59,26,0.25)`, padding: '8px 10px', marginBottom: 8,
};

const soundRowHead: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6,
};

const checkLabel: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', userSelect: 'none',
};

const btn: CSSProperties = {
  fontFamily: 'monospace', fontWeight: 700, fontSize: 12, padding: '5px 10px',
  color: COLORS.ink, background: COLORS.gold,
  border: `3px solid ${COLORS.border}`, boxShadow: '2px 2px 0 rgba(0,0,0,0.3)', cursor: 'pointer',
};

const subtleBtn: CSSProperties = { ...btn, background: '#E8DFC2', boxShadow: 'none' };

const footer: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 8,
  padding: 12, borderTop: `4px solid ${COLORS.border}`,
};

const errorText: CSSProperties = { color: '#8A1E1E', fontSize: 11, marginTop: 6 };
const stateText: CSSProperties = { fontSize: 11, opacity: 0.8 };

export function SettingsButton({ navStyle }: { navStyle: CSSProperties }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{ ...navStyle, cursor: 'pointer' }}
        title="Réglages"
      >⚙</button>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}

// One configurable sound: enable/disable + upload a custom clip (default otherwise).
function SoundRow({ soundKey }: { soundKey: SoundKey }) {
  const [enabled, setEnabledState] = useState(() => getSoundEnabled(soundKey));
  const [source, setSourceState] = useState(() => getSoundSource(soundKey));
  const [customName, setCustomName] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const isCustom = source !== 'default';

  const onToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEnabledState(e.target.checked);
    setSoundEnabled(soundKey, e.target.checked);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError('');
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setError('Fichier non audio. Choisis un .mp3, .wav, .ogg…');
      return;
    }
    if (file.size > MAX_CUSTOM_BYTES) {
      setError(`Fichier trop lourd (max ${Math.round(MAX_CUSTOM_BYTES / 1024)} Ko).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setSoundSource(soundKey, dataUrl);
      setSourceState(dataUrl);
      setCustomName(file.name);
    };
    reader.onerror = () => setError('Lecture du fichier impossible.');
    reader.readAsDataURL(file);
  };

  const onReset = () => {
    setSoundSource(soundKey, 'default');
    setSourceState('default');
    setCustomName('');
    setError('');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div style={soundRowBox}>
      <div style={soundRowHead}>
        <strong style={{ fontSize: 12 }}>{labelOf(soundKey)}</strong>
        <label style={checkLabel}>
          <input type="checkbox" checked={enabled} onChange={onToggle} />
          Activé
        </label>
      </div>
      <div style={stateText}>
        Son — {isCustom ? `Personnalisé${customName ? ` (${customName})` : ''}` : 'Défaut'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
        <button style={btn} onClick={() => fileRef.current?.click()}>Choisir…</button>
        <button style={subtleBtn} onClick={() => previewSound(soundKey)}>Tester</button>
        {isCustom && <button style={subtleBtn} onClick={onReset}>Réinitialiser</button>}
      </div>
      <input ref={fileRef} type="file" accept="audio/*" onChange={onFile} style={{ display: 'none' }} />
      {error && <div style={errorText}>{error}</div>}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [volume, setVolumeState] = useState(() => Math.round(getVolume() * 100));

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolumeState(v);
    setVolume(v / 100);
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={titleBar}>
          <span>Réglages</span>
          <button style={closeX} onClick={onClose} title="Fermer">×</button>
        </div>

        <div style={body}>
          <div style={sectionLabel}>Audio</div>
          <div style={row}>
            <label style={fieldLabel} htmlFor="settings-volume">Volume — {volume}%</label>
            <input
              id="settings-volume"
              type="range" min={0} max={100} value={volume} onChange={onVolume}
              style={{ width: '100%' }}
            />
          </div>

          <div style={sectionLabel}>Activité</div>
          {ACTIVITY_KEYS.map((key) => <SoundRow key={key} soundKey={key} />)}

          <div style={sectionLabel}>Notification</div>
          {NOTIFICATION_KEYS.map((key) => <SoundRow key={key} soundKey={key} />)}
        </div>

        <div style={footer}>
          <button style={btn} onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
