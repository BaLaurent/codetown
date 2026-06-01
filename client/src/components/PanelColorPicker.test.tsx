// client/src/components/PanelColorPicker.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PanelColorPicker, PaletteRow, PANEL_PALETTE } from './PanelColorPicker';

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

describe('PanelColorPicker', () => {
  it('opens the popover on click and shows every palette swatch', () => {
    render(<PanelColorPicker color={null} onChange={() => {}} />);
    fireEvent.click(screen.getByTitle('Couleur du panneau'));
    // une pastille par couleur + le bouton "défaut"
    expect(screen.getAllByRole('button', { name: /couleur/i }).length)
      .toBeGreaterThanOrEqual(PANEL_PALETTE.length);
  });

  it('calls onChange with the picked color', () => {
    const onChange = vi.fn();
    render(<PanelColorPicker color={null} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Couleur du panneau'));
    fireEvent.click(screen.getByTitle(PANEL_PALETTE[0]));
    expect(onChange).toHaveBeenCalledWith(PANEL_PALETTE[0]);
  });

  it('calls onChange(null) when picking "défaut"', () => {
    const onChange = vi.fn();
    render(<PanelColorPicker color={'#C83030'} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Couleur du panneau'));
    fireEvent.click(screen.getByTitle('Couleur par défaut'));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
