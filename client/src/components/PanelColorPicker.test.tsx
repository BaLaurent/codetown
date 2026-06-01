// client/src/components/PanelColorPicker.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PanelColorPicker, PanelAppearance, PaletteRow, PANEL_PALETTE } from './PanelColorPicker';

afterEach(cleanup);

describe('PaletteRow', () => {
  it('renders one swatch per palette color plus a reset', () => {
    render(<PaletteRow color={null} onPick={() => {}} />);
    expect(screen.getAllByRole('button', { name: /couleur/i }).length)
      .toBe(PANEL_PALETTE.length + 1); // pastilles + "défaut"
  });

  it('calls onPick with the chosen color', () => {
    const onPick = vi.fn();
    render(<PaletteRow color={null} onPick={onPick} />);
    fireEvent.click(screen.getByTitle(PANEL_PALETTE[1]));
    expect(onPick).toHaveBeenCalledWith(PANEL_PALETTE[1]);
  });

  it('calls onPick(null) on the reset swatch', () => {
    const onPick = vi.fn();
    render(<PaletteRow color={'#C83030'} onPick={onPick} />);
    fireEvent.click(screen.getByTitle('Couleur par défaut'));
    expect(onPick).toHaveBeenCalledWith(null);
  });
});

describe('PanelAppearance', () => {
  // Deux sections → chaque titre de pastille existe en double (Fond puis Texte).
  const base = { bg: null, text: null, onBgChange: vi.fn(), onTextChange: vi.fn() };

  it('Fond palette → onBgChange ; Texte palette → onTextChange', () => {
    const onBgChange = vi.fn();
    const onTextChange = vi.fn();
    render(<PanelAppearance {...base} onBgChange={onBgChange} onTextChange={onTextChange} />);
    const swatches = screen.getAllByTitle(PANEL_PALETTE[0]); // [0]=Fond, [1]=Texte
    fireEvent.click(swatches[0]);
    expect(onBgChange).toHaveBeenCalledWith(PANEL_PALETTE[0]);
    fireEvent.click(swatches[1]);
    expect(onTextChange).toHaveBeenCalledWith(PANEL_PALETTE[0]);
  });

  it('✕ Fond → onBgChange(null) ; ✕ Texte → onTextChange(null)', () => {
    const onBgChange = vi.fn();
    const onTextChange = vi.fn();
    render(<PanelAppearance bg="#C83030" text="#FFFFFF" onBgChange={onBgChange} onTextChange={onTextChange} />);
    const resets = screen.getAllByTitle('Couleur par défaut');
    fireEvent.click(resets[0]);
    expect(onBgChange).toHaveBeenCalledWith(null);
    fireEvent.click(resets[1]);
    expect(onTextChange).toHaveBeenCalledWith(null);
  });

  it('custom colour inputs call the right handler with the picked hex', () => {
    const onBgChange = vi.fn();
    const onTextChange = vi.fn();
    render(<PanelAppearance {...base} onBgChange={onBgChange} onTextChange={onTextChange} />);
    fireEvent.change(screen.getByTitle('Fond personnalisé'), { target: { value: '#123456' } });
    expect(onBgChange).toHaveBeenCalledWith('#123456');
    fireEvent.change(screen.getByTitle('Texte personnalisé'), { target: { value: '#abcdef' } });
    expect(onTextChange).toHaveBeenCalledWith('#abcdef');
  });
});

describe('PanelColorPicker', () => {
  const base = { bg: null, text: null, onBgChange: vi.fn(), onTextChange: vi.fn() };

  it('opens the appearance popover with Fond and Texte sections', () => {
    render(<PanelColorPicker {...base} />);
    fireEvent.click(screen.getByTitle('Apparence du panneau'));
    expect(screen.getByText('Fond')).not.toBeNull();
    expect(screen.getByText('Texte')).not.toBeNull();
  });

  it('picking a background swatch calls onBgChange', () => {
    const onBgChange = vi.fn();
    render(<PanelColorPicker {...base} onBgChange={onBgChange} />);
    fireEvent.click(screen.getByTitle('Apparence du panneau'));
    fireEvent.click(screen.getAllByTitle(PANEL_PALETTE[0])[0]); // [0]=Fond
    expect(onBgChange).toHaveBeenCalledWith(PANEL_PALETTE[0]);
  });
});
