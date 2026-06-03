// Pixel-art modal that opens when you click a waiting agent. It shows the
// agent's AskUserQuestion (one or several questions) and lets you answer:
// checkboxes for multi-select questions, radios for single-choice, plus a free
// "Autre" text field per question. The gold/cream palette and chunky borders
// match the in-world speech bubble. Routing the answer back to the agent is
// wired by the parent via onSubmit (Phase B-3).
import { useState, type CSSProperties } from 'react';
import type { AgentQuestion } from '../types';
import { MarkdownBody } from './MarkdownBody';

export interface QuestionAnswer {
  selected: string[];  // chosen option labels
  other: string;       // free-text answer ("" when unused)
}

// Render the answers as readable text to inject back into the agent, pairing
// each question with the chosen options (+ free text). One line per question.
export function formatAnswers(question: AgentQuestion, answers: QuestionAnswer[]): string {
  return (question.questions ?? []).map((q, i) => {
    const a = answers[i] ?? { selected: [], other: '' };
    const parts = [...a.selected];
    if (a.other.trim()) parts.push(a.other.trim());
    return `${q.question} → ${parts.join(', ')}`;
  }).join('\n');
}

// Pixel-art palette tokens, shared across modals so they stay visually consistent.
export const COLORS = {
  ink: '#3A2E12',
  border: '#4A3B1A',
  gold: '#FFE040',
  goldDeep: '#C8A000',
  cream: '#FFF8E6',
  creamSel: '#FFF0B8',
};

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 50,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.45)', fontFamily: 'monospace',
};

