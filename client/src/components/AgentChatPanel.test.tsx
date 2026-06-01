// Tests for AgentChatPanel rendering: markdown reflow, tool call expand, and
// thinking bubble visibility. We don't drive the WebSocket — we feed messages
// directly (the panel is a pure presenter over the ChatMessage array).
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { AgentChatPanel } from './AgentChatPanel';
import { PANEL_PALETTE } from './PanelColorPicker';
import type { ChatMessage } from '../types';

// jsdom doesn't implement Element.scrollTo — the panel calls it on each new
// message to keep the transcript pinned to the bottom. Stub it so the auto-
// scroll effect doesn't blow up the tests.
beforeAll(() => {
  if (!('scrollTo' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'scrollTo', { value: vi.fn(), writable: true });
  }
});

afterEach(cleanup);

const noopAttach = async () => [];
const baseProps = {
  agentName: 'Claude 1',
  dead: false,
  commands: [],
  files: [],
  models: [],
  model: 'default',
  mode: 'default',
  onModelChange: vi.fn(),
  onModeChange: vi.fn(),
  onEffortChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onClose: vi.fn(),
  onAttach: noopAttach,
  // Placement props (dock integration)
  rightOffset: 16,
  width: 420,
  maxWidth: 420,
  active: true,
  isMaximized: false,
  onResizeWidth: vi.fn(),
  onToggleMaximize: vi.fn(),
  color: null,
  onColorChange: () => {},
};

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage {
  return { agentId: 'a-1', timestamp: 0, ...partial };
}

