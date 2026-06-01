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

// Pastille « non définie » : contour gris neutre visible AUSSI BIEN sur la barre de
// titre sombre du terminal (#1a1a1a) que sur le doré du chat — l'ancien contour
// rgba(0,0,0,0.4) disparaissait sur le sombre, rendant le bouton introuvable.
const triggerBtn: CSSProperties = {
  ...dot, background: 'transparent', borderStyle: 'dashed', borderColor: '#9aa0a6',
};

const swatchRow: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, width: 132,
};

const popover: CSSProperties = {
  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40,
  padding: 8, background: 'rgba(17, 24, 39, 0.98)', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
};

const resetBtn: CSSProperties = {
  ...dot, background: 'transparent', borderStyle: 'dashed', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
};

// Rangée de pastilles + ✕ « défaut ». Présentational et contrôlé : partagé entre la
// popover de la pastille de titre ET les menus contextuels (clic droit) des panneaux.
// La pastille active est entourée d'un liseré blanc. Sur fond sombre (popover/menu).
export function PaletteRow({ color, onPick }: {
  color: string | null;
  onPick: (color: string | null) => void;
}) {
  return (
    <div style={swatchRow}>
      {PANEL_PALETTE.map(c => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={`Couleur ${c}`}
          onClick={() => onPick(c)}
          style={{ ...dot, background: c, ...(c === color ? { outline: '2px solid #fff', outlineOffset: 1 } : null) }}
        />
      ))}
      <button
        type="button"
        title="Couleur par défaut"
        aria-label="Couleur par défaut"
        onClick={() => onPick(null)}
        style={resetBtn}
      >✕</button>
    </div>
  );
}

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
        // Couleur définie → pastille pleine à contour sombre ; sinon contour gris pointillé.
        style={{ ...triggerBtn, ...(color ? { background: color, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.4)' } : null) }}
      />
      {open && (
        <div style={popover} onClick={e => e.stopPropagation()}>
          <PaletteRow color={color} onPick={pick} />
        </div>
      )}
    </div>
  );
}
