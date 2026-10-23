import type { ParameterDefinition } from '@runbook/contracts';

export function parameterValue(values: Record<string, string>, name: string, fallback = ''): string {
  return Object.hasOwn(values, name) ? values[name]! : fallback;
}

export function parameterValues(definitions: ParameterDefinition[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(definitions.map((definition) => [definition.name, parameterValue(values, definition.name, definition.default_value)]));
}

export function sameParameters(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((name) => Object.hasOwn(right, name) && left[name] === right[name]);
}
