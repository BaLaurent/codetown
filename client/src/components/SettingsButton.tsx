// Settings entry point: a gear button (placed next to MuteButton in the nav) that
// opens a pixel-art modal. First settings are audio (master volume + notification
// sound); the modal is built to grow new sections later. State lives in sounds.ts
// (getVolume/setVolume, getNotificationSound/setNotificationSound) — this component
// is just the UI that reads/writes through it.
import { useRef, useState, type CSSProperties } from 'react';
import { COLORS } from './InteractionModal';
import {
  getVolume, setVolume,
  getNotificationSound, setNotificationSound,
  previewNotificationSound,
} from '../sounds';

const MAX_CUSTOM_BYTES = 500 * 1024; // base64 of this shares the ~5MB localStorage quota

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 50,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.45)', fontFamily: 'monospace',
};

const modal: CSSProperties = {
  width: 'min(420px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
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
  padding: '2px 6px', marginBottom: 8,
};

const row: CSSProperties = { marginBottom: 14 };
const fieldLabel: CSSProperties = { fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' };

const btn: CSSProperties = {
  fontFamily: 'monospace', fontWeight: 700, fontSize: 12, padding: '6px 12px',
  color: COLORS.ink, background: COLORS.gold,
  border: `3px solid ${COLORS.border}`, boxShadow: '2px 2px 0 rgba(0,0,0,0.3)', cursor: 'pointer',
};

const subtleBtn: CSSProperties = {
  ...btn, background: '#E8DFC2', boxShadow: 'none',
};

const footer: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 8,
  padding: 12, borderTop: `4px solid ${COLORS.border}`,
};

const errorText: CSSProperties = { color: '#8A1E1E', fontSize: 11, marginTop: 6 };

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

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [volume, setVolumeState] = useState(() => Math.round(getVolume() * 100));
  const [notif, setNotif] = useState(() => getNotificationSound());
  const [customName, setCustomName] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const isCustom = notif !== 'default';

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolumeState(v);
    setVolume(v / 100);
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
      setNotificationSound(dataUrl);
      setNotif(dataUrl);
      setCustomName(file.name);
    };
    reader.onerror = () => setError('Lecture du fichier impossible.');
    reader.readAsDataURL(file);
  };

  const onReset = () => {
    setNotificationSound('default');
    setNotif('default');
    setCustomName('');
    setError('');
    if (fileRef.current) fileRef.current.value = '';
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

          <div style={row}>
            <span style={fieldLabel}>
              Son de notification — {isCustom ? `Personnalisé${customName ? ` (${customName})` : ''}` : 'Défaut'}
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button style={btn} onClick={() => fileRef.current?.click()}>Choisir un fichier…</button>
              <button style={subtleBtn} onClick={() => previewNotificationSound()}>Tester</button>
              {isCustom && <button style={subtleBtn} onClick={onReset}>Réinitialiser</button>}
            </div>
            <input
              ref={fileRef}
              type="file" accept="audio/*" onChange={onFile}
              style={{ display: 'none' }}
            />
            {error && <div style={errorText}>{error}</div>}
          </div>
        </div>

        <div style={footer}>
          <button style={btn} onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
