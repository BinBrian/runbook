import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import type { ChecklistDocument } from './types';
import { isVariableEditingSurface, useVariableEditing } from './VariableEditing';

export function useVariableScope(document: ChecklistDocument, initial?: string) {
  const editing = useVariableEditing();
  const [viewing, updateViewing] = useState<string | undefined>(initial ?? document.steps[0]?.id);
  // A direct navigation/parameter request wins over intermediate smooth-scroll
  // positions. Resume viewport tracking when the user interacts with the body.
  const located = useRef<string | undefined>(undefined);
  const setViewing = useCallback((id: string | undefined) => {
    // Missing-item summaries change while a value is typed. Their layout must
    // not switch the scope and unmount the focused panel input.
    if (located.current || isVariableEditingSurface(window.document.activeElement)) return;
    updateViewing(id);
  }, []);
  useEffect(() => {
    if (editing?.target && !editing.target.isAvailable()) editing.setTarget(null);
  }, [document, editing]);
  function select(event: SyntheticEvent) {
    const node = event.target;
    if (!(node instanceof HTMLElement) || isVariableEditingSurface(node)) return;
    located.current = undefined;
    if (!node.closest('.parts-field')) editing?.setTarget(null);
    const stepId = node.closest<HTMLElement>('[data-step-id]')?.dataset.stepId;
    const groupId = node.closest<HTMLElement>('[data-group-id]')?.dataset.groupId;
    const id = stepId ?? (groupId ? document.steps.find(step => step.groupId === groupId)?.id : undefined);
    if (id) updateViewing(id);
  }
  function locate(id: string) { located.current = id; editing?.setTarget(null); updateViewing(id); }
  function release() { located.current = undefined; }
  return { viewing, setViewing, select, locate, release };
}