describe('AgentChatPanel rendering', () => {
  it('renders assistant markdown (bold + bullet list) as HTML, not as raw text', () => {
    const messages: ChatMessage[] = [msg({
      role: 'assistant',
      content: 'Voici **gras** :\n- un\n- deux',
    })];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    expect(container.querySelector('strong')?.textContent).toBe('gras');
    expect(container.querySelectorAll('li').length).toBe(2);
    // The raw markdown markers shouldn't survive as visible text.
    expect(container.textContent).not.toContain('**gras**');
  });

  it('renders code fences as a <pre><code> block', () => {
    const messages: ChatMessage[] = [msg({
      role: 'assistant',
      content: '```ts\nconst x = 1;\n```',
    })];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('const x = 1;');
  });

  it('shows tool call as a compact chip with the preview, full input hidden until expand', () => {
    const messages: ChatMessage[] = [msg({
      role: 'tool',
      content: '',
      tool: { name: 'Bash', input: 'git status', fullInput: '{\n  "command": "git status"\n}', toolUseId: 'toolu_1' },
    })];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    // Compact chip text contains the name + preview.
    expect(details!.textContent).toContain('Bash');
    expect(details!.textContent).toContain('git status');
    // Open the details: full INPUT pre becomes visible.
    fireEvent.click(within(details!).getByText(/Bash/));
    // jsdom doesn't auto-toggle <details> on summary click; set explicitly.
    details!.open = true;
    // Note: <details> children stay in the DOM regardless of `open` — setting
    // .open is enough for our assertions, no toggle event needed.
    expect(details!.querySelector('pre')!.textContent).toContain('"command": "git status"');
  });

  it('pairs tool with its tool_result (by toolUseId) and shows the result text on expand', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'tool', content: '', tool: { name: 'Bash', input: 'echo hi', fullInput: '{}', toolUseId: 'tu_42' } }),
      msg({ role: 'tool_result', content: 'hi\n', toolUseId: 'tu_42' }),
    ];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    // Only ONE <details> for the tool (the tool_result is consumed, not rendered standalone).
    const detailsList = container.querySelectorAll('details');
    expect(detailsList).toHaveLength(1);
    const det = detailsList[0] as HTMLDetailsElement;
    det.open = true;
    const pres = det.querySelectorAll('pre');
    expect(pres.length).toBe(2);                      // INPUT + RESULT
    expect(pres[1].textContent).toContain('hi');
    expect(det.textContent).toContain('RESULT');
  });

  it('renders thinking blocks as a collapsed 💭 bubble, expandable to show the reasoning', () => {
    const messages: ChatMessage[] = [msg({
      role: 'thinking',
      content: 'Je dois lire le fichier puis répondre.',
    })];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);                // collapsed by default
    expect(details!.textContent).toContain('💭');
    expect(details!.textContent).toContain('Réflexion');
    details!.open = true;
    // Note: <details> children stay in the DOM regardless of `open` — setting
    // .open is enough for our assertions, no toggle event needed.
    expect(details!.textContent).toContain('Je dois lire le fichier');
  });

  it('auto-expands a failed tool call so the error is visible immediately', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'tool', content: '', tool: { name: 'Bash', input: 'badcmd', fullInput: '{}', toolUseId: 'tu_err' } }),
      msg({ role: 'tool_result', content: 'command not found', toolUseId: 'tu_err', isError: true }),
    ];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('⚠️');
    expect(details.textContent).toContain('ERROR');
    expect(details.textContent).toContain('command not found');
  });

  it("doesn't render an orphan tool_result as a tool itself (degrades to a discreet system line)", () => {
    const messages: ChatMessage[] = [
      msg({ role: 'tool_result', content: 'late echo', toolUseId: 'tu_lost' }),
    ];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    // No <details> at all (no tool to pair with).
    expect(container.querySelector('details')).toBeNull();
    // The orphan content is still visible somewhere so it doesn't silently vanish.
    expect(container.textContent).toContain('orphelin');
    expect(container.textContent).toContain('late echo');
  });

  it('preserves single newlines in assistant text as <br> (remark-breaks)', () => {
    // Without remark-breaks, CommonMark collapses "ligne 1\nligne 2" into one
    // paragraph; that would silently regress versus the old pre-wrap div.
    const messages: ChatMessage[] = [msg({ role: 'assistant', content: 'ligne 1\nligne 2' })];
    const { container } = render(<AgentChatPanel {...baseProps} messages={messages} />);
    expect(container.querySelectorAll('br').length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain('ligne 1');
    expect(container.textContent).toContain('ligne 2');
  });

  it('fires onEffortChange when the effort selector changes (default → off)', () => {
    const onEffortChange = vi.fn();
    render(<AgentChatPanel {...baseProps} messages={[]} effort="default" onEffortChange={onEffortChange} />);
    // The effort select is the third one in the sub-bar (after model, mode).
    const selects = document.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(3);
    const effortSelect = selects[2] as HTMLSelectElement;
    fireEvent.change(effortSelect, { target: { value: 'off' } });
    expect(onEffortChange).toHaveBeenCalledWith('off');
  });

  it('shows the "typing…" indicator when the agent is thinking with an empty transcript', () => {
    const { container } = render(<AgentChatPanel {...baseProps} messages={[]} isThinking={true} />);
    // Indicator is identified by its aria-label; avoids matching unrelated UI text.
    expect(container.querySelector('[aria-label="L\'agent réfléchit"]')).not.toBeNull();
    // The "L'agent démarre…" placeholder must yield to the indicator (otherwise
    // we'd show two competing "waiting" messages).
    expect(container.textContent).not.toContain("L'agent démarre");
  });

  it('hides the "typing…" indicator when the session is dead, even if isThinking is true', () => {
    // A killed/crashed agent should never appear to still be typing — that
    // would lie to the user about whether new content is coming.
    const { container } = render(<AgentChatPanel {...baseProps} messages={[]} isThinking={true} dead={true} />);
    expect(container.querySelector('[aria-label="L\'agent réfléchit"]')).toBeNull();
  });

  it('hides the "typing…" indicator when isThinking is false', () => {
    const { container } = render(<AgentChatPanel {...baseProps} messages={[msg({ role: 'assistant', content: 'fini' })]} isThinking={false} />);
    expect(container.querySelector('[aria-label="L\'agent réfléchit"]')).toBeNull();
  });

  it('renders the user turn as plain text with newlines preserved', () => {
    const messages: ChatMessage[] = [msg({ role: 'user', content: 'ligne 1\nligne 2' })];
    render(<AgentChatPanel {...baseProps} messages={messages} />);
    // User text isn't passed through markdown, so the literal asterisks would survive
    // if present. Here we just check the text appears verbatim including the newline.
    expect(screen.getByText(/ligne 1/).textContent).toContain('ligne 1\nligne 2');
  });

  it('right-click on the title bar opens a colour menu that calls onColorChange', () => {
    const onColorChange = vi.fn();
    render(<AgentChatPanel {...baseProps} messages={[]} onColorChange={onColorChange} />);
    // Pas de menu tant qu'on n'a pas fait clic droit.
    expect(screen.queryByText('Couleur')).toBeNull();
    fireEvent.contextMenu(screen.getByText(/Claude 1/));
    expect(screen.getByText('Couleur')).not.toBeNull();
    fireEvent.click(screen.getByTitle(PANEL_PALETTE[2]));
    expect(onColorChange).toHaveBeenCalledWith(PANEL_PALETTE[2]);
  });
});
