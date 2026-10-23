import type { TextParts } from './types';

/** A frozen field stays snapshot text, even if its source cannot be mapped. */
export function snapshotReferences(parts: TextParts, text: string, values: Record<string, string>): { text: string; parameterId?: string }[] {
  const fragments = parts.map(part => typeof part === 'string' ? { text: part } : { text: values[part.parameterId] ?? '', parameterId: part.parameterId });
  return fragments.map(part => part.text).join('') === text ? fragments : [{ text }];
}