const modal: CSSProperties = {
  width: 'min(460px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
  background: COLORS.cream, color: COLORS.ink,
  border: `4px solid ${COLORS.border}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
};

const titleBar: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 12px', background: COLORS.gold,
  borderBottom: `4px solid ${COLORS.border}`, fontWeight: 700,
};

const closeBtn: CSSProperties = {
  cursor: 'pointer', fontWeight: 700, padding: '0 6px',
  background: 'transparent', border: 'none', color: COLORS.ink, fontFamily: 'monospace', fontSize: 16,
};

const body: CSSProperties = { padding: 12, overflowY: 'auto' };

const headerChip: CSSProperties = {
  display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: 1,
  textTransform: 'uppercase', background: COLORS.border, color: COLORS.gold,
  padding: '2px 6px', marginBottom: 6,
};

const optionRow = (selected: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4,
  cursor: 'pointer', userSelect: 'none',
  border: `2px solid ${selected ? COLORS.goldDeep : 'rgba(74,59,26,0.25)'}`,
  background: selected ? COLORS.creamSel : 'transparent',
});

const tick = (selected: boolean, round: boolean): CSSProperties => ({
  width: 14, height: 14, flexShrink: 0, boxSizing: 'border-box',
  border: `2px solid ${COLORS.border}`, borderRadius: round ? '50%' : 0,
  background: selected ? COLORS.goldDeep : '#fff',
});

const otherInput: CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '5px 7px',
  fontFamily: 'monospace', fontSize: 13, color: COLORS.ink,
  background: '#fff', border: `2px solid ${COLORS.border}`,
};

const footer: CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 8,
  padding: 12, borderTop: `4px solid ${COLORS.border}`,
};

const submitBtn = (enabled: boolean): CSSProperties => ({
  fontFamily: 'monospace', fontWeight: 700, fontSize: 13, padding: '8px 18px',
  color: COLORS.ink, background: enabled ? COLORS.gold : '#E8DFC2',
  border: `3px solid ${COLORS.border}`, boxShadow: enabled ? '3px 3px 0 rgba(0,0,0,0.3)' : 'none',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.6,
});

const decisionBtn = (variant: 'allow' | 'deny'): CSSProperties => ({
  fontFamily: 'monospace', fontWeight: 700, fontSize: 13, padding: '8px 18px',
  color: variant === 'allow' ? '#0E3A14' : '#4A0E0E',
  background: variant === 'allow' ? '#9BE07A' : '#F08A8A',
  border: `3px solid ${COLORS.border}`, boxShadow: '3px 3px 0 rgba(0,0,0,0.3)', cursor: 'pointer',
});

const toolBox: CSSProperties = {
  fontFamily: 'monospace', fontSize: 13, background: '#fff',
  border: `2px solid ${COLORS.border}`, padding: '8px 10px', marginTop: 6,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};

// Plan review (ExitPlanMode): a framed, scrollable box holding the rendered plan
// markdown. The modal body already scrolls, but capping the plan keeps the
// decision buttons reachable for long plans.
const planBox: CSSProperties = {
  background: '#fff', border: `2px solid ${COLORS.border}`,
  padding: '8px 10px', maxHeight: '52vh', overflowY: 'auto',
  fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word',
};

// Plan-rejection note: a textarea under the plan, styled like the question's
// "Autre…" field but taller and resizable.
const feedbackInput: CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '6px 8px',
  fontFamily: 'monospace', fontSize: 12, color: COLORS.ink, resize: 'vertical',
  background: '#fff', border: `2px solid ${COLORS.border}`,
};

export function InteractionModal({
  agentName, mode, question, toolName, toolInput, title, description, plan, onSubmitAnswers, onDecide, onClose,
}: {
  agentName: string;
  mode: 'question' | 'permission';
  question?: AgentQuestion;
  toolName?: string;
  toolInput?: string;
  title?: string;        // permission: SDK-rendered prompt sentence
  description?: string;  // permission: SDK-rendered subtitle
  plan?: string;         // permission: full plan markdown (ExitPlanMode)
  onSubmitAnswers?: (answers: QuestionAnswer[]) => void;
  // feedback: free-text the user attaches when refusing a plan, sent back to the
  // agent as the denial message so it can rework ("non, fais plutôt comme ça").
  onDecide?: (allow: boolean, feedback?: string) => void;
  onClose: () => void;
}) {
  const questions = question?.questions ?? [];
  const [answers, setAnswers] = useState<QuestionAnswer[]>(
    () => questions.map(() => ({ selected: [], other: '' }))
  );
  // Plan-rejection note (ExitPlanMode only). Empty → a generic refusal is sent.
  const [feedback, setFeedback] = useState('');

  const toggle = (qi: number, label: string, multi: boolean) => {
    setAnswers(prev => prev.map((a, i) => {
      if (i !== qi) return a;
      if (multi) {
        const selected = a.selected.includes(label)
          ? a.selected.filter(l => l !== label)
          : [...a.selected, label];
        return { ...a, selected };
      }
      return { ...a, selected: [label] };  // single-choice replaces
    }));
  };

  const setOther = (qi: number, value: string) =>
    setAnswers(prev => prev.map((a, i) => (i === qi ? { ...a, other: value } : a)));

  // Every question needs at least one selection or some free text.
  const complete = answers.every(a => a.selected.length > 0 || a.other.trim().length > 0);

  if (mode === 'permission') {
    // ExitPlanMode carries a full plan to review: render it as markdown and frame
    // the decision as "approve & start" / "keep planning" instead of the generic
    // allow/deny on a raw tool input.
    return (
      <div style={overlay} onClick={onClose}>
        <div style={modal} onClick={e => e.stopPropagation()}>
          <div style={titleBar}>
            <span>{agentName} {plan ? 'propose un plan' : 'demande la permission'}</span>
            <button style={closeBtn} onClick={onClose} title="Fermer">✕</button>
          </div>
          <div style={body}>
            {plan ? (
              <>
                <div style={planBox}><MarkdownBody source={plan} /></div>
                <textarea
                  style={feedbackInput}
                  placeholder="Remarques (optionnel) — renvoyées à l'agent si tu gardes en planification…"
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                  rows={2}
                />
              </>
            ) : (
              <>
                <div style={{ marginBottom: 4 }}>{title || "Autoriser l'exécution de :"}</div>
                <div style={headerChip}>{toolName || 'Tool'}</div>
                {toolInput && <div style={toolBox}>{toolInput}</div>}
                {description && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>{description}</div>}
              </>
            )}
          </div>
          <div style={footer}>
            <button
              style={decisionBtn('deny')}
              onClick={() => onDecide?.(false, plan ? (feedback.trim() || undefined) : undefined)}
            >
              {plan ? 'Garder en planification' : 'Refuser'}
            </button>
            <button style={decisionBtn('allow')} onClick={() => onDecide?.(true)}>
              {plan ? 'Approuver le plan' : 'Autoriser'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={titleBar}>
          <span>{agentName} demande</span>
          <button style={closeBtn} onClick={onClose} title="Fermer">✕</button>
        </div>

        <div style={body}>
          {questions.map((q, qi) => (
            <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 16 : 0 }}>
              {q.header && <div style={headerChip}>{q.header}</div>}
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{q.question}</div>
              {q.options.map(opt => {
                const selected = answers[qi].selected.includes(opt.label);
                return (
                  <div
                    key={opt.label}
                    style={optionRow(selected)}
                    onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                    title={opt.description || undefined}
                  >
                    <span style={tick(selected, !q.multiSelect)} />
                    <div style={{ minWidth: 0 }}>
                      <div>{opt.label}</div>
                      {opt.description && (
                        <div style={{ fontSize: 11, opacity: 0.7 }}>{opt.description}</div>
                      )}
                    </div>
                  </div>
                );
              })}
              <input
                style={otherInput}
                placeholder="Autre…"
                value={answers[qi].other}
                onChange={e => setOther(qi, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div style={footer}>
          <button
            style={submitBtn(complete)}
            disabled={!complete}
            onClick={() => complete && onSubmitAnswers?.(answers)}
          >Valider</button>
        </div>
      </div>
    </div>
  );
}
