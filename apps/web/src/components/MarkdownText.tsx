import { Fragment, type ReactNode } from 'react';

interface MarkdownTextProps {
  content: string;
}

export function MarkdownText({ content }: MarkdownTextProps) {
  return <>{renderMarkdown(content)}</>;
}

function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split('\n');
  const result: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      i += 1;
      result.push(
        <pre
          key={result.length}
          className="my-2 overflow-x-auto rounded-[8px] bg-[var(--bg-soft)] px-3.5 py-3 text-[13px] leading-[1.5]"
        >
          <code data-lang={lang || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    result.push(
      <Fragment key={result.length}>
        {i > 0 ? '\n' : null}
        {renderInline(line)}
      </Fragment>,
    );
    i += 1;
  }

  return result;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/`([^`]+)`/);

    interface MatchCandidate {
      index: number;
      length: number;
      node: ReactNode;
    }
    const candidates: MatchCandidate[] = [];

    if (boldMatch && typeof boldMatch.index === 'number') {
      candidates.push({
        index: boldMatch.index,
        length: boldMatch[0].length,
        node: (
          <strong key={`b${key++}`} className="font-semibold">
            {boldMatch[1]}
          </strong>
        ),
      });
    }

    if (codeMatch && typeof codeMatch.index === 'number') {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        node: (
          <code
            key={`c${key++}`}
            className="rounded-[4px] bg-[var(--bg-soft)] px-1.5 py-0.5 text-[0.9em]"
          >
            {codeMatch[1]}
          </code>
        ),
      });
    }

    candidates.sort((a, b) => a.index - b.index);
    const earliest = candidates[0];

    if (!earliest) {
      nodes.push(remaining);
      break;
    }

    if (earliest.index > 0) {
      nodes.push(remaining.slice(0, earliest.index));
    }
    nodes.push(earliest.node);
    remaining = remaining.slice(earliest.index + earliest.length);
  }

  return nodes;
}
