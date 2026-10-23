import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ImageOff } from 'lucide-react';
import { Button } from '@runbook/ui';
import { api } from '@runbook/desktop-api';
import type { CommandDefinition } from '@runbook/contracts';
import { byteToOffset } from '@runbook/editor';

export function MarkdownPreview({ source, className = '' }: { source: string; className?: string }) {
  return <div className={`markdown ${className}`}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="image-placeholder"><ImageOff size={14}/> 图片：{alt || '未命名'}（本地阅读模式）</span>,
    a: ({ children, href }) => <span className="safe-link" title={href}>{children}</span>,
  }}>{source}</ReactMarkdown></div>;
}

export function CopyButton({ text, onError, label = '复制指令' }: { text: string; onError: (error: unknown) => void; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <Button size="sm" variant="ghost" onClick={() => { void api.copy(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(onError); }}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? '已复制' : label}</Button>;
}
export function CommandCard({ command, onError }: { command: CommandDefinition; onError: (error: unknown) => void }) {
  return <div className="command-card"><div className="command-bar"><span>{command.language || 'text'}</span><CopyButton text={command.text} onError={onError}/></div><pre><code>{command.text}</code></pre></div>;
}

export function RangePreview({ source, commands, start = 0, end, onError }: { source: string; commands: CommandDefinition[]; start?: number; end?: number; onError: (error: unknown) => void }) {
  let cursor = byteToOffset(source, start);
  const finish = end === undefined ? source.length : byteToOffset(source, end);
  const parts = commands.slice().sort((a, b) => a.start - b.start).flatMap((command) => {
    const from = byteToOffset(source, command.start);
    const to = byteToOffset(source, command.end);
    const before = source.slice(cursor, from);
    cursor = to;
    return [<MarkdownPreview key={`${command.id}-before`} source={before}/>, <CommandCard key={command.id} command={command} onError={onError}/>];
  });
  return <>{parts}<MarkdownPreview source={source.slice(cursor, finish)}/></>;
}
