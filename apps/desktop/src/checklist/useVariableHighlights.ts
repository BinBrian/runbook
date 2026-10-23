import { useEffect, type RefObject } from 'react';
import './variable-highlights.css';

export const variableReferenceSelector = '.variable-token[data-parameter-id], [data-frozen-reference]';
export function referenceParameterId(node: HTMLElement) { return node.dataset.frozenReference ?? node.dataset.parameterId; }

/** Decorate existing tokens; never rebuild the contenteditable DOM or its Range. */
export function useVariableHighlights(rootRef: RefObject<HTMLDivElement | null>, ids: ReadonlySet<string>, replay: number) {
  const signature = JSON.stringify([...ids].sort());
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const matched = new Set<string>(JSON.parse(signature));
    const marked = new Map<HTMLElement, Animation | undefined>();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    function sync() {
      const live = new Set([...root!.querySelectorAll<HTMLElement>(variableReferenceSelector)].filter(node => matched.has(referenceParameterId(node)!)));
      for (const [node, animation] of marked) if (!live.has(node)) { animation?.cancel(); delete node.dataset.variableMatch; marked.delete(node); }
      for (const node of live) {
        if (marked.has(node)) continue;
        node.dataset.variableMatch = '';
        const animation = reducedMotion.matches ? undefined : node.animate([
          { inset: '-1px', offset: 0, easing: 'cubic-bezier(.45, 0, .25, 1)' },
          { inset: '-4px', offset: .3 },
          { inset: '-4px', offset: .55, easing: 'cubic-bezier(.45, 0, .25, 1)' },
          { inset: '-1px', offset: 1 },
        ], { duration: 1400, pseudoElement: '::before' });
        marked.set(node, animation);
      }
    }
    function reduce() { if (reducedMotion.matches) for (const animation of marked.values()) animation?.cancel(); }
    sync();
    // Includes display/editor switches and inserted references; own marker changes
    // are deliberately excluded so the observer cannot restart itself.
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-parameter-id', 'data-frozen-reference'] });
    reducedMotion.addEventListener('change', reduce);
    return () => { observer.disconnect(); reducedMotion.removeEventListener('change', reduce); for (const [node, animation] of marked) { animation?.cancel(); delete node.dataset.variableMatch; } };
  }, [rootRef, signature, replay]);
}
