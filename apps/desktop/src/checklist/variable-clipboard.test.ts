import { describe, expect, it, vi } from 'vitest';
import { clipboardParameter, readVariableClipboard, variableClipboardData } from './variable-clipboard';
import type { Parameter } from './types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), writeHtml: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));
vi.mock('@runbook/desktop-api', () => ({ writeClipboardHtml: mocks.writeHtml, writeClipboardText: vi.fn() }));

const parameter = (id: string, name = '环境', ownerId?: string): Parameter => ({ id, name, description: '', defaultValue: 'release', ...(ownerId ? { ownerId } : {}) });

describe('portable single-variable clipboard reference', () => {
  it('writes one versioned stable identity and escapes names while preserving a readable plain fallback', () => {
    const data = variableClipboardData(parameter('env-stable', '<环境> & "名称" \'🔧'));
    expect(data).toEqual({
      html: '<span data-runbook-variable-ref="1" data-parameter-id="env-stable">&lt;环境&gt; &amp; &quot;名称&quot; &#39;🔧</span>',
      text: '{{<环境> & "名称" \'🔧}}',
    });
    expect(readVariableClipboard(data.html)).toEqual({ kind: 'reference', parameterId: 'env-stable' });
  });

  it('recognizes only our complete reference, including ordinary Windows fragment and HTML wrappers', () => {
    const { html } = variableClipboardData(parameter('step-local'));
    for (const value of [html, ` \n${html}\r\n`, `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`, `<html><head><meta charset="utf-8"></head><body>${html}</body></html>`, `<meta charset='utf-8'>${html}`]) {
      expect(readVariableClipboard(value)).toEqual({ kind: 'reference', parameterId: 'step-local' });
    }
    expect(readVariableClipboard('<SPAN data-parameter-id=\'step-local\' data-runbook-variable-ref=\'1\'>renamed text</SPAN>')).toEqual({ kind: 'reference', parameterId: 'step-local' });
  });

  it('never interprets plain placeholders, external HTML, or arbitrary HTML parameter attributes as references', () => {
    for (const html of ['', '{{环境}}', '<b>{{环境}}</b>', '<span data-parameter-id="env">环境</span>', '<img src="x" onerror="external()">']) {
      expect(readVariableClipboard(html)).toEqual({ kind: 'none' });
    }
  });

  it('rejects unsupported versions, malformed identities, extra attributes, nested markup and mixed fragments', () => {
    const { html } = variableClipboardData(parameter('env'));
    const invalid = [
      html.replace('variable-ref="1"', 'variable-ref="2"'),
      html.replace('parameter-id="env"', 'parameter-id=""'),
      html.replace('parameter-id="env"', 'parameter-id="../env"'),
      html.replace('parameter-id="env"', `parameter-id="${'a'.repeat(129)}"`),
      html.replace('parameter-id="env"', 'parameter-id="CON"'),
      html.replace('parameter-id="env"', 'parameter-id="&#101;nv"'),
      html.replace('<span ', '<span onclick="external()" '),
      html.replace('<span ', '<span data-parameter-id="other" '),
      html.replace('>环境</span>', '><b>环境</b></span>'),
      `before${html}`, `${html}${html}`, `${html}\0`,
      `<!--EndFragment-->${html}<!--StartFragment-->`,
      `<!--StartFragment-->${html}<!--EndFragment--><!--EndFragment-->`,
    ];
    for (const value of invalid) expect(readVariableClipboard(value), value).toEqual({ kind: 'invalid' });
    expect(() => variableClipboardData(parameter('not/a/valid/id'))).toThrow('变量定义无效');
  });

  it('resolves renamed variables by exact ID while rejecting absent or foreign-scope same-name definitions', () => {
    const global = parameter('global', '环境'), group = parameter('group-a', '环境', 'a'), other = parameter('group-b', '环境', 'b'), own = parameter('step', '环境', 'current');
    const definitions = [global, group, other, own];
    const reference = readVariableClipboard(variableClipboardData(group).html);
    expect(reference.kind).toBe('reference');
    group.name = '目标环境（已改名）';
    expect(clipboardParameter('group-a', definitions, 'current', 'a')).toBe(group);
    expect(clipboardParameter('group-a', definitions, 'current', 'a')?.name).toBe('目标环境（已改名）');
    expect(clipboardParameter('group-b', definitions, 'current', 'a')).toBeUndefined();
    expect(clipboardParameter('missing', definitions, 'current', 'a')).toBeUndefined();
    expect(clipboardParameter('step', definitions, 'different', 'a')).toBeUndefined();
    expect(clipboardParameter('step', definitions, 'current', 'a')).toBe(own);
    expect(clipboardParameter('global', definitions, 'current', 'a')).toBe(global);
    expect(clipboardParameter('global', definitions, 'current', 'a', false)).toBeUndefined();
  });
});

describe('reference copy save barrier', () => {
  async function subject() {
    vi.resetModules(); vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); mocks.writeHtml.mockResolvedValue(undefined);
    return (await import('./api')).api;
  }

  it('flushes before writing HTML and plain formats without applying parameter drafts or requiring an editor caret', async () => {
    const api = await subject();
    let finish!: () => void;
    api.registerFlush(() => new Promise<void>(resolve => { finish = resolve; }));
    const source = parameter('stable', '环境');
    const copying = api.copyVariableReference(source);
    source.name = 'later mutation';
    await Promise.resolve();
    expect(mocks.writeHtml).not.toHaveBeenCalled();
    finish(); await copying;
    const data = variableClipboardData(parameter('stable', '环境'));
    expect(mocks.writeHtml).toHaveBeenCalledExactlyOnceWith(data.html, data.text);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not write a misleading clipboard reference when flushing fails', async () => {
    const api = await subject();
    api.registerFlush(async () => { throw new Error('cannot save definition'); });
    await expect(api.copyVariableReference(parameter('stable'))).rejects.toThrow('cannot save definition');
    expect(mocks.writeHtml).not.toHaveBeenCalled();
  });

  it('does not attempt clipboard writes outside the desktop runtime', async () => {
    const api = await subject(); mocks.isTauri.mockReturnValue(false);
    await expect(api.copyVariableReference(parameter('stable'))).rejects.toThrow('Windows 桌面程序');
    expect(mocks.writeHtml).not.toHaveBeenCalled();
  });
});
