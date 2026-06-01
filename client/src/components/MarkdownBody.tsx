// Shared markdown renderer for agent-authored text. Used by the chat panel
// (assistant replies, thinking, tool results) and the interaction modal (the
// ExitPlanMode plan). Keeps the pixel-art skin and avoids leaking the default
// white-on-blue link colour; code fences sit in a small framed box matched to
// ToolCall's expanded content for visual consistency.
import type { CSSProperties, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const codeInline: CSSProperties = {
  fontFamily: 'monospace', fontSize: '0.92em',
  background: '#F1E7CC', padding: '0 4px', borderRadius: 2,
};

const codeBlock: CSSProperties = {
  margin: '4px 0', padding: '6px 8px',
  background: '#FFF8E6', border: `1px solid rgba(74,59,26,0.3)`,
  fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap',
  wordBreak: 'break-word', overflow: 'auto',
};

const mdLink: CSSProperties = { color: '#7B4500', textDecoration: 'underline' };

const mdTable: CSSProperties = {
  borderCollapse: 'collapse', margin: '4px 0', fontSize: 12,
};

const mdCell: CSSProperties = {
  border: `1px solid rgba(74,59,26,0.4)`, padding: '2px 6px',
};

// Markdown components map: the cast keeps TS happy because `code` receives an
// extra `inline` prop that ReactMarkdown injects at runtime but isn't typed.
const markdownComponents: Components = {
  // Use a span when the parent isn't `pre` (avoid <pre><pre>).
  code(props) {
    const { children, className, ...rest } = props as { children?: ReactNode; className?: string; inline?: boolean };
    const isInline = !className;  // react-markdown sets className="language-…" on fences only
    return isInline
      ? <code style={codeInline} {...rest}>{children}</code>
      : <code className={className} {...rest}>{children}</code>;
  },
  pre: ({ children }) => <pre style={codeBlock}>{children}</pre>,
  a: ({ href, children }) => <a href={href} style={mdLink} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <table style={mdTable}>{children}</table>,
  th: ({ children }) => <th style={mdCell}>{children}</th>,
  td: ({ children }) => <td style={mdCell}>{children}</td>,
  // Trim default top margin on the first/only paragraph so a one-line reply
  // doesn't have extra whitespace above it inside the bubble.
  p: ({ children }) => <p style={{ margin: '4px 0' }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 18 }}>{children}</ol>,
  h1: ({ children }) => <h3 style={{ margin: '6px 0 2px', fontSize: 14 }}>{children}</h3>,
  h2: ({ children }) => <h3 style={{ margin: '6px 0 2px', fontSize: 13 }}>{children}</h3>,
  h3: ({ children }) => <h3 style={{ margin: '6px 0 2px', fontSize: 13 }}>{children}</h3>,
};

// `remark-breaks` turns single `\n` into <br>, matching the old `pre-wrap`
// behaviour (and what Claude.ai's renderer does): agents rarely double-newline
// their bullet items or short notes, and CommonMark would otherwise collapse
// those lines into one paragraph.
export function MarkdownBody({ source }: { source: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>{source}</ReactMarkdown>;
}
