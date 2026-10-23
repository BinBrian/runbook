import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, ChevronsRight, Search, X } from 'lucide-react';
import type { ChecklistDocument, Instance, Parameter } from './types';
import type { EditDocument } from './DocumentEditor';
import { defaultValues, globalParameters, latestResult, localParameters, referencedParameterIds, renderText, uid, visibleParameters } from './model';
import { useVariableEditing, isVariableEditingSurface, type VariableLookup } from './VariableEditing';
import { useExplicitDraft } from './ui-hooks';
import { api } from './api';
import { VariableMenu } from './VariableMenu';
import { matchingVariableIds, variableBranches, variableHistory, type VariableBranch } from './variable-tree';
import { readPanelPreference, savePanelPreference, VARIABLE_PANEL_NARROW_QUERY } from './panel-preferences';
import './variable-panel.css';

export interface VariablePanelProps {
  document: ChecklistDocument;
  stepId?: string;
  onLocateStep: (stepId: string) => void;
  instance?: Instance;
  draftValues?: Record<string, string>;
  edit?: EditDocument;
  canEditDefinition?: (parameter: Parameter) => boolean;
  canEditValue?: (parameter: Parameter) => boolean;
  canAddScope?: (ownerId?: string) => boolean;
  onValueChange?: (id: string, value: string) => void;
  onApplyScope?: (ownerId?: string) => void;
  onCancelScope?: (ownerId?: string) => void;
  busy?: boolean;
  allowGlobal?: boolean;
  focusRequest?: { id: string; version: number };
  draftKey?: string;
  searchState?: { query: string; parameterId?: string; keepTree?: boolean };
  onSearch?: (query: string) => void;
  onClearSearch?: () => void;
  onFindReferences?: (parameterId: string, editValue?: boolean) => void;
  searchStepCount?: number;
}
interface DefinitionDraft {
  kind: 'add' | 'edit';
  id: string;
  ownerId?: string;
  ownerLabel: string;
  name: string;
  description: string;
  defaultValue: string;
}
interface ScopeSection { key: 'global' | 'group' | 'step'; name: string; owner: string; ownerId?: string; exists: boolean; parameters: Parameter[] }

