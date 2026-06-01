// client/src/components/PanelColorPicker.tsx
// Pastille dans la barre de titre d'un panneau dockable : ouvre un petit popover
// de couleurs. Contrôlé (color/onChange) — la persistance vit dans les hosts.
import { useEffect, useRef, useState, type CSSProperties } from 'react';

// Palette curatée pour des cadres lisibles (distincte des couleurs "shirt" d'agent).
export const PANEL_PALETTE = [
  '#C83030', // rouge
  '#3070C8', // bleu
  '#2E9E4F', // vert
  '#E0A020', // ambre
  '#8A4FCF', // violet
  '#D84F8C', // rose
  '#20A8B0', // teal
  '#6B7280', // gris
];

const dot: CSSProperties = {
  width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(0,0,0,0.4)',
  cursor: 'pointer', padding: 0,
};

const triggerBtn: CSSProperties = {
  ...dot, background: 'transparent', borderStyle: 'dashed',
};

const popover: CSSProperties = {
  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40,
  display: 'flex', flexWrap: 'wrap', gap: 6, width: 132, padding: 8,
  background: 'rgba(17, 24, 39, 0.98)', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
};

const resetBtn: CSSProperties = {
  ...dot, background: 'transparent', borderStyle: 'dashed', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
};

export function PanelColorPicker({ color, onChange }: {
  color: string | null;
  onChange: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Ferme au clic extérieur / Échap, même UX que le menu contextuel des panneaux.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (c: string | null) => { onChange(c); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title="Couleur du panneau"
        aria-label="Couleur du panneau"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{ ...triggerBtn, background: color ?? 'transparent' }}
      />
      {open && (
        <div style={popover} onClick={e => e.stopPropagation()}>
          {PANEL_PALETTE.map(c => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={`Couleur ${c}`}
              onClick={() => pick(c)}
              style={{ ...dot, background: c }}
            />
          ))}
          <button
            type="button"
            title="Couleur par défaut"
            aria-label="Couleur par défaut"
            onClick={() => pick(null)}
            style={resetBtn}
          >✕</button>
        </div>
      )}
    </div>
  );
}
