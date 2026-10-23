import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Parameter } from './types';

export interface VariableTarget {
  key: string;
  stepId: string;
  label: string;
  insert(parameter: Parameter): boolean;
  isAvailable(): boolean;
}
export interface VariableLookup { parameterId: string; stepId: string; trigger: HTMLElement }
type VariableLocator = (request: VariableLookup) => void;
interface VariableEditing {
  target: VariableTarget | null;
  setTarget(target: VariableTarget | null): void;
  clearTarget(key: string): void;
  locateVariable(request: VariableLookup): void;
  registerLocator(locator: VariableLocator): () => void;
}
const VariableEditingContext = createContext<VariableEditing | null>(null);

export function VariableEditingProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<VariableTarget | null>(null);
  const locator = useRef<VariableLocator | null>(null);
  const setTarget = useCallback((next: VariableTarget | null) => setTargetState(current => current === next ? current : next), []);
  const clearTarget = useCallback((key: string) => setTargetState(current => current?.key === key ? null : current), []);
  const locateVariable = useCallback((request: VariableLookup) => locator.current?.(request), []);
  const registerLocator = useCallback((next: VariableLocator) => { locator.current = next; return () => { if (locator.current === next) locator.current = null; }; }, []);
  const value = useMemo(() => ({ target, setTarget, clearTarget, locateVariable, registerLocator }), [target, setTarget, clearTarget, locateVariable, registerLocator]);
  return <VariableEditingContext.Provider value={value}>{children}</VariableEditingContext.Provider>;
}

export const useVariableEditing = () => useContext(VariableEditingContext);

/** A panel or a local variable dialog may receive focus without ending editing. */
export function isVariableEditingSurface(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-variable-panel], [data-selection-tools], [data-variable-popover], [data-slash-menu], .variable-popover'));
}