export function VariablePanel({ document, stepId, onLocateStep, instance, draftValues, edit, canEditDefinition, canEditValue, canAddScope, onValueChange, onApplyScope, onCancelScope, busy = false, allowGlobal = true, focusRequest, draftKey, searchState, onSearch, onClearSearch, onFindReferences, searchStepCount }: VariablePanelProps) {
  const editing = useVariableEditing();
  const [narrow, setNarrow] = useState(() => window.matchMedia(VARIABLE_PANEL_NARROW_QUERY).matches);
  const [open, setOpen] = useState(() => readPanelPreference(window.matchMedia(VARIABLE_PANEL_NARROW_QUERY).matches ? 'narrow' : 'wide'));
  const panelId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [localQuery, setLocalQuery] = useState('');
  const query = searchState?.query ?? localQuery;
  function setQuery(next: string) { setRevealedParameterId(null); setLocalQuery(next); onSearch?.(next); }
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(document.groups?.filter(g => g.id !== document.steps.find(s => s.id === stepId)?.groupId).map(g => g.id)));
  function clearSearch() { setRevealedParameterId(null); setLocalQuery(''); if (onClearSearch) onClearSearch(); else onSearch?.(''); }
  const [focusedValueId, setFocusedValueId] = useState<string | null>(null);
  const [revealedParameterId, setRevealedParameterId] = useState<string | null>(null);
  const [selectedVariableId, setSelectedVariableId] = useState<string | null>(null);
  const [retainedTreeIds, setRetainedTreeIds] = useState<Set<string> | null>(null);
  const [valueEditId, setValueEditId] = useState<string | null>(null);
  function finishValueEdit(id: string) { setValueEditId(null); requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[data-variable-id="' + CSS.escape(id) + '"] [data-variable-name]')?.focus({ preventScroll: true })); }
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [copying, setCopying] = useState(false);
  const copyingReference = useRef(false);
  const [formError, setFormError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const defaultInput = useRef<HTMLTextAreaElement>(null);
  const formFocus = useRef<'name' | 'default'>('name');
  const [lookup, setLookup] = useState<(VariableLookup & { version: number }) | null>(null);
  const [highlighted, setHighlighted] = useState<{ parameterId: string; stepId: string } | null>(null);
  const lookupVersion = useRef(0);
  const formTrigger = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const saving = useRef(false);
  const focusFrame = useRef<number | undefined>(undefined);
  const focusVersion = useRef(0);
  function revealPanel(trigger?: HTMLElement) {
    if (!open) returnFocus.current = trigger ?? (window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null);
    setOpen(true);
  }
  function userOpen(next: boolean) {
    savePanelPreference(narrow ? 'narrow' : 'wide', next);
    if (next) {
      revealPanel();
      if (narrow) requestAnimationFrame(() => panel.current?.querySelector<HTMLInputElement>('[aria-label="搜索变量"]')?.focus({ preventScroll: true }));
    } else {
      ++focusVersion.current;
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
      setOpen(false);
      if (narrow) requestAnimationFrame(() => {
        const previous = returnFocus.current;
        if (previous?.isConnected && !panel.current?.contains(previous) && previous.getClientRects().length) previous.focus({ preventScroll: true });
        else launcher.current?.focus({ preventScroll: true });
      });
    }
  }
  useEffect(() => {
    const media = window.matchMedia(VARIABLE_PANEL_NARROW_QUERY);
    const change = () => {
      setNarrow(media.matches);
      const visible = readPanelPreference(media.matches ? 'narrow' : 'wide');
      setOpen(visible);
      if (!visible && panel.current?.contains(window.document.activeElement)) requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!narrow || !open) return;
    function keys(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const active = window.document.activeElement;
      if (active?.closest('[role="dialog"]') && !panel.current?.contains(active)) return;
      if (event.key === 'Escape') { event.preventDefault(); userOpen(false); return; }
      if (event.key !== 'Tab') return;
      // Portaled variable menus manage their own keyboard navigation.
      if (window.document.activeElement?.closest('.variable-action-menu')) return;
      const fields = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
      const first = fields[0], last = fields.at(-1);
      if (!first) return;
      if (!panel.current?.contains(active) || (!event.shiftKey && active === last) || (event.shiftKey && active === first)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    }
    window.document.addEventListener('keydown', keys);
    return () => window.document.removeEventListener('keydown', keys);
  }, [narrow, open]);
  const identity = useRef(draftKey ?? (instance ? `instance:${instance.id}` : `document:${document.steps[0]?.id ?? uid()}`));
  const definitionDraft = useExplicitDraft<DefinitionDraft | null>(`variable-definition:${identity.current}`, null, '变量定义', draftKey ? { kind: draftKey.slice(0, draftKey.indexOf(':')) as 'template' | 'block' | 'instance', id: draftKey.slice(draftKey.indexOf(':') + 1), stepId } : undefined);
  const form = definitionDraft.value;
  const target = editing?.target;
  const activeId = target?.isAvailable() ? target.stepId : stepId;
  const step = document.steps.find(item => item.id === activeId) ?? document.steps[0];
  const group = document.groups?.find(item => item.id === step?.groupId);
  const result = instance && step ? latestResult(instance, step.id) : undefined;
  const historical = Boolean(result && result.outcome !== 'failed');
  const frozen = Boolean(instance && (historical || !['draft', 'in_progress'].includes(instance.status)));
  const values = historical && result ? result.snapshot.parameterValues : instance ? instance.parameterValues : defaultValues(document.parameters);
  const heading = step ? historical && result ? result.snapshot.title : renderText(step.title, values) : '';
  const referenced = referencedParameterIds(document);
  const sections: ScopeSection[] = [
    ...(allowGlobal ? [{ key: 'global' as const, name: '全局变量', owner: '整个流程', exists: true, parameters: globalParameters(document) }] : []),
    ...(document.groups ?? []).map(group => ({ key: 'group' as const, name: '步骤组', owner: group.name.trim() || '未命名步骤组', ownerId: group.id, exists: true, parameters: localParameters(document, group.id) })),
    ...document.steps.map(step => ({ key: 'step' as const, name: '步骤', owner: renderText(step.title, values).trim() || '未命名步骤', ownerId: step.id, exists: true, parameters: localParameters(document, step.id) })),
  ];
  function historyFor(parameter: Parameter) { return variableHistory(instance ? { ...instance, document } : undefined, parameter, activeId); }
  function parameterFrozen(parameter: Parameter) { return Boolean(instance && (historyFor(parameter) || !['draft', 'in_progress'].includes(instance.status))); }
  function scopeFrozen(ownerId?: string) { return parameterFrozen({ id: '', name: '', description: '', defaultValue: '', ...(ownerId ? { ownerId } : {}) }); }
  function reveal(parameter: Parameter) { setCollapsed(previous => { const next = new Set(previous); if (parameter.ownerId) { next.delete(parameter.ownerId); const owned = document.steps.find(step => step.id === parameter.ownerId); if (owned?.groupId) next.delete(owned.groupId); } return next; }); }
  function ownerExists(ownerId?: string) { return ownerId ? document.steps.some(item => item.id === ownerId) || Boolean(document.groups?.some(item => item.id === ownerId)) : allowGlobal; }
  function definitionMutable(parameter: Parameter) { return Boolean(edit && !parameterFrozen(parameter) && (canEditDefinition?.(parameter) ?? !instance)); }
  function valueMutable(parameter: Parameter) { return Boolean(instance && !parameterFrozen(parameter) && onValueChange && canEditValue?.(parameter)); }
  function canAdd(ownerId?: string) { return Boolean(edit && !scopeFrozen(ownerId) && ownerExists(ownerId) && (canAddScope?.(ownerId) ?? !instance)); }
  function currentValue(parameter: Parameter) { const history = historyFor(parameter); return history ? history.snapshot.parameterValues[parameter.id] ?? '' : draftValues?.[parameter.id] ?? instance?.parameterValues[parameter.id] ?? parameter.defaultValue; }
  function pendingValue(parameter: Parameter) { return Boolean(instance && !historyFor(parameter) && currentValue(parameter) !== (instance.parameterValues[parameter.id] ?? parameter.defaultValue)); }
  useEffect(() => { setFocusedValueId(null); }, [activeId]);
  useEffect(() => { if (!copyStatus) return; const timer = setTimeout(() => setCopyStatus(''), 3000); return () => clearTimeout(timer); }, [copyStatus]);
  async function copyReference(parameter: Parameter) {
    if (busy || copyingReference.current) return;
    copyingReference.current = true; setCopying(true); setError(''); setCopyStatus('');
    try { await api.copyVariableReference(parameter); setCopyStatus('变量引用已复制'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { copyingReference.current = false; setCopying(false); }
  }
  function showForm(next: DefinitionDraft, trigger: HTMLElement, focus: 'name' | 'default' = 'name') {
    if (busy || saving.current) return;
    if (form) { setError('请先保存或取消正在编辑的变量定义。'); return; }
    formTrigger.current = trigger; formFocus.current = focus; setFormError(''); setError(''); revealPanel(trigger); definitionDraft.update(next);
  }
  function closeForm() { if (busy || saving.current) return; restoreFocus.current = true; definitionDraft.reset(null); setFormError(''); }
  const original = form?.kind === 'edit' ? document.parameters.find(parameter => parameter.id === form.id) : undefined;
  const formAllowed = Boolean(form && edit && !scopeFrozen(form.ownerId) && ownerExists(form.ownerId) && (form.kind === 'add' ? canAdd(form.ownerId) : original && original.ownerId === form.ownerId && definitionMutable(original)));
  const invalidName = form && !form.name.trim() ? '请填写变量名称。' : form && [form.name, form.description, form.defaultValue].some(value => value.includes('\0')) ? '变量定义不能包含空字符。' : '';
  function saveForm() {
    if (!form || !edit || busy || saving.current || !formAllowed || invalidName) return;
    saving.current = true; setFormError('');
    try {
      const submitted = { ...form };
      edit(doc => {
        if (submitted.ownerId ? !doc.steps.some(item => item.id === submitted.ownerId) && !doc.groups?.some(item => item.id === submitted.ownerId) : !allowGlobal) throw new Error('原作用范围已不存在，请取消后重新选择范围。');
        if (submitted.kind === 'add') {
          if (!canAdd(submitted.ownerId)) throw new Error('此范围现在不可新增变量。');
          if (doc.parameters.some(parameter => parameter.id === submitted.id)) throw new Error('变量已存在，请取消后查看。');
          const parameter: Parameter = { id: submitted.id, name: submitted.name.trim(), description: submitted.description, defaultValue: submitted.defaultValue, ...(submitted.ownerId ? { ownerId: submitted.ownerId } : {}) };
          return { ...doc, parameters: [...doc.parameters, parameter] };
        }
        const parameter = doc.parameters.find(item => item.id === submitted.id);
        if (!parameter || parameter.ownerId !== submitted.ownerId || !definitionMutable(parameter)) throw new Error('原变量已改变或被冻结，请取消后查看。');
        return { ...doc, parameters: doc.parameters.map(item => item.id === submitted.id ? { ...item, name: submitted.name.trim(), description: submitted.description, defaultValue: submitted.defaultValue } : item) };
      });
      restoreFocus.current = true; definitionDraft.reset(null);
      if (submitted.kind === 'add') { clearSearch(); reveal({ id: submitted.id, name: submitted.name, description: submitted.description, defaultValue: submitted.defaultValue, ownerId: submitted.ownerId }); }
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : String(reason)); }
    finally { saving.current = false; }
  }
  function deleteParameter(parameter: Parameter) {
    if (!edit || busy || saving.current || form || !definitionMutable(parameter) || referenced.has(parameter.id)) return;
    try {
      edit(doc => { const latest = doc.parameters.find(item => item.id === parameter.id); if (!latest || !definitionMutable(latest) || referencedParameterIds(doc).has(parameter.id)) throw new Error('变量已被使用或不可修改，不能删除。'); return { ...doc, parameters: doc.parameters.filter(item => item.id !== parameter.id) }; });
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  function focusWithinPanel(element: HTMLElement) {
    const area = scroll.current;
    if (area) { const rect = element.getBoundingClientRect(), viewport = area.getBoundingClientRect(); area.scrollTo({ top: Math.max(0, area.scrollTop + rect.top - viewport.top - area.clientHeight / 2 + rect.height / 2), behavior: 'instant' }); }
    element.focus({ preventScroll: true });
  }
  const locateVariable = (request: VariableLookup) => {
    const source = document.steps.find(step => step.id === request.stepId);
    const parameter = source && visibleParameters(document, source.id).find(item => item.id === request.parameterId);
    if (!parameter || !request.trigger.isConnected || request.trigger.closest<HTMLElement>('[data-step-id]')?.dataset.stepId !== request.stepId) { setError('目标变量不在当前范围，请重新定位。'); return; }
    revealPanel(request.trigger);
    if (busy || saving.current) { setError('正在保存，请稍后再定位变量。'); return; }
    if (form) {
      if (form.kind === 'edit' && form.id === parameter.id && form.ownerId === parameter.ownerId) { formFocus.current = 'default'; if (defaultInput.current) focusWithinPanel(defaultInput.current); }
      else { setError('请先保存或取消正在编辑的变量定义。'); nameInput.current?.focus({ preventScroll: true }); }
      return;
    }
    ++focusVersion.current; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    reveal(parameter); setSelectedVariableId(parameter.id); setRevealedParameterId(parameter.id); setValueEditId(parameter.id); setError(''); editing?.setTarget(null); onLocateStep(source!.id);
    setLookup({ ...request, version: ++lookupVersion.current });
  };
  const locator = useRef(locateVariable); locator.current = locateVariable;
  useLayoutEffect(() => editing?.registerLocator(request => locator.current(request)), [editing?.registerLocator]);
  useLayoutEffect(() => {
    if (!lookup || activeId !== lookup.stepId || !open) return;
    const parameter = visibleParameters(document, lookup.stepId).find(item => item.id === lookup.parameterId);
    setLookup(null);
    if (!parameter) { setError('目标变量已不存在，请重新定位。'); return; }
    setHighlighted({ parameterId: parameter.id, stepId: lookup.stepId });
    if (!instance && definitionMutable(parameter)) {
      const section = sections.find(section => section.parameters.some(item => item.id === parameter.id))!;
      showForm({ kind: 'edit', id: parameter.id, ownerId: parameter.ownerId, ownerLabel: section.owner, name: parameter.name, description: parameter.description, defaultValue: parameter.defaultValue }, lookup.trigger, 'default');
      return;
    }
    const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-variable-id]') ?? [])].find(item => item.dataset.variableId === parameter.id);
    const input = row?.querySelector<HTMLElement>('[data-parameter-id]');
    if (input ?? row) focusWithinPanel(input ?? row!);
  }, [lookup?.version, activeId, open]);
  useLayoutEffect(() => {
    if (form && open) { const field = formFocus.current === 'default' ? defaultInput.current : nameInput.current; if (field) focusWithinPanel(field); }
    else if (!form && restoreFocus.current) { restoreFocus.current = false; const element = formTrigger.current?.isConnected ? formTrigger.current : panel.current?.querySelector<HTMLButtonElement>('header button'); element?.focus({ preventScroll: true }); }
  }, [form?.id, open]);
  useEffect(() => {
    if (!focusRequest) return;
    const version = ++focusVersion.current;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    setLookup(null); revealPanel(); editing?.setTarget(null);
    const requested = document.parameters.find(p => p.id === focusRequest.id); if (requested) { reveal(requested); setSelectedVariableId(requested.id); setRevealedParameterId(requested.id); setValueEditId(requested.id); }
    function focus(attempts: number) {
      if (version !== focusVersion.current) return;
      const input = [...(panel.current?.querySelectorAll<HTMLElement>('[data-parameter-id]') ?? [])].find(item => item.dataset.parameterId === focusRequest!.id);
      if (input && scroll.current) { focusWithinPanel(input); focusFrame.current = undefined; }
      else if (attempts > 0) focusFrame.current = requestAnimationFrame(() => focus(attempts - 1));
      else { focusFrame.current = undefined; setError('目标变量不在当前范围，请重新定位。'); }
    }
    focusFrame.current = requestAnimationFrame(() => focus(5));
    return () => { focusVersion.current += 1; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current); };
  }, [focusRequest?.id, focusRequest?.version]);
  const search = query.trim();
  const displayedValues = Object.fromEntries(document.parameters.map(p => [p.id, currentValue(p)]));
  const matchedIds = searchState?.keepTree && retainedTreeIds ? retainedTreeIds : matchingVariableIds(document, query, displayedValues, searchState?.parameterId);
  function matches(parameter: Parameter) { return matchedIds.has(parameter.id) || focusedValueId === parameter.id || revealedParameterId === parameter.id; }
  const matchCount = document.parameters.filter(matches).length;
  const branches = variableBranches(document, displayedValues);
  useEffect(() => { if (!searchState?.keepTree && (query.trim() || searchState?.parameterId)) setCollapsed(new Set()); }, [query, searchState?.parameterId, searchState?.keepTree]);
  function findReferences(parameter: Parameter) {
    if (!searchState?.keepTree) setRetainedTreeIds(new Set(document.parameters.filter(matches).map(item => item.id)));
    setRevealedParameterId(null); setSelectedVariableId(parameter.id); onFindReferences?.(parameter.id, false);
  }
  const footer = error || (form ? '变量定义尚未提交' : copyStatus);
  function addItem(section: ScopeSection) { return { label: section.key === 'global' ? '新增全局变量' : section.key === 'group' ? '新增步骤组变量' : '新增步骤变量', disabled: busy || !canAdd(section.ownerId) || Boolean(form), reason: form ? '先保存或取消当前定义表单' : !canAdd(section.ownerId) ? '此范围不可新增变量' : undefined, action: (trigger: HTMLButtonElement) => showForm({ kind: 'add', id: uid(), ownerId: section.ownerId, ownerLabel: section.owner, name: '', description: '', defaultValue: '' }, trigger) }; }
  function scopeActions(ownerId?: string) {
    const section = sections.find(s => s.ownerId === ownerId); if (!section || !section.parameters.some(pendingValue)) return null;
    const label = section.key === 'global' ? '应用全局参数' : section.key === 'group' ? '应用本组参数' : '应用本步骤参数';
    return <div className="variable-scope-actions"><button type="button" className="text-button" disabled={busy || !onCancelScope} onClick={() => { setValueEditId(null); onCancelScope?.(ownerId); }}>取消本范围修改</button>{section.parameters.some(valueMutable) && <button type="button" className="button small primary" disabled={busy || !onApplyScope} onClick={() => { setValueEditId(null); onApplyScope?.(ownerId); }}>{label}</button>}</div>;
  }
  function renderVariable(parameter: Parameter, level: number) {
    if (!matches(parameter)) return null;
    const pending = pendingValue(parameter), definitionEditable = definitionMutable(parameter);
    const missing = Boolean(instance && referenced.has(parameter.id) && !currentValue(parameter).trim());
    const section = sections.find(s => s.ownerId === parameter.ownerId)!;
    const parentGroup = section.key === 'step' ? document.groups?.find(g => g.id === document.steps.find(s => s.id === parameter.ownerId)?.groupId) : undefined;
    const scopeLabel = section.key === 'global' ? '全局 · 整个流程' : `${section.key === 'group' ? '步骤组' : '步骤'} · ${parentGroup ? (parentGroup.name.trim() || '未命名步骤组') + ' / ' : ''}${section.owner}`;
    const deleteReason = !definitionEditable ? '已推进或结束的参数定义只读' : referenced.has(parameter.id) ? '变量正在被引用，不能删除' : form ? '请先保存或取消当前定义表单' : undefined;
    return <div role="treeitem" aria-level={level} key={parameter.id} className="variable-panel-item variable-tree-leaf" data-variable-kind={parameter.ownerId ? 'local' : 'global'} data-variable-id={parameter.id} data-variable-missing={missing || undefined} data-variable-pending={pending || undefined} data-variable-highlighted={highlighted?.parameterId === parameter.id && highlighted.stepId === activeId} data-definition-readonly={!definitionEditable} data-selected={selectedVariableId === parameter.id} tabIndex={-1} onFocusCapture={() => setFocusedValueId(parameter.id)} onBlurCapture={event => { if (!isVariableEditingSurface(event.relatedTarget) && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) setFocusedValueId(current => current === parameter.id ? null : current); }}>
      <Braces className="variable-leaf-icon" size={12} aria-hidden="true" />
      {instance && valueEditId === parameter.id && valueMutable(parameter) ? <><button type="button" data-variable-name className="variable-tree-name is-label-only" onClick={() => findReferences(parameter)}>{parameter.name}<span className="variable-tree-separator"> - </span></button><input autoFocus className="variable-tree-value" data-variable-value data-parameter-id={parameter.id} aria-label={parameter.name} value={currentValue(parameter)} placeholder="未填写" disabled={busy} onChange={event => onValueChange?.(parameter.id, event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishValueEdit(parameter.id); } }} onBlur={event => { if (!isVariableEditingSurface(event.relatedTarget)) setValueEditId(null); }} /></> : <button type="button" data-variable-name className="variable-tree-name" title={parameter.name + ' - ' + (currentValue(parameter) || '未填写')} aria-label={'选择变量 ' + parameter.name} onClick={() => { setValueEditId(null); findReferences(parameter); }} onDoubleClick={() => { setSelectedVariableId(parameter.id); if (valueMutable(parameter)) setValueEditId(parameter.id); }}><span>{parameter.name}</span><span className="variable-tree-separator"> - </span><span data-variable-value data-parameter-id={parameter.id} data-value-readonly={!valueMutable(parameter)} tabIndex={-1}>{currentValue(parameter) || '未填写'}</span></button>}
      {pending && <span className="variable-pending-dot" role="status" aria-label="未应用" title="未应用" />}
      <VariableMenu label={'变量操作 ' + parameter.name} title={parameter.name} scope={scopeLabel} disabled={busy} items={[
        { label: '查看引用', action: () => findReferences(parameter) },
        ...(valueMutable(parameter) ? [{ label: '修改本次值', action: () => { setSelectedVariableId(parameter.id); setValueEditId(parameter.id); } }] : []),
        { label: '复制变量引用', disabled: copying, action: () => void copyReference(parameter) },
        { label: '编辑定义与默认值', disabled: !definitionEditable || Boolean(form), reason: !definitionEditable ? '参数定义只读' : form ? '先保存或取消当前定义表单' : undefined, action: trigger => showForm({ kind: 'edit', id: parameter.id, ownerId: parameter.ownerId, ownerLabel: section.owner, name: parameter.name, description: parameter.description, defaultValue: parameter.defaultValue }, trigger) },
        { label: '删除变量', disabled: Boolean(deleteReason), reason: deleteReason, danger: true, action: () => deleteParameter(parameter) },
      ]} />
    </div>;
  }
  function renderBranch(branch: VariableBranch, level = 1): React.ReactNode {
    function hasMatch(node: VariableBranch): boolean { return node.parameters.some(matches) || node.children.some(hasMatch); }
    if (!hasMatch(branch)) return null;
    const expanded = !collapsed.has(branch.id), section = sections.find(s => s.ownerId === branch.id)!;
    return <section role="treeitem" aria-level={level} aria-expanded={expanded} key={branch.id} data-variable-scope={branch.kind} data-parameter-scope={branch.id} className="variable-tree-branch"><div className="variable-tree-heading"><button type="button" data-variable-tree-toggle aria-label={(expanded ? '收起 ' : '展开 ') + branch.name} onClick={() => setCollapsed(previous => { const next = new Set(previous); expanded ? next.add(branch.id) : next.delete(branch.id); return next; })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{branch.name}</span></button><VariableMenu label={'作用域操作 ' + branch.name} disabled={busy} items={[addItem(section)]} /></div>{expanded && <div role="group" className="variable-tree-children">{branch.parameters.map(parameter => renderVariable(parameter, level + 1))}{scopeActions(branch.id)}{branch.children.map(child => renderBranch(child, level + 1))}</div>}</section>;
  }
  const live = instance && ['draft', 'in_progress'].includes(instance.status);
  const attentionParameters = live ? document.parameters.filter(parameter => canEditValue?.(parameter) ?? true) : [];
  const effectiveDraftValue = (parameter: Parameter) => draftValues?.[parameter.id] ?? instance?.parameterValues[parameter.id] ?? parameter.defaultValue;
  const missingCount = attentionParameters.filter(parameter => referenced.has(parameter.id) && !effectiveDraftValue(parameter).trim()).length;
  const pendingCount = attentionParameters.filter(parameter => effectiveDraftValue(parameter) !== (instance?.parameterValues[parameter.id] ?? parameter.defaultValue)).length;
  return <>{narrow && <div className="variable-panel-rail" data-variable-panel><button ref={launcher} className="variable-panel-launcher" type="button" aria-label="展开变量面板" aria-controls={panelId} aria-expanded={open} title={`变量：待填 ${missingCount}，未应用 ${pendingCount}`} onClick={() => userOpen(true)}><Braces size={17} /><strong>变量</strong><span className={missingCount ? 'has-attention' : undefined}>待填<b data-panel-missing-count>{missingCount}</b></span><span className={pendingCount ? 'has-attention' : undefined}>未应用<b data-panel-pending-count>{pendingCount}</b></span></button></div>}{narrow && open && <button className="variable-panel-backdrop" type="button" tabIndex={-1} aria-label="关闭变量面板并返回正文" onClick={() => userOpen(false)} />}
    <aside ref={panel} id={panelId} className={`variable-panel ${open ? 'is-open' : 'is-collapsed'}${narrow ? ' is-narrow' : ''}`} data-variable-panel data-variable-target-step-id={step?.id} role={narrow ? 'dialog' : undefined} aria-modal={narrow && open ? true : undefined} aria-label="变量面板">
    <header><Braces size={17} />{open && <><strong>变量</strong><VariableMenu label="新增变量" add disabled={busy} items={sections.filter(s => s.key === 'global' || s.ownerId === step?.id || s.ownerId === group?.id).map(addItem)} /></>}<button className="icon-button" type="button" aria-label={open ? '收起变量面板' : '展开变量面板'} onClick={() => userOpen(!open)}>{open ? <ChevronsRight size={16} /> : <Braces size={17} />}</button></header>
    {open && <><div className="variable-search"><div className="variable-search-field"><Search size={14} /><input type="search" aria-label="搜索变量" placeholder="搜索变量或值" value={query} onChange={event => { setFocusedValueId(null); setValueEditId(null); setQuery(event.target.value); }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); clearSearch(); } }} />{(query || searchState?.parameterId) && <span className="variable-search-count" role="status" data-variable-search-count aria-label={searchStepCount !== undefined ? searchStepCount + ' 个引用步骤' : matchCount + ' 个变量'}>{searchStepCount !== undefined ? searchStepCount + ' 步' : matchCount}</span>}{(query || searchState?.parameterId) && <button type="button" aria-label="清空变量搜索" onMouseDown={event => event.preventDefault()} onClick={clearSearch}><X size={13} /></button>}</div></div><div ref={scroll} className="variable-panel-scroll">

      {form && <form className="variable-definition-form" role="dialog" aria-label={form.kind === 'add' ? '新增变量' : '编辑变量定义'} onSubmit={event => { event.preventDefault(); saveForm(); }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); closeForm(); } }}><strong>{form.kind === 'add' ? '新增变量' : '编辑变量定义'}</strong><p className="variable-form-owner">所属：{form.ownerLabel}</p><label>变量名称<input ref={nameInput} aria-label="变量名称" value={form.name} readOnly={busy || !formAllowed} onChange={event => definitionDraft.update({ ...form, name: event.target.value })} /></label><label>变量说明<textarea aria-label="变量说明" rows={2} value={form.description} readOnly={busy || !formAllowed} onChange={event => definitionDraft.update({ ...form, description: event.target.value })} /></label><label>变量默认值<textarea ref={defaultInput} aria-label="变量默认值" rows={2} value={form.defaultValue} readOnly={busy || !formAllowed} onChange={event => definitionDraft.update({ ...form, defaultValue: event.target.value })} /></label>{(formError || invalidName || !formAllowed) && <p className="variable-form-error" role="status">{formError || invalidName || '原范围现在只读或不存在，表单已保留，请取消后查看。'}</p>}<div className="variable-form-actions"><button type="button" className="button small" disabled={busy} onClick={closeForm}>取消</button><button type="submit" className="button small primary" disabled={busy || !formAllowed || Boolean(invalidName)}>保存变量</button></div></form>}
      <div role="tree" aria-label="工作变量" className="variable-tree" onKeyDown={event => { if (!(event.target instanceof HTMLButtonElement) || !event.target.matches('[data-variable-name],[data-variable-tree-toggle]')) return; if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return; const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-variable-name],[data-variable-tree-toggle]')]; const at = rows.indexOf(event.target), next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))); event.preventDefault(); event.stopPropagation(); rows[next]?.focus(); }}>
        {allowGlobal && <section role="group" aria-label="全局变量" data-variable-scope="global" data-parameter-scope="global"><div className="variable-global-heading">全局</div>{globalParameters(document).map(parameter => renderVariable(parameter, 1))}{scopeActions()}</section>}
        {branches.map(branch => renderBranch(branch))}
      </div>{!matchCount && <p className="variable-panel-empty" role="status">{query ? '没有匹配变量' : '暂无变量'}</p>}
      </div>{footer && <div className="variable-panel-foot" role="status" data-variable-copy-status>{footer}</div>}</>}
  </aside></>;
}
