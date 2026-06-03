import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsButton } from './SettingsButton';
import { getVolume, setVolume, getSoundEnabled, SOUND_CHANNELS } from '../sounds';

afterEach(cleanup);

// Node.js v25 ships a broken localStorage global; mock it so the sounds store works.
beforeEach(() => {
  let storage: Record<string, string> = {};
  global.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => { storage[k] = v; },
    removeItem: (k: string) => { delete storage[k]; },
    clear: () => { storage = {}; },
    key: (i: number) => Object.keys(storage)[i] ?? null,
    get length() { return Object.keys(storage).length; },
  } as Storage;
});

const nav = {};

describe('SettingsButton', () => {
  it('opens the modal on click and closes it', () => {
    render(<SettingsButton navStyle={nav} />);
    expect(screen.queryByText('Réglages')).toBeNull();
    fireEvent.click(screen.getByTitle('Réglages'));
    expect(screen.getByText('Réglages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByText('Réglages')).toBeNull();
  });

  it('reflects the stored volume and updates it on slider change', () => {
    setVolume(0.3);
    render(<SettingsButton navStyle={nav} />);
    fireEvent.click(screen.getByTitle('Réglages'));
    expect(screen.getByText(/Volume — 30%/)).toBeTruthy();

    const slider = screen.getByRole('slider') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '80' } });
    expect(screen.getByText(/Volume — 80%/)).toBeTruthy();
    expect(getVolume()).toBeCloseTo(0.8);
  });

  it('lists one row per sound channel', () => {
    render(<SettingsButton navStyle={nav} />);
    fireEvent.click(screen.getByTitle('Réglages'));
    expect(screen.getAllByRole('button', { name: 'Tester' }).length).toBe(SOUND_CHANNELS.length);
    expect(screen.getAllByRole('checkbox').length).toBe(SOUND_CHANNELS.length);
  });

  it('toggles a channel off via its checkbox', () => {
    render(<SettingsButton navStyle={nav} />);
    fireEvent.click(screen.getByTitle('Réglages'));
    const firstCheckbox = screen.getAllByRole('checkbox')[0]; // 'read' (first channel)
    expect((firstCheckbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(firstCheckbox);
    expect(getSoundEnabled('read')).toBe(false);
  });

  it('rejects a non-audio file with an error message', () => {
    const { container } = render(<SettingsButton navStyle={nav} />);
    fireEvent.click(screen.getByTitle('Réglages'));

    const fileInput = container.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(screen.getByText(/non audio/i)).toBeTruthy();
  });
});
