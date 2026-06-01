// Rendering tests for the permission modal, focused on the ExitPlanMode plan
// path: the bug was that approving a plan showed a truncated raw JSON blob and
// forced the user to the terminal. The plan must render as markdown with
// plan-framed decision buttons.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InteractionModal } from './InteractionModal';

const ph = /Remarques \(optionnel\)/;

afterEach(cleanup);

describe('InteractionModal — ExitPlanMode plan', () => {
  const plan = '# Fix décodage Parakeet TDT\n\n## Context\n\nL\'intégration casse sur les silences.';

  it('renders the full plan as markdown, not a raw JSON blob', () => {
    render(
      <InteractionModal
        agentName="Claude Explore 1" mode="permission"
        toolName="ExitPlanMode" plan={plan}
        onDecide={vi.fn()} onClose={vi.fn()}
      />
    );
    // Heading rendered as an element (markdown), and no JSON wrapper leaked.
    expect(screen.getByText('Fix décodage Parakeet TDT')).toBeTruthy();
    expect(screen.getByText('Context')).toBeTruthy();
    expect(screen.queryByText(/^\{"plan"/)).toBeNull();
  });

  it('frames the decision as approve / keep planning', () => {
    const onDecide = vi.fn();
    render(
      <InteractionModal
        agentName="Claude Explore 1" mode="permission"
        toolName="ExitPlanMode" plan={plan}
        onDecide={onDecide} onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Approuver le plan'));
    expect(onDecide).toHaveBeenCalledWith(true);
  });

  it('sends a rejection note back as feedback when keeping in planning', () => {
    const onDecide = vi.fn();
    render(
      <InteractionModal
        agentName="Claude Explore 1" mode="permission"
        toolName="ExitPlanMode" plan={plan}
        onDecide={onDecide} onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(ph), {
      target: { value: 'Non, utilise plutôt une regex' },
    });
    fireEvent.click(screen.getByText('Garder en planification'));
    expect(onDecide).toHaveBeenCalledWith(false, 'Non, utilise plutôt une regex');
  });

  it('keeps in planning with no feedback (undefined) when the note is blank', () => {
    const onDecide = vi.fn();
    render(
      <InteractionModal
        agentName="Claude Explore 1" mode="permission"
        toolName="ExitPlanMode" plan={plan}
        onDecide={onDecide} onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Garder en planification'));
    expect(onDecide).toHaveBeenCalledWith(false, undefined);
  });

  it('keeps the generic allow/deny shape (no note field) for a plan-less permission', () => {
    render(
      <InteractionModal
        agentName="Claude 1" mode="permission"
        toolName="Bash" toolInput="rm -rf /tmp/x"
        onDecide={vi.fn()} onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Autoriser')).toBeTruthy();
    expect(screen.getByText('Refuser')).toBeTruthy();
    expect(screen.getByText('rm -rf /tmp/x')).toBeTruthy();
    expect(screen.queryByPlaceholderText(ph)).toBeNull();
  });
});
