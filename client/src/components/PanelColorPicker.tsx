// client/src/components/PanelColorPicker.tsx
// Édition de l'apparence d'un panneau dockable : couleur de FOND (accent du cadre/
// barre/poignée) et couleur de TEXTE de la barre de titre. Contrôlé — la persistance
// vit dans les hosts. Trois pièces, du plus petit au plus gros :
//   - PaletteRow       : rangée de pastilles + ✕ « défaut » (présentational).
//   - PanelAppearance  : sections Fond / Texte (PaletteRow + pastille custom OS).
//   - PanelColorPicker : pastille de barre de titre qui ouvre PanelAppearance en popover.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { defaultTextColor } from '../utils/readable-text-color';

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

const sectionLabel: CSSProperties = {
  color: '#e5e7eb', opacity: 0.6, fontSize: 11, margin: '0 0 4px',
};

const customRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, cursor: 'pointer',
};

const customInput: CSSProperties = {
  width: 24, height: 18, padding: 0, border: '1px solid rgba(255,255,255,0.4)',
  borderRadius: 4, background: 'transparent', cursor: 'pointer',
};

const customHint: CSSProperties = { color: '#e5e7eb', opacity: 0.6, fontSize: 11 };

// <input type="color"> exige #rrggbb : on étend les hex courts (#abc → #aabbcc).
function hex6(hex: string): string {
  const h = hex.replace(/^#/, '');
  return `#${h.length === 3 ? h.split('').map(c => c + c).join('') : h}`;
}

// Rangée de pastilles + ✕ « défaut ». Présentational et contrôlé : la pastille active
// est entourée d'un liseré blanc. Pensée pour un fond sombre (popover / menu contextuel).
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

// Éditeur d'apparence : deux sections (Fond / Texte), chacune = palette + ✕ défaut +
// pastille custom (sélecteur natif de l'OS). Le défaut du champ Texte affiche la
// couleur effective (inverse corrigé du fond) pour ouvrir le sélecteur au bon endroit.
export function PanelAppearance({ bg, text, onBgChange, onTextChange }: {
  bg: string | null;
  text: string | null;
  onBgChange: (color: string | null) => void;
  onTextChange: (color: string | null) => void;
}) {
  const textDefault = bg ? defaultTextColor(bg) : '#ffffff';
  return (
    <div>
      <div style={sectionLabel}>Fond</div>
      <PaletteRow color={bg} onPick={onBgChange} />
      <label style={customRow}>
        <input
          type="color"
          title="Fond personnalisé"
          aria-label="Fond personnalisé"
          value={hex6(bg ?? '#888888')}
          onChange={e => onBgChange(e.target.value)}
          style={customInput}
        />
        <span style={customHint}>perso</span>
      </label>

      <div style={{ ...sectionLabel, marginTop: 10 }}>Texte</div>
      <PaletteRow color={text} onPick={onTextChange} />
      <label style={customRow}>
        <input
          type="color"
          title="Texte personnalisé"
          aria-label="Texte personnalisé"
          value={hex6(text ?? textDefault)}
          onChange={e => onTextChange(e.target.value)}
          style={customInput}
        />
        <span style={customHint}>perso</span>
      </label>
    </div>
  );
}

// Pastille de barre de titre : montre le fond courant, ouvre PanelAppearance en popover.
export function PanelColorPicker({ bg, text, onBgChange, onTextChange }: {
  bg: string | null;
  text: string | null;
  onBgChange: (color: string | null) => void;
  onTextChange: (color: string | null) => void;
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

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title="Apparence du panneau"
        aria-label="Apparence du panneau"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        // Fond défini → pastille pleine à contour sombre ; sinon contour gris pointillé.
        style={{ ...triggerBtn, ...(bg ? { background: bg, borderStyle: 'solid', borderColor: 'rgba(0,0,0,0.4)' } : null) }}
      />
      {open && (
        <div style={popover} onClick={e => e.stopPropagation()}>
          <PanelAppearance bg={bg} text={text} onBgChange={onBgChange} onTextChange={onTextChange} />
        </div>
      )}
    </div>
  );
}
