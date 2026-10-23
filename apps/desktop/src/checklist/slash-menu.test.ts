import { describe, expect, it } from 'vitest';
import { filterSlashParameters, parseVariablePrefix } from './slash-menu';
import type { Parameter } from './types';

describe('double-brace variable query boundaries', () => {
  it('recognizes two braces or a Unicode query at field, line and inline positions', () => {
    expect(parseVariablePrefix('{{')).toEqual({ start: 0, query: '' });
    expect(parseVariablePrefix('{{环境')).toEqual({ start: 0, query: '环境' });
    expect(parseVariablePrefix('publish {{版本')).toEqual({ start: 8, query: '版本' });
    expect(parseVariablePrefix('first\r\n{{玩家🔧')).toEqual({ start: 7, query: '玩家🔧' });
    expect(parseVariablePrefix('first\t{{target')).toEqual({ start: 6, query: 'target' });
    expect(parseVariablePrefix('env={{环境')).toEqual({ start: 4, query: '环境' });
    expect(parseVariablePrefix('前缀{{环境')).toEqual({ start: 2, query: '环境' });
  });

  it('supports quoted and bracketed arguments while keeping the surrounding syntax outside the replacement range', () => {
    const prefixes = ['--file "{{补丁包', "--file '{{补丁包", '--file `{{补丁包', 'copy ({{补丁包', 'copy [{{补丁包'];
    for (const prefix of prefixes) {
      const match = parseVariablePrefix(prefix);
      expect(match, prefix).toEqual({ start: prefix.indexOf('{{'), query: '补丁包' });
    }
    const prefix = '--file "{{补丁包', suffix = '" --force';
    const match = parseVariablePrefix(prefix)!;
    expect(match.start).toBe(8);
    expect(prefix.slice(0, match.start) + '[variable]' + suffix).toBe('--file "[variable]" --force');
    expect(parseVariablePrefix('({{')).toEqual({ start: 1, query: '' });
  });

  it('does not trigger on single or triple braces, the old slash, paths, or a closed literal placeholder', () => {
    for (const prefix of ['{', '{{{', '{{{环境', '/环境', 'https://', 'https://example.com/env', 'http:/environment', 'word/env', 'C:/tools', 'C:\\tools/env', './env', '../env', '//server', ' /usr/local', '{{环境}}']) {
      expect(parseVariablePrefix(prefix), prefix).toBeNull();
    }
  });

  it('ends the active query at path separators, whitespace, quotes or brackets without consuming literal text', () => {
    for (const suffix of ['/', '/next', '\\', '\\path', ' ', '\t', '\n', '\r\n', "'", '"', '`', '(', ')', '[', ']', '{', '}']) {
      const source = `prefix {{环境${suffix}`;
      expect(parseVariablePrefix(source), JSON.stringify(source)).toBeNull();
    }
    expect(parseVariablePrefix(' {{first {{second')).toEqual({ start: 9, query: 'second' });
  });

  it('returns DOM-compatible UTF-16 offsets while preserving leading emoji, CRLF and surrounding text', () => {
    const prefix = '🦊前文\r\n  {{环境🔧';
    const match = parseVariablePrefix(prefix);
    expect(match).toEqual({ start: 8, query: '环境🔧' });
    expect(prefix.slice(0, match!.start)).toBe('🦊前文\r\n  ');
    expect(prefix.slice(match!.start)).toBe('{{环境🔧');
    expect(parseVariablePrefix('first {{old\n  {{new')).toEqual({ start: 14, query: 'new' });
  });

  it('allows a new opener after an existing token but never absorbs that token into the query', () => {
    expect(parseVariablePrefix('\uFFFC{{environment')).toEqual({ start: 1, query: 'environment' });
    expect(parseVariablePrefix('\uFFFC {{environment')).toEqual({ start: 2, query: 'environment' });
    expect(parseVariablePrefix(' {{environment\uFFFC')).toBeNull();
  });
});

describe('slash variable suggestions', () => {
  const parameters: Parameter[] = [
    { id: 'global-env', name: 'Environment', description: 'scope-global', defaultValue: 'release' },
    { id: 'group-env', ownerId: 'group', name: '环境', description: 'description-only-keyword', defaultValue: 'sandboxa' },
    { id: 'step-env', ownerId: 'step', name: '环境', description: '', defaultValue: 'sandboxd' },
    { id: 'branch', name: 'SourceBranch', description: 'environment appears only in this description', defaultValue: 'preview' },
    { id: 'player', ownerId: 'group', name: '玩家🔧ID', description: '', defaultValue: '9002001' },
  ];
  for (const parameter of parameters) Object.freeze(parameter);
  Object.freeze(parameters);

  it('keeps empty-query suggestions in their supplied order without changing or cloning definitions', () => {
    const result = filterSlashParameters(parameters, '');
    expect(result).toEqual(parameters);
    for (let index = 0; index < result.length; index++) expect(result[index]).toBe(parameters[index]);
    expect(parameters.map(parameter => parameter.id)).toEqual(['global-env', 'group-env', 'step-env', 'branch', 'player']);
  });

  it('matches case-insensitive substrings of names and does not search descriptions or default values', () => {
    expect(filterSlashParameters(parameters, 'ENViron').map(parameter => parameter.id)).toEqual(['global-env']);
    expect(filterSlashParameters(parameters, 'branch').map(parameter => parameter.id)).toEqual(['branch']);
    expect(filterSlashParameters(parameters, '🔧').map(parameter => parameter.id)).toEqual(['player']);
    expect(filterSlashParameters(parameters, 'description-only-keyword')).toEqual([]);
    expect(filterSlashParameters(parameters, 'sandboxa')).toEqual([]);
  });

  it('preserves distinct same-named identities and only filters the supplied visible definitions', () => {
    const visible = parameters.filter(parameter => parameter.id !== 'group-env');
    expect(filterSlashParameters(parameters, '环境').map(parameter => parameter.id)).toEqual(['group-env', 'step-env']);
    expect(filterSlashParameters(visible, '环境').map(parameter => parameter.id)).toEqual(['step-env']);
    expect(filterSlashParameters(visible, 'missing')).toEqual([]);
  });
});
