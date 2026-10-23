import { describe, expect, it } from 'vitest';
import { convertSelectionToVariable, parameterDefaults, setParameterDefault, validateVariableSelection } from './parameters';

describe('explicit parameter editing', () => {
  it('replaces only the selected occurrence and preserves the selected default text', () => {
    const source = 'echo staging staging';
    const result = convertSelectionToVariable(source, { from: 5, to: 12 }, 'HOST');
    expect(result).toContain('echo {{rb:HOST}} staging');
    expect(parameterDefaults(result)).toEqual({ HOST: 'staging' });
  });
  it('supports a partial command selection without changing fences, Unicode or CRLF', () => {
    const source = '# 中文😀\r\n\r\n```powershell\r\necho "  甲😀  "\r\n```\r\n';
    const from = source.indexOf('  甲😀  '), to = from + '  甲😀  '.length;
    const result = convertSelectionToVariable(source, { from, to }, 'TARGET');
    expect(result).toContain(source.slice(0, from) + '{{rb:TARGET}}' + source.slice(to));
    expect(parameterDefaults(result)).toEqual({ TARGET: '  甲😀  ' });
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
  });
  it('round trips quotes, backslashes, multiline values and comment terminators', () => {
    const value = '中文\\path "x"\r\n<!-- marker -->\r\n';
    const result = setParameterDefault('正文', 'MESSAGE', value);
    const line = result.split('\n').find((item) => item.includes('runbook:parameters'))!;
    expect(line.match(/-->/g)).toHaveLength(1);
    expect(parameterDefaults(result).MESSAGE).toBe(value);
  });
  it('reuses an existing variable without silently replacing its default', () => {
    const source = setParameterDefault('first second', 'HOST', 'original');
    const from = source.indexOf('second');
    const result = convertSelectionToVariable(source, { from, to: from + 6 }, 'HOST', 'replacement');
    expect(parameterDefaults(result).HOST).toBe('original');
    expect(result.match(/runbook:parameters/g)).toHaveLength(1);
    expect(result).toContain('first {{rb:HOST}}');
  });
  it('updates one default while preserving source and other definitions', () => {
    const source = setParameterDefault(setParameterDefault('echo {{rb:HOST}}', 'HOST', 'a'), 'PATH', 'unchanged');
    const result = setParameterDefault(source, 'HOST', 'b');
    expect(parameterDefaults(result)).toEqual({ HOST: 'b', PATH: 'unchanged' });
    expect(result.endsWith('echo {{rb:HOST}}')).toBe(true);
  });
  it('rejects empty, invalid, surrogate-split and CRLF-split selections', () => {
    for (const [source, from, to] of [['', 0, 0], ['  ', 0, 2], ['😀', 0, 1], ['a\r\nb', 0, 2]] as const) expect(() => validateVariableSelection(source, { from, to })).toThrow();
    expect(() => convertSelectionToVariable('abc', { from: 0, to: 3 }, 'bad-name')).toThrow('变量名');
    expect(() => convertSelectionToVariable('abc', { from: 0, to: 3 }, '1FIRST')).toThrow('变量名');
  });
  it('rejects semantic marker and existing placeholder overlap', () => {
    const source = setParameterDefault('echo {{rb:HOST}}', 'HOST', 'staging');
    const markerFrom = source.indexOf('parameters');
    expect(() => validateVariableSelection(source, { from: markerFrom, to: markerFrom + 5 })).toThrow('标记');
    const tokenFrom = source.indexOf('{{rb:HOST}}');
    expect(() => validateVariableSelection(source, { from: tokenFrom + 5, to: tokenFrom + 9 })).toThrow('重叠');
    expect(() => validateVariableSelection(source, { from: tokenFrom, to: tokenFrom + 11 })).toThrow('重叠');
  });
  it('protects fence delimiters and language while allowing the body', () => {
    const source = '```powershell\necho staging\n```';
    expect(() => validateVariableSelection(source, { from: 0, to: 3 })).toThrow('结构');
    expect(() => validateVariableSelection(source, { from: 3, to: 13 })).toThrow('结构');
    const from = source.indexOf('staging');
    expect(validateVariableSelection(source, { from, to: from + 7 })).toBe('staging');
  });
  it('never edits a fenced example of a parameters marker', () => {
    const source = '```text\n<!-- runbook:parameters {"FAKE":"sample"} -->\n```\n\n正文';
    const result = setParameterDefault(source, 'REAL', 'real');
    expect(parameterDefaults(result)).toEqual({ REAL: 'real' });
    expect(result).toContain(source);
  });
  it('treats prototype-like valid names as ordinary own definitions', () => {
    const result = convertSelectionToVariable('original', { from: 0, to: 8 }, '__proto__');
    expect(Object.hasOwn(parameterDefaults(result), '__proto__')).toBe(true);
    expect(parameterDefaults(result)['__proto__']).toBe('original');
  });
});
