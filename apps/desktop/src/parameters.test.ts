import { describe, expect, it } from 'vitest';
import { parameterValue, parameterValues, sameParameters } from './parameters';

describe('instance parameter view helpers', () => {
  it('keeps explicit empty values and uses defaults only for absent keys', () => {
    expect(parameterValues([{ name: 'HOST', default_value: 'default-host' }, { name: 'NOTE', default_value: 'default-note' }], { HOST: '' })).toEqual({ HOST: '', NOTE: 'default-note' });
  });
  it('treats prototype-like keys only as own parameter values', () => {
    expect(parameterValue({}, 'constructor', 'fallback')).toBe('fallback');
    const values = parameterValues([{ name: '__proto__', default_value: 'safe' }], {});
    expect(Object.hasOwn(values, '__proto__')).toBe(true);
    expect(values['__proto__']).toBe('safe');
  });
  it('compares values independently of object key order and detects parameter-only edits', () => {
    expect(sameParameters({ HOST: 'a', NOTE: 'x' }, { NOTE: 'x', HOST: 'a' })).toBe(true);
    expect(sameParameters({ HOST: 'a' }, { HOST: 'b' })).toBe(false);
    expect(sameParameters({}, { HOST: '' })).toBe(false);
  });
});
