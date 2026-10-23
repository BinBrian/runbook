import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, Bookmark, ArrowLeft, ArrowRight, BookOpen, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Copy, Download, FolderOpen, Layers, MoreHorizontal, Plus, Search, ShieldCheck, Square, Trash2, Upload, X } from 'lucide-react';
import { api, installCloseGuard, type CloseFailure } from './api';
import { WorkLibrary, type WorkSection } from './WorkLibrary';
import { FavoritesLibrary } from './FavoritesLibrary';
import { FavoriteDialog, type FavoriteRequest } from './FavoriteDialog';
import { mergeSteps, selectableStepIds, selectSteps, selectionReason } from './step-selection';
import { advancedCount, blockEmptyDocument, canEditParameter, canEditParameterDefinition, cloneGroup, cloneStep, convertStepToGroup, defaultValues, displayedStep, emptyDocument, exampleBlocks, exampleDocument, formatTime, globalParameters, groupAsBlock, groupSteps, insertBlock, latestResult, localParameters, missingParameters, outcomeLabels, removeGroup, renderText, statusLabels, uid, visibleParameters } from './model';
import type { ArtifactKind, BlockDefinition, ChecklistDocument, ImportPreview, Instance, Parameter, Step, StepGroup, Workspace } from './types';
import { saveExplicitDrafts, hasExplicitDraft, useBufferedSave, useDraftStatus, useExplicitDraft } from './ui-hooks';
import { draftStore, type DraftEntry, type DraftTarget } from './drafts';
import { DraftMenu } from './DraftMenu';
import { CloseFailureDialog } from './CloseFailureDialog';
import { TemplateSteps, newStep, removeStepFromDocument, type EditDocument } from './DocumentEditor';
import { StepActions, StepMoreActions } from './StepActions';
import { CommandCard } from './CommandCard';
import { PartsView } from './TextField';
import { Timeline, type RunOperation } from './Timeline';
import { WindowControls } from './WindowControls';
import { ThemeSwitcher } from './ThemeSwitcher';
import StepNavigator, { useStepJump } from './StepNavigator';
import { VariableEditingProvider } from './VariableEditing';
import { VariablePanel } from './VariablePanel';
import { useVariableScope } from './useVariableScope';
import { InlineParts, InlinePlain } from './InlineEditable';
import { ArtifactDeletionDialog, deletionTarget, type DeletionTarget } from './ArtifactDeletion';
import { MissingParameters } from './MissingParameters';
import { parameterLabel, variableSteps, referencingSteps } from './variable-search';
import { matchingVariableIds, variableHistory } from './variable-tree';
import { useVariableHighlights } from './useVariableHighlights';
import { CurrentStepActions } from './CurrentStepActions';
import { pendingValues, pendingStepValues, referenceCount } from './interaction-state';
import './checklist.css';
import './workspace-feedback.css';

type Section = WorkSection;
type DraftRequest = { key: string; version: number; stepId?: string };
type Selection = { kind: ArtifactKind; id: string; draftRequest?: DraftRequest } | null;
type Dialog = { type: 'newWork' | 'newBlock' | 'repeatWork' | 'renameFavorite' | 'failed' | 'skipped' | 'terminate'; id?: string; name?: string } | { type: 'saveBlock'; document: ChecklistDocument; groupId: string; name: string } | { type: 'import'; preview: ImportPreview } | { type: 'deleteArtifact'; target: DeletionTarget } | FavoriteRequest;
const sectionLabels = { blocks: '收藏的步骤', current: '工作记录', archive: '归档' };
function message(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function requestArtifactDeletion(kind: ArtifactKind, id: string, run: RunOperation, onDialog: (dialog: Dialog) => void) {
  void run(async () => onDialog({ type: 'deleteArtifact', target: deletionTarget(kind, id) }));
}

export default function ChecklistApp() {
  const [workspace, setWorkspace] = useState<Workspace>({ templates: [], instances: [], blocks: [] });
  const [loaded, setLoaded] = useState(false);
  const [closeReady, setCloseReady] = useState(false);
  const [closeFailure, setCloseFailure] = useState<CloseFailure | null>(null);
  const draftVersion = useRef(0);
  const [section, setSection] = useState<Section>('current');
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [saveStatus, setSaveStatus] = useState(api.getStatus());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [search, setSearch] = useState('');
  const draftStatus = useDraftStatus();
  const notify = useCallback((text: string) => setToast(text), []);
  const fail = useCallback((reason: unknown) => setError(message(reason)), []);
  useEffect(() => {
    const remove = api.subscribe(setWorkspace), removeStatus = api.onStatus(setSaveStatus);
    const removeDraftSave = api.registerCloseSave(saveExplicitDrafts);
    let active = true; let closeGuard: (() => void) | undefined;
    void installCloseGuard(setCloseFailure).then(removeGuard => { if (active) { closeGuard = removeGuard; setCloseReady(true); } else removeGuard(); }).catch(fail);
    void api.load().then(value => { if (active) { setWorkspace(value); setLoaded(true); } }).catch(fail);
    return () => { active = false; remove(); removeStatus(); removeDraftSave(); closeGuard?.(); };
  }, [fail]);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(''), 3000); return () => clearTimeout(timeout); }, [toast]);
  const run: RunOperation = useCallback(async operation => {
    if (busyRef.current) { setError('上一项仍在保存，请稍候重试。'); return false; }
    busyRef.current = true; setBusy(true); setError('');
    try { await api.flush(); await operation(); return true; }
    catch (reason) { fail(reason); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }, [fail]);
  function navigate(next: Selection, nextSection = section) { void run(async () => { setSelection(next); setSection(nextSection); setSearch(''); }); }
  function openDraft(key: string, entry: DraftEntry) {
    void run(async () => {
      let target = entry.target; if (!target) return;
      if (key.startsWith('variable-definition:block:')) {
        const old = api.getWorkspace().blocks?.find(item => item.id === target!.id);
        if (!old) throw new Error('原收藏已不存在，旧输入仍保留在草稿列表');
        const nextId = uid(); await api.apply({ type: 'create_work', id: nextId, name: old.name + ' · 调整', document: old.document });
        target = { ...target, kind: 'instance', id: nextId }; entry = { ...entry, target };
        const nextKey = 'variable-definition:instance:' + nextId; draftStore.update(nextKey, entry); draftStore.update(key); key = nextKey;
      }
      const canonical = target.dialog === 'favorite' ? 'favorite:' + JSON.stringify([target.id, target.stepId, target.groupId]) : key.startsWith('dialog:') && target.dialog ? 'dialog:' + JSON.stringify([target.dialog, target.id, target.stepId, target.groupId]) : key;
      if (canonical !== key) { const previous = draftStore.entries.get(canonical); draftStore.update(key, previous); draftStore.update(canonical, entry); key = canonical; }
      const latest = api.getWorkspace();
      const item = (target.kind === 'template' ? latest.templates : target.kind === 'block' ? latest.blocks ?? [] : latest.instances).find(item => item.id === target.id);
      if (target.id && !item) throw new Error('草稿所属内容已不存在，可以从草稿列表丢弃。');
      const value = entry.value && typeof entry.value === 'object' ? entry.value as Record<string, unknown> : {};
      const parameter = key.startsWith('parameters:') && item?.kind === 'instance' ? item.document.parameters.find(parameter => value[parameter.id] !== undefined && value[parameter.id] !== (item.parameterValues[parameter.id] ?? parameter.defaultValue)) : undefined;
      const owner = typeof value.ownerId === 'string' ? value.ownerId : parameter?.ownerId;
      const stepId = owner ? item?.document.steps.find(step => step.id === owner || step.groupId === owner)?.id : target.stepId;
      setSelection(item ? { kind: target.kind, id: target.id, draftRequest: { key, version: ++draftVersion.current, stepId } } : null);
      setSection(target.kind === 'block' ? 'blocks' : item?.kind === 'instance' && item.archivedAt ? 'archive' : 'current');
      setSearch('');
      if (target.dialog === 'favorite' && item) setDialog({ type: 'favorite', id: item.id, stepId: target.stepId, groupId: target.groupId, name: (entry.value as { name: string }).name });
      else if (target.dialog === 'saveBlock' && item && target.groupId) setDialog({ type: 'saveBlock', document: item.document, groupId: target.groupId, name: item.document.groups?.find(group => group.id === target.groupId)?.name ?? '' });
      else if (['newWork', 'repeatWork', 'renameFavorite', 'failed', 'skipped', 'terminate'].includes(target.dialog ?? '')) {
        if ((target.dialog === 'failed' || target.dialog === 'skipped') && (item?.kind !== 'instance' || item.currentStepId !== target.stepId)) throw new Error('此步骤已推进，旧原因草稿不能作为当前结果；可以从草稿列表丢弃。');
        setDialog({ name: item?.name, type: target.dialog as 'newWork' | 'newBlock' | 'repeatWork' | 'renameFavorite' | 'failed' | 'skipped' | 'terminate', id: target.id || undefined });
      }
    });
  }
  function navigateImported(next: Selection) { setSelection(next); if (!next) return; setSection(next.kind === 'block' ? 'blocks' : api.getWorkspace().instances.find(item => item.id === next.id)?.archivedAt ? 'archive' : 'current'); }
  async function copy(text: string) { await run(async () => { await api.copy(text); notify('命令已复制'); }); }
  async function importFile() { await run(async () => { const file = await api.pickImport(); if (file) setDialog({ type: 'import', preview: await api.previewImport(file.name, file.bytes) }); }); }
  async function exportItem(kind: ArtifactKind, id: string) { await run(async () => { const file = await api.exportData(kind, id); if (await api.saveExport(file.name, file.bytes)) notify(kind === 'template' ? '模板已导出' : kind === 'block' ? '收藏已导出' : '完整存档已导出'); }); }
  async function addExample() { await run(async () => { const id = uid(); await api.apply({ type: 'create_work', id, name: '示例补丁维护', document: exampleDocument() }); setSelection({ kind: 'instance', id }); setSection('current'); }); }
  async function addExampleBlocks() { await run(async () => { for (const item of exampleBlocks()) if (!api.getWorkspace().blocks?.some(block => block.id === item.id)) await api.apply({ type: 'create_block', id: item.id, name: item.name, document: item.document }); notify('示例步骤块已准备好'); }); }
  const block = selection?.kind === 'block' ? workspace.blocks?.find(item => item.id === selection.id) : undefined;
  const instance = selection?.kind === 'instance' ? workspace.instances.find(item => item.id === selection.id) : undefined;
  const counts = { blocks: workspace.blocks?.length ?? 0, current: workspace.instances.filter(item => !item.archivedAt).length, archive: workspace.instances.filter(item => item.archivedAt).length };
  return <div className="checklist-app">
    <aside className="app-sidebar"><div className="sidebar-window-grip" data-tauri-drag-region="deep" aria-hidden="true" /><button className="app-brand" onClick={() => navigate(null, 'current')}><span className="brand-icon"><ClipboardList size={23} /></span><span>Runbook<small>一步一步，留下记录。</small></span></button><div className="workspace-label"><span className="online-dot" />本地工作空间</div><nav>{(['current', 'blocks', 'archive'] as Section[]).map(value => { const Icon = value === 'current' ? ClipboardList : value === 'blocks' ? Bookmark : Archive; return <button key={value} className={section === value ? 'selected' : ''} onClick={() => navigate(null, value)}><Icon size={18} /><span>{sectionLabels[value]}</span><small>{counts[value]}</small></button>; })}</nav><div className="sidebar-foot"><ShieldCheck size={15} /><span>内容只保存在本机</span><p>记录与复制命令<br />每一步由你确认</p></div></aside>
    <VariableEditingProvider key={selection ? selection.kind + ':' + selection.id : 'library'}><main className="app-main">
      <header className="app-topbar" data-window-titlebar data-tauri-drag-region="deep"><div className="breadcrumb"><span>{sectionLabels[section]}</span>{selection && <><ChevronRight size={14} /><strong>{block?.name ?? instance?.name}</strong></>}</div><div className="topbar-right" data-tauri-drag-region="false"><ThemeSwitcher /><span title={draftStatus.error || undefined} className={'save-state ' + (draftStatus.error ? 'error' : saveStatus)}><span />{draftStatus.error ? '草稿未保存' : saveStatus === 'saving' ? '正在保存…' : saveStatus === 'error' ? '保存未完成' : draftStatus.buffered ? '等待保存…' : draftStatus.explicit ? '草稿已保留' : '已保存在本机'}</span><DraftMenu entries={draftStatus.entries} workspace={workspace} busy={busy} onOpen={openDraft} onDiscard={key => draftStore.update(key)} /><button className="button small" disabled={busy} onClick={() => void importFile()}><Upload size={14} />导入</button></div><WindowControls closeReady={closeReady} onError={fail} /></header>
      {error && <div className="error-strip" role="alert"><span>{error}</span><button className="button small" disabled={busy} onClick={() => void run(async () => { await api.flush(); if (!loaded) { await api.load(); setLoaded(true); } })}>重试</button><button className="icon-button" title="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
      {!loaded ? <div className="startup-page"><span className="brand-icon"><ClipboardList size={30} /></span><h1>Runbook</h1><p>{error ? '本地工作空间暂时无法打开，请重试。' : '正在打开本地工作空间…'}</p></div>
        : section === 'blocks' ? <FavoritesLibrary workspace={workspace} selectedId={block?.id} search={search} onSearch={setSearch} onSelect={id => { void run(async () => setSelection(id ? { kind: 'block', id } : null)); }} onSource={item => { const source = workspace.instances.find(work => work.id === item.favorite?.sourceWorkId); if (source) { const stepId = source.document.steps.find(step => item.favorite?.sourceStepIds.includes(step.id))?.id; navigate({ kind: 'instance', id: source.id, draftRequest: { key: 'favorite-source', version: ++draftVersion.current, stepId } }, source.archivedAt ? 'archive' : 'current'); } }} onRename={item => setDialog({ type: 'renameFavorite', id: item.id, name: item.name })} onRemove={item => requestArtifactDeletion('block', item.id, run, setDialog)} onExport={item => void exportItem('block', item.id)} busy={busy} />
        : instance ? <InstanceWorkspace key={'instance:' + instance.id} instance={instance} draftRequest={selection?.draftRequest} blocks={workspace.blocks ?? []} fail={fail} run={run} busy={busy} copy={text => void copy(text)} onBack={() => navigate(null, instance.archivedAt ? 'archive' : 'current')} onExport={() => void exportItem('instance', instance.id)} onDialog={setDialog} notify={notify} />
        : <WorkLibrary section={section} workspace={workspace} search={search} onSearch={setSearch} busy={busy} onNew={() => setDialog({ type: 'newWork' })} onExample={() => void addExample()} onExampleBlocks={() => void addExampleBlocks()} onOpenWork={id => navigate({ kind: 'instance', id })} onOpenBlock={id => navigate({ kind: 'block', id }, 'blocks')} />}
    </main></VariableEditingProvider>
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
    {dialog && (dialog.type === 'favorite' ? <FavoriteDialog key={'favorite:' + dialog.id + ':' + (dialog.stepId ?? dialog.groupId)} request={dialog} error={error} favorites={workspace.blocks ?? []} run={run} busy={busy} onClose={() => setDialog(null)} notify={notify} /> : dialog.type === 'deleteArtifact' ? <ArtifactDeletionDialog key={'delete:' + dialog.target.kind + ':' + dialog.target.id} target={dialog.target} run={run} busy={busy} error={error} onClose={() => setDialog(null)} onDeleted={() => navigateImported(null)} notify={notify} /> : <ActionDialog key={dialog.type + (dialog.type === 'import' ? dialog.preview.token : 'id' in dialog ? dialog.id ?? '' : '')} dialog={dialog} source={selection} run={run} busy={busy} onClose={() => setDialog(null)} onNavigate={navigateImported} notify={notify} />)}
    {closeFailure && <CloseFailureDialog key={closeFailure.message} failure={closeFailure} onCancel={() => setCloseFailure(null)} />}
  </div>;
}

function moveWholeGroup(document: ChecklistDocument, groupId: string, direction: number): ChecklistDocument {
  const members = groupSteps(document, groupId), first = document.steps.findIndex(step => step.groupId === groupId);
  const rest = document.steps.filter(step => step.groupId !== groupId);
  let at = first;
  if (direction < 0) { const previous = document.steps[first - 1]; at = previous?.groupId ? document.steps.findIndex(step => step.groupId === previous.groupId) : first - 1; }
  else { const next = rest[first]; at = first + (next?.groupId ? groupSteps(document, next.groupId).length : 1); }
  return { ...document, steps: [...rest.slice(0, at), ...members, ...rest.slice(at)] };
}

function InstanceWorkspace({ instance, draftRequest, blocks, fail, run, busy, copy, onBack, onExport, onDialog, notify }: { instance: Instance; draftRequest?: DraftRequest; blocks: BlockDefinition[]; fail: (reason: unknown) => void; run: RunOperation; busy: boolean; copy: (text: string) => void; onBack: () => void; onExport: () => void; onDialog: (dialog: Dialog) => void; notify: (text: string) => void }) {
  const buffer = useBufferedSave({ name: instance.name, document: instance.document }, value => api.apply({ type: 'save_instance', id: instance.id, ...value }), fail);
  const edit: EditDocument = update => buffer.update({ ...buffer.current.current, document: update(buffer.current.current.document) });
  const document = buffer.value.document;
  const scope = useVariableScope(document, instance.currentStepId ?? undefined);
  const active = instance.status === 'draft' || instance.status === 'in_progress';
  const currentIndex = instance.status === 'draft' ? -1 : document.steps.findIndex(step => step.id === instance.currentStepId);
  const initialStep = instance.currentStepId ?? document.steps[0]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(new Set([initialStep]));
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(document.steps.filter(step => step.id === initialStep && step.groupId).map(step => step.groupId!)));
  const [commandActivation, setCommandActivation] = useState<{ stepId: string; commandId: string; version: number } | null>(null);
  const commandVersion = useRef(0);
  const [titleActivation, setTitleActivation] = useState<{ id: string; version: number } | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<Set<string>>(new Set());
  const selectionAnchor = useRef<string | undefined>(undefined);
  const [groupActivation, setGroupActivation] = useState<{ id: string; version: number } | null>(null);
  const eligibleSteps = selectableStepIds(instance, document);
  const mergeReason = selectionReason(document, selectedSteps, eligibleSteps);
  const eligibleSignature = JSON.stringify([...eligibleSteps]);
  useEffect(() => { setSelectedSteps(previous => [...previous].some(id => !eligibleSteps.has(id)) ? new Set() : previous); }, [eligibleSignature]);
  function cancelSelection() { setSelectedSteps(new Set()); selectionAnchor.current = undefined; }
  function selectStep(id: string, range: boolean) {
    try { setSelectedSteps(selectSteps(document, selectedSteps, eligibleSteps, id, selectionAnchor.current, range)); if (!range) selectionAnchor.current = id; }
    catch (reason) { fail(reason); }
  }
  function mergeSelected() { void run(async () => {
    const saved = api.getWorkspace().instances.find(item => item.id === instance.id)!;
    const next = mergeSteps(saved.document, selectedSteps, selectableStepIds(saved));
    const group = next.groups!.find(item => !saved.document.groups?.some(old => old.id === item.id))!;
    buffer.update({ ...buffer.current.current, document: next });
    cancelSelection(); searchOrigin.current = null; restoreReading.current = null; setStepSearch({ query: '' });
    setOpenGroups(previous => new Set(previous).add(group.id));
    setExpanded(previous => new Set([...previous, ...selectedSteps]));
    const first = next.steps.find(step => step.groupId === group.id)!; scope.locate(first.id); jumpToStep(first.id);
    setGroupActivation({ id: group.id, version: Date.now() });
  }); }
  const scrollRef = useRef<HTMLDivElement>(null);
  const jumpToStep = useStepJump(scrollRef);
  const locateVersion = useRef(0);
  const [parameterFocus, setParameterFocus] = useState<{ id: string; version: number }>();
  const draft = useExplicitDraft(`parameters:${instance.id}`, instance.parameterValues, '工作参数', { kind: 'instance', id: instance.id });
  const values = Object.fromEntries(document.parameters.map(parameter => [parameter.id, draft.value[parameter.id] ?? instance.parameterValues[parameter.id] ?? parameter.defaultValue]));
  const [stepSearch, setStepSearch] = useState<{ query: string; parameterId?: string; keepTree?: boolean; replay?: number }>({ query: '' });
  const searchedParameter = document.parameters.find(parameter => parameter.id === stepSearch.parameterId);
  const searchedLabel = searchedParameter ? parameterLabel(document, searchedParameter, values) : undefined;
  useEffect(() => {
    if (!stepSearch.parameterId || searchedLabel === undefined) return;
    setStepSearch(previous => previous.parameterId === stepSearch.parameterId && previous.query !== searchedLabel ? { ...previous, query: searchedLabel } : previous);
  }, [stepSearch.parameterId, searchedLabel]);
  const highlightVersion = useRef(0);
  const filtering = Boolean(stepSearch.query.trim() || stepSearch.parameterId);
  type ReadingPosition = { top: number; viewing?: string; expanded: Set<string>; groups: Set<string>; anchor?: string; offset: number };
  const searchOrigin = useRef<ReadingPosition | null>(null);
  const restoreReading = useRef<ReadingPosition | null>(null);
  function rememberReading() {
    const root = scrollRef.current;
    if (!root || searchOrigin.current) return;
    const bounds = root.getBoundingClientRect();
    const anchor = [...root.querySelectorAll<HTMLElement>('[data-step-id]')].find(node => { const rect = node.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; });
    searchOrigin.current = { top: root.scrollTop, viewing: scope.viewing, expanded: new Set(expanded), groups: new Set(openGroups), anchor: anchor?.dataset.stepId, offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0 };
  }
  useLayoutEffect(() => {
    const origin = restoreReading.current, root = scrollRef.current;
    if (filtering || !origin || !root) return;
    restoreReading.current = null;
    const anchor = [...root.querySelectorAll<HTMLElement>('[data-step-id]')].find(node => node.dataset.stepId === origin.anchor);
    root.scrollTo({ top: anchor ? root.scrollTop + anchor.getBoundingClientRect().top - root.getBoundingClientRect().top - origin.offset : origin.top, behavior: 'instant' });
  }, [filtering]);
  const searchValues = Object.fromEntries(document.parameters.map(p => { const old = variableHistory({ ...instance, document }, p, scope.viewing); return [p.id, old ? old.snapshot.parameterValues[p.id] ?? '' : values[p.id]]; }));
  const matchedVariables = filtering ? matchingVariableIds(document, stepSearch.query, searchValues, stepSearch.parameterId) : new Set<string>();
  useVariableHighlights(scrollRef, matchedVariables, stepSearch.replay ?? 0);
  const matchingSteps = filtering ? referencingSteps(document, matchedVariables) : document.steps;
  const matchingIds = new Set(matchingSteps.map(step => step.id));
  const matchSignature = JSON.stringify(filtering ? matchingSteps.map(step => [step.id, step.groupId]) : []);
  useEffect(() => {
    if (!filtering) return;
    setExpanded(previous => new Set([...previous, ...matchingSteps.map(step => step.id)]));
    setOpenGroups(previous => new Set([...previous, ...matchingSteps.flatMap(step => step.groupId ? [step.groupId] : [])]));
  }, [matchSignature, filtering]);
  const missing = missingParameters(document, values);
  const savedMissing = missingParameters(document, instance.parameterValues);
  const unappliedCount = document.parameters.filter(parameter => values[parameter.id] !== (instance.parameterValues[parameter.id] ?? parameter.defaultValue)).length;
  const parameterIds = JSON.stringify(document.parameters.map(parameter => parameter.id));
  useEffect(() => {
    const live = new Set(document.parameters.map(parameter => parameter.id));
    if (!Object.keys(draft.value).some(id => !live.has(id))) return;
    const retained = Object.fromEntries(document.parameters.map(parameter => [parameter.id, draft.value[parameter.id] ?? instance.parameterValues[parameter.id] ?? parameter.defaultValue]));
    if (document.parameters.some(parameter => retained[parameter.id] !== (instance.parameterValues[parameter.id] ?? parameter.defaultValue))) draft.update(retained);
    else draft.reset(retained);
  }, [parameterIds, instance.parameterValues]);
  const valueEditable = (parameter: Parameter) => canEditParameter({ ...instance, document }, parameter);
  const definitionEditable = (parameter: Parameter) => canEditParameterDefinition({ ...instance, document }, parameter);
  const previousCurrent = useRef(instance.currentStepId);
  useLayoutEffect(() => {
    const current = instance.currentStepId, advancing = Boolean(previousCurrent.current && previousCurrent.current !== current);
    previousCurrent.current = current;
    searchOrigin.current = null; restoreReading.current = null;
    if (!current) { jumpToStep(); return; }
    const groupId = document.steps.find(step => step.id === current)?.groupId;
    // Capture the next card/group before collapsing; preserve that anchor until
    // layout settles, then smoothly align the newly expanded step.
    jumpToStep(current, undefined, { behavior: advancing ? 'smooth' : 'instant', settle: advancing, groupId });
    setStepSearch({ query: '' }); scope.locate(current); setExpanded(new Set([current]));
    setCommandActivation(null); setOpenGroups(new Set(groupId ? [groupId] : []));
  }, [instance.currentStepId]);
  function commandActivated(commandId: string) {
    if (commandActivation?.commandId !== commandId) return;
    setCommandActivation(previous => previous?.commandId === commandId ? null : previous);
  }
  function toggle(id: string) { setExpanded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function toggleGroup(id: string) { setOpenGroups(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function move(stepId: string, direction: number) { edit(doc => { const steps = [...doc.steps], index = steps.findIndex(step => step.id === stepId), target = index + direction; if (index < 0 || !steps[target] || steps[index].groupId !== steps[target].groupId) return doc; [steps[index], steps[target]] = [steps[target], steps[index]]; return { ...doc, steps }; }); }
  function addAfter(index: number, groupId?: string) { const step = newStep(groupId); edit(doc => ({ ...doc, steps: [...doc.steps.slice(0, index + 1), step, ...doc.steps.slice(index + 1)] })); setExpanded(previous => new Set(previous).add(step.id)); if (groupId) setOpenGroups(previous => new Set(previous).add(groupId)); scope.locate(step.id); setTitleActivation({ id: step.id, version: ++commandVersion.current }); jumpToStep(step.id); }
  function removeStep(stepId: string) { if (instance.entries.some(entry => entry.stepId === stepId) || hasExplicitDraft(`comment:${instance.id}:${stepId}`)) { fail('请先删除此步骤下的评论和图片，或清空未提交的评论，再删除步骤。'); return; } edit(doc => removeStepFromDocument(doc, stepId)); }
  function duplicateStep(stepId: string) { edit(doc => { const next = cloneStep(doc, stepId); const copy = next.steps.find(step => !doc.steps.some(old => old.id === step.id))!; setExpanded(previous => new Set(previous).add(copy.id)); return next; }); }
  function addCommand(stepId: string) {
    const step = buffer.current.current.document.steps.find(item => item.id === stepId);
    if (!step) return;
    const commandId = uid();
    edit(doc => ({ ...doc, steps: doc.steps.map(item => item.id === stepId ? { ...item, commands: [...item.commands, { id: commandId, text: [''] }] } : item) }));
    setExpanded(previous => new Set(previous).add(stepId));
    if (step.groupId) setOpenGroups(previous => new Set(previous).add(step.groupId!));
    scope.locate(stepId);
    setCommandActivation({ stepId, commandId, version: ++commandVersion.current });
  }
  function moveCommand(stepId: string, commandId: string, direction: -1 | 1) {
    edit(doc => ({ ...doc, steps: doc.steps.map(step => {
      if (step.id !== stepId) return step;
      const index = step.commands.findIndex(command => command.id === commandId), target = index + direction;
      if (index < 0 || target < 0 || target >= step.commands.length) return step;
      const commands = [...step.commands]; [commands[index], commands[target]] = [commands[target], commands[index]];
      return { ...step, commands };
    }) }));
  }
  function removeCommand(stepId: string, commandId: string) { edit(doc => ({ ...doc, steps: doc.steps.map(step => step.id === stepId ? { ...step, commands: step.commands.filter(command => command.id !== commandId) } : step) })); }
  function duplicateGroup(groupId: string) { edit(doc => { const next = cloneGroup(doc, groupId); const copy = next.groups!.find(group => !doc.groups?.some(old => old.id === group.id))!; setOpenGroups(previous => new Set(previous).add(copy.id)); return next; }); }
  function insertAt(block: BlockDefinition, index: number) { edit(doc => { const next = insertBlock(doc, block, index); const group = next.groups?.find(group => !doc.groups?.some(item => item.id === group.id)); if (group) setOpenGroups(previous => new Set(previous).add(group.id)); const first = next.steps.find(step => !doc.steps.some(old => old.id === step.id)); if (first) { setExpanded(previous => new Set(previous).add(first.id)); scope.locate(first.id); } return next; }); }
  function convertStep(stepId: string) { edit(doc => { const next = convertStepToGroup(doc, stepId); const groupId = next.steps.find(step => step.id === stepId)!.groupId!; setOpenGroups(previous => new Set(previous).add(groupId)); return next; }); }
  function deleteGroup(groupId: string) { const members = new Set(groupSteps(document, groupId).map(step => step.id)); if (instance.entries.some(entry => members.has(entry.stepId)) || [...members].some(id => hasExplicitDraft(`comment:${instance.id}:${id}`))) { fail('请先处理此步骤组内的评论、图片和未提交输入，再删除步骤组。'); return; } edit(doc => removeGroup(doc, groupId)); }
  function favoriteStep(stepId?: string, groupId?: string) { void run(async () => {
    const saved = api.getWorkspace().instances.find(work => work.id === instance.id)!;
    const step = saved.document.steps.find(step => step.id === stepId);
    const name = groupId ? saved.document.groups?.find(group => group.id === groupId)?.name : step ? renderText(step.title, defaultValues(saved.document.parameters)) : '';
    onDialog({ type: 'favorite', id: instance.id, stepId, groupId, name: name?.trim() || (groupId ? '收藏的步骤组' : '收藏的步骤') });
  }); }
  function locate(parameterId: string, editValue = true) {
    const parameter = document.parameters.find(item => item.id === parameterId);
    if (!parameter) return;
    const matches = variableSteps(document, '', values, parameterId);
    const stepId = preferredSearchStep(matches);
    rememberReading();
    setStepSearch({ query: parameterLabel(document, parameter, values), parameterId, keepTree: !editValue, replay: ++highlightVersion.current });
    if (stepId) navigateStep(stepId, true, !editValue, parameterId);
    else jumpToStep();
    if (editValue) setParameterFocus({ id: parameterId, version: ++locateVersion.current });
  }
  function preferredSearchStep(matches: Step[]) { return document.steps.find((step, index) => index >= Math.max(0, currentIndex) && matches.some(match => match.id === step.id))?.id ?? matches[0]?.id; }
  function searchSteps(query: string) {
    if (!query.trim()) { clearStepSearch(); return; }
    jumpToStep();
    rememberReading();
    setStepSearch({ query });
    if (query.trim()) requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
  }
  function clearStepSearch() {
    jumpToStep();
    const origin = searchOrigin.current; searchOrigin.current = null;
    if (origin) { restoreReading.current = origin; setExpanded(origin.expanded); setOpenGroups(origin.groups); if (origin.viewing) scope.locate(origin.viewing); }
    setStepSearch({ query: '' });
  }
  function navigateStep(stepId: string, keepSearch = false, keepVariableContext = false, parameterId?: string) {
    if (!keepSearch) { searchOrigin.current = null; restoreReading.current = null; setStepSearch({ query: '' }); }
    if (!keepVariableContext) scope.locate(stepId);
    const step = document.steps.find(item => item.id === stepId);
    if (!step) return;
    locateVersion.current += 1;
    setParameterFocus(undefined);
    setExpanded(previous => new Set(previous).add(stepId));
    if (step.groupId) setOpenGroups(previous => new Set(previous).add(step.groupId!));
    jumpToStep(stepId, parameterId);
  }
  useEffect(() => {
    if (!draftRequest) return;
    const stepId = draftRequest.stepId ?? initialStep;
    if (stepId) navigateStep(stepId);
    if (stepId && draftRequest.key === 'new-work-title') setTitleActivation({ id: stepId, version: ++commandVersion.current });
    if (draftRequest.key.startsWith('parameters:')) {
      const parameter = document.parameters.find(p => draft.value[p.id] !== undefined && draft.value[p.id] !== (instance.parameterValues[p.id] ?? p.defaultValue));
      if (parameter) setParameterFocus({ id: parameter.id, version: ++locateVersion.current });
    }
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      const card = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-step-id]') ?? [])].find(node => node.dataset.stepId === stepId);
      if (draftRequest.key.startsWith('comment:')) { const details = card?.querySelector<HTMLDetailsElement>('.comment-details'); if (details) { details.open = true; details.querySelector('textarea')?.focus({ preventScroll: true }); } }
      else if (draftRequest.key.startsWith('edit-comment:')) card?.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑评论"]')?.focus({ preventScroll: true });
    }); });
    return () => cancelAnimationFrame(frame);
  }, [draftRequest?.version]);
  function scopeParameters(ownerId?: string) { return ownerId ? localParameters(document, ownerId) : globalParameters(document); }
  function cancelScope(ownerId?: string) { const next = { ...values }; for (const parameter of scopeParameters(ownerId)) next[parameter.id] = instance.parameterValues[parameter.id] ?? parameter.defaultValue; if (document.parameters.some(parameter => next[parameter.id] !== (instance.parameterValues[parameter.id] ?? parameter.defaultValue))) draft.update(next); else draft.reset(next); }
  async function applyScope(ownerId?: string, start = false, all = false) {
    await run(async () => {
      const savedBefore = api.getWorkspace().instances.find(item => item.id === instance.id)!;
      const selected = new Set((start || all ? document.parameters : scopeParameters(ownerId)).filter(valueEditable).map(parameter => parameter.id));
      const applied = Object.fromEntries(document.parameters.map(parameter => [parameter.id, selected.has(parameter.id) ? values[parameter.id] : savedBefore.parameterValues[parameter.id] ?? parameter.defaultValue]));
      await api.apply({ type: 'apply_parameters', id: instance.id, values: applied });
      if (start) await api.apply({ type: 'start_instance', id: instance.id });
      const saved = api.getWorkspace().instances.find(item => item.id === instance.id)!.parameterValues;
      const remaining = Object.fromEntries(document.parameters.map(parameter => [parameter.id, selected.has(parameter.id) ? saved[parameter.id] : values[parameter.id]]));
      if (document.parameters.some(parameter => remaining[parameter.id] !== saved[parameter.id])) draft.update(remaining); else draft.reset(saved);
    });
  }
  function assertParametersApplied(stepId: string) { if (pendingStepValues(document, stepId, instance.parameterValues, values).length) throw new Error('当前步骤引用的参数有未应用修改，请先查看并应用或取消修改，再提交结果。'); }
  function inspectPending(parameterId: string, stepId: string) { scope.locate(stepId); setParameterFocus({ id: parameterId, version: ++locateVersion.current }); }
  function recordStep(stepId: string, last: boolean) { void run(async () => { assertParametersApplied(stepId); await api.apply({ type: 'record_result', id: instance.id, outcome: 'completed', reason: null }); if (last) notify('本次工作已结束'); }); }
  function reasonDialog(stepId: string, type: 'failed' | 'skipped') { void run(async () => { assertParametersApplied(stepId); onDialog({ type, id: instance.id }); }); }
  function copyCommand(stepId: string, commandId: string) { void run(async () => { const saved = api.getWorkspace().instances.find(value => value.id === instance.id)!; const step = saved.document.steps.find(value => value.id === stepId)!; const command = step.commands.find(value => value.id === commandId)!; const result = latestResult(saved, stepId); let text: string; if (result && result.outcome !== 'failed') text = result.snapshot.commands.find(value => value.id === commandId)?.text ?? ''; else { if (command.text.some(part => typeof part !== 'string' && !saved.parameterValues[part.parameterId]?.trim())) throw new Error('请先填写并应用此命令使用的变量。'); text = renderText(command.text, saved.parameterValues); } await api.copy(text); notify(!(result && result.outcome !== 'failed') && pendingValues(saved.document, [command.text], saved.parameterValues, values).length ? '命令已复制，使用当前生效值' : '命令已复制'); }); }
  const renderStep = (step: Step, index: number) => {
    const result = latestResult(instance, step.id), isCurrent = instance.status === 'in_progress' && step.id === instance.currentStepId, isExpanded = expanded.has(step.id), frozen = Boolean(result && result.outcome !== 'failed');
    const editable = active && !frozen && (instance.status === 'draft' || index >= currentIndex), future = instance.status === 'draft' || (instance.status === 'in_progress' && index > currentIndex), shown = displayedStep({ ...instance, document }, step);
    const showDescription = editable || (frozen ? Boolean(shown.description.trim()) : step.description.some(part => typeof part !== 'string' || Boolean(part.trim())));
    const fields = { parameters: visibleParameters(document, step.id), ownerId: step.id, groupId: step.groupId, onCreate: (parameter: Parameter) => edit(doc => ({ ...doc, parameters: [...doc.parameters, parameter] })) };
    const change = (patch: Partial<Step>) => edit(doc => ({ ...doc, steps: doc.steps.map(item => item.id === step.id ? { ...item, ...patch } : item) }));
    const materialBlocked = instance.entries.some(entry => entry.stepId === step.id) || hasExplicitDraft(`comment:${instance.id}:${step.id}`);
    const removeReason = !future ? '当前步骤不能删除' : document.steps.length <= 1 ? '流程至少保留一个步骤' : materialBlocked ? '请先处理本步骤的评论、图片或未提交输入' : undefined;
    return <div key={step.id} data-step-id={step.id} className={`step-card execution ${isCurrent ? 'is-current' : ''} ${isExpanded ? 'is-expanded' : ''} ${selectedSteps.has(step.id) ? 'is-selected' : ''}`} onDoubleClickCapture={event => {
      if (!editable || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
      if (event.target.closest('.inline-editable.is-title.is-display') && !event.target.closest('[data-parameter-id]')) setExpanded(previous => new Set(previous).add(step.id));
    }}>
      {editable && <StepActions blocks={blocks} disabled={busy} onAddCommand={() => addCommand(step.id)} onAdd={() => addAfter(index, step.groupId)} onInsert={block => insertAt(block, index)} />}
      <div className="step-card-heading" aria-expanded={isExpanded}>
        <button className="step-expand-toggle step-select-toggle" type="button" role={eligibleSteps.has(step.id) ? "checkbox" : undefined} aria-checked={eligibleSteps.has(step.id) ? selectedSteps.has(step.id) : undefined} title={eligibleSteps.has(step.id) ? "选择步骤，Shift 可连续选择" : undefined} aria-label={eligibleSteps.has(step.id) ? `选择步骤 ${index + 1}` : `步骤 ${index + 1} 状态`} disabled={!eligibleSteps.has(step.id)} onClick={event => selectStep(step.id, event.shiftKey)}><span className={`step-status-icon ${result?.outcome ?? ''}`}>{selectedSteps.has(step.id) ? <Check size={16} /> : result?.outcome === 'completed' ? <Check size={16} /> : result?.outcome === 'skipped' ? <ArrowRight size={16} /> : result?.outcome === 'failed' ? <X size={15} /> : <span>{index + 1}</span>}</span></button>
        <div className="step-heading-main"><div className="step-heading-text"><InlineParts {...fields} label="步骤标题" value={step.title} snapshot={frozen ? { text: shown.title, parameterValues: shown.parameterValues } : undefined} displayValues={instance.parameterValues} readOnly={!editable} onChange={title => change({ title })} placeholder="未命名步骤" singleLine activationKey={titleActivation?.id === step.id ? titleActivation.version : undefined} onActivated={() => { setExpanded(previous => new Set(previous).add(step.id)); setTitleActivation(previous => previous?.id === step.id ? null : previous); }} />{isCurrent && <span className="current-step-badge">当前步骤</span>}</div>{result?.reason && <p className="step-result-reason" title={result.reason}>{result.reason}</p>}</div><div className="step-result-summary"><span className={`step-status-label ${result?.outcome ?? ''}`}>{result ? outcomeLabels[result.outcome] : instance.status === 'terminated' ? '未执行' : instance.status === 'draft' ? '' : '待处理'}</span>{result && <time dateTime={result.at}>{formatTime(result.at)}</time>}</div><button className="step-expand-toggle icon-button" type="button" aria-label={`${isExpanded ? '收起' : '展开'}步骤 ${index + 1}`} aria-expanded={isExpanded} onClick={() => toggle(step.id)}>{isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
        {<StepMoreActions disabled={busy} onFavorite={() => favoriteStep(step.id)} readOnly={!editable} onDuplicate={() => duplicateStep(step.id)} onMoveUp={future && index > (instance.status === 'draft' ? 0 : currentIndex + 1) && document.steps[index - 1].groupId === step.groupId ? () => move(step.id, -1) : undefined} onMoveDown={future && index < document.steps.length - 1 && document.steps[index + 1].groupId === step.groupId ? () => move(step.id, 1) : undefined} moveUpDisabledReason={!future ? '当前步骤不能移动' : undefined} moveDownDisabledReason={!future ? '当前步骤不能移动' : undefined} onConvert={future && !step.groupId ? () => convertStep(step.id) : undefined} convertDisabledReason={!future ? '当前步骤不能改变所属组' : step.groupId ? '此步骤已经属于步骤组' : undefined} onRemove={!removeReason ? () => removeStep(step.id) : undefined} removeDisabledReason={removeReason} />}
      </div>
      {isExpanded && <div className="step-content">{showDescription && <InlineParts {...fields} className="step-description" label="操作说明" value={step.description} snapshot={frozen ? { text: shown.description, parameterValues: shown.parameterValues } : undefined} displayValues={instance.parameterValues} readOnly={!editable} onChange={description => change({ description })} placeholder="添加描述" />}
        {shown.commands.length === 0 ? <div className="manual-check"><CheckCircle2 size={15} />人工检查点</div> : <div className="command-list">{step.commands.map((command, commandIndex) => <CommandCard {...fields} commandId={command.id} index={commandIndex} key={command.id} busy={busy} value={command.text} snapshot={frozen ? { text: shown.commands.find(value => value.id === command.id)?.text ?? '', parameterValues: shown.parameterValues } : undefined} displayValues={instance.parameterValues} readOnly={!editable} onChange={text => edit(doc => ({ ...doc, steps: doc.steps.map(item => item.id === step.id ? { ...item, commands: item.commands.map(value => value.id === command.id ? { ...value, text } : value) } : item) }))} placeholder="填写供复制的命令" onCopy={() => copyCommand(step.id, command.id)} pendingValues={active && !frozen ? pendingValues(document, [command.text], instance.parameterValues, values) : []} onInspectPending={id => inspectPending(id, step.id)} onMoveUp={commandIndex > 0 ? () => moveCommand(step.id, command.id, -1) : undefined} onMoveDown={commandIndex < step.commands.length - 1 ? () => moveCommand(step.id, command.id, 1) : undefined} onRemove={() => removeCommand(step.id, command.id)} activationKey={commandActivation?.commandId === command.id ? commandActivation.version : undefined} onActivated={() => commandActivated(command.id)} />)}</div>}
        {/* Keep inline editors at their current height until the result click has fired. */}
        {isCurrent && <div className="result-actions" data-step-result-actions={step.id}><button className="button primary" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => recordStep(step.id, index === document.steps.length - 1)}><Check size={16} />{index === document.steps.length - 1 ? '完成并结束' : '完成并下一步'}</button><button className="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => reasonDialog(step.id, 'failed')}>记录失败</button><button className="text-button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => reasonDialog(step.id, 'skipped')}>跳过<ArrowRight size={14} /></button></div>}
        {instance.status !== 'draft' && <Timeline instance={instance} stepId={step.id} run={run} copy={copy} busy={busy} />}
      </div>}
    </div>;
  };
  function renderGroup(group: StepGroup, index: number) {
    const members = groupSteps(document, group.id), open = openGroups.has(group.id), last = index + members.length - 1;
    const done = members.filter(step => { const result = latestResult(instance, step.id); return result && result.outcome !== 'failed'; }).length;
    const isCurrent = members.some(step => step.id === instance.currentStepId), future = instance.status === 'draft' || (instance.status === 'in_progress' && index > currentIndex), frozen = !active || done > 0;
    const previous = document.steps[index - 1], previousFirst = previous?.groupId ? document.steps.findIndex(step => step.groupId === previous.groupId) : index - 1;
    const structural = active && (instance.status === 'draft' || last >= currentIndex);
    const materialBlocked = members.some(step => instance.entries.some(entry => entry.stepId === step.id) || hasExplicitDraft(`comment:${instance.id}:${step.id}`));
    const removeReason = !future ? '当前或已推进步骤组不能删除' : document.steps.length <= members.length ? '流程至少保留一个步骤' : materialBlocked ? '请先处理组内的评论、图片或未提交输入' : undefined;
    return <section className={`step-group execution-group ${isCurrent ? 'current-group' : ''}`} key={group.id} data-group-id={group.id} data-group-current={isCurrent}>
      {structural && <StepActions object="group" blocks={blocks} disabled={busy} onAddChild={() => addAfter(last, group.id)} onAdd={() => addAfter(last)} onInsert={block => insertAt(block, last)} />}
      <div className="execution-group-heading" aria-expanded={open}><span className="group-kind-icon" aria-hidden="true"><Layers size={18} /></span><InlinePlain className="execution-group-name" label="步骤组名称" activationKey={groupActivation?.id === group.id ? groupActivation.version : undefined} value={group.name} readOnly={frozen} singleLine placeholder="未命名步骤组" onChange={name => edit(doc => ({ ...doc, groups: (doc.groups ?? []).map(item => item.id === group.id ? { ...item, name } : item) }))} /><span>{done} / {members.length} 步{isCurrent ? ' · 当前步骤组' : ''}</span><button className="group-expand-toggle icon-button" type="button" aria-label={`${open ? '收起' : '展开'}步骤组`} onClick={() => toggleGroup(group.id)}>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button><StepMoreActions object="group" disabled={busy} onDuplicate={structural ? () => duplicateGroup(group.id) : undefined} duplicateDisabledReason={!structural ? '此组结构已冻结' : undefined} onMoveUp={future && index > 0 && previousFirst > currentIndex ? () => edit(doc => moveWholeGroup(doc, group.id, -1)) : undefined} onMoveDown={future && last < document.steps.length - 1 ? () => edit(doc => moveWholeGroup(doc, group.id, 1)) : undefined} moveUpDisabledReason={!future ? '当前或已推进步骤组不能整体移动' : undefined} moveDownDisabledReason={!future ? '当前或已推进步骤组不能整体移动' : undefined} onFavorite={() => favoriteStep(undefined, group.id)} readOnly={!structural} onRemove={!removeReason ? () => deleteGroup(group.id) : undefined} removeDisabledReason={removeReason} /></div>
      {open && <div className="execution-group-body">{(!frozen || Boolean(group.description?.trim())) && <div data-group-description={group.id}><InlinePlain className="execution-group-description" label="步骤组描述" value={group.description ?? ''} readOnly={frozen} placeholder="添加描述" onChange={description => edit(doc => ({ ...doc, groups: (doc.groups ?? []).map(item => item.id === group.id ? { ...item, description } : item) }))} /></div>}{members.map((step, offset) => matchingIds.has(step.id) ? renderStep(step, index + offset) : null)}</div>}
    </section>;
  }
  return <div className="workspace-page"><div className="workspace-titlebar"><button className="icon-button back-button" title="返回列表" onClick={onBack}><ArrowLeft size={18} /></button><div className="workspace-title"><span className="eyebrow">工作记录<span className={`badge ${instance.status}`}>{statusLabels[instance.status]}</span>{instance.archivedAt && <span className="badge">已归档</span>}</span><InlinePlain className="name-editor" label="工作名称" value={buffer.value.name} onChange={name => buffer.update({ ...buffer.current.current, name })} placeholder="未命名" singleLine /></div><div className="heading-actions"><button className="button" disabled={busy} onClick={() => void run(async () => onDialog({ type: 'repeatWork', id: instance.id, name: instance.name }))}><Copy size={15} />再做一次</button><button className="button" disabled={busy} onClick={onExport}><Download size={15} />导出存档</button><details className="more-menu"><summary className="button" aria-label="更多操作"><MoreHorizontal size={18} /></summary><div>{!active && <button onClick={() => void run(async () => { await api.apply({ type: 'archive_instance', id: instance.id, archived: !instance.archivedAt }); notify(instance.archivedAt ? '已移回当前工作' : '已归档'); })}><Archive size={15} />{instance.archivedAt ? '移回当前' : '归档'}</button>}{instance.status === 'in_progress' && <button className="danger-text" onClick={() => void run(async () => onDialog({ type: 'terminate', id: instance.id }))}><Square size={14} />终止</button>}<button className="danger-text" disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); requestArtifactDeletion('instance', instance.id, run, onDialog); }}><Trash2 size={15} />删除工作</button></div></details></div></div>
    <div className="workspace-with-navigation"><StepNavigator document={document} instance={instance} scrollRef={scrollRef} onViewingChange={scope.setViewing} onLocate={navigateStep} /><div className="instance-step-column">{filtering && <div className="variable-filter-summary" role="status"><strong title={stepSearch.query}>筛选：{stepSearch.query || "变量引用"}</strong><span>{matchingSteps.length} 步 · {referenceCount(document, matchedVariables)} 处引用</span><button className="text-button" onClick={clearStepSearch}>显示全部</button></div>}<div className="workspace-scroll" ref={scrollRef} onPointerDownCapture={scope.select} onFocusCapture={scope.select} onWheelCapture={scope.release} onTouchMoveCapture={scope.release} onKeyDownCapture={scope.release}><div className="document-column" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && selectedSteps.size) { event.preventDefault(); cancelSelection(); } }}>{selectedSteps.size > 0 && <div className="step-selection-toolbar" role="toolbar" aria-label="批量步骤操作"><strong>已选 {selectedSteps.size} 步</strong><button className="button primary small" disabled={busy || Boolean(mergeReason)} title={mergeReason || undefined} onClick={mergeSelected}><Layers size={15} />合并为步骤组</button><button className="text-button" onClick={cancelSelection}>取消选择</button>{mergeReason && <small role="status">{mergeReason}</small>}</div>}{instance.status === 'draft' && <section className={`start-panel ${unappliedCount ? "pending-parameters-panel" : ""}`}><div><strong>{missing.length ? `还需填写 ${missing.length} 个参数` : unappliedCount ? `${unappliedCount} 个参数修改待应用` : document.parameters.length ? "参数已就绪" : "准备开始"}</strong><MissingParameters document={document} parameters={missing} values={values} onSelect={locate} /></div><button className="button primary" disabled={busy || missing.length > 0} onClick={() => void applyScope(undefined, true)}>{unappliedCount ? "应用并开始" : "开始记录"}<ArrowRight size={15} /></button></section>}
      {instance.status === 'in_progress' && savedMissing.length > 0 && <section className="start-panel missing-parameters-panel"><div><strong>{missing.length ? '新增流程参数尚未补齐' : '新增流程参数已填写，等待应用'}</strong><p>在右侧补齐新增参数后统一应用，历史结果保持原快照。</p><MissingParameters document={document} parameters={missing} values={values} onSelect={locate} /></div><button className="button primary" disabled={busy || missing.length > 0} onClick={() => void applyScope(undefined, false, true)}>应用全部参数<Check size={15} /></button></section>}
      {(instance.status === 'completed' || instance.status === 'terminated') && <div className={`completion-banner ${instance.status}`}><span className="completion-icon">{instance.status === 'completed' ? <CheckCheck size={23} /> : <Square size={20} />}</span><div><strong>{instance.status === 'completed' ? '本次工作已结束' : '本次工作已终止'}</strong><p>{instance.status === 'terminated' ? instance.terminationReason : `${instance.entries.filter(entry => entry.type === 'result' && entry.outcome === 'completed').length} 步完成 · ${instance.entries.filter(entry => entry.type === 'result' && entry.outcome === 'skipped').length} 步跳过`}</p><small>{formatTime(instance.finishedAt)}</small></div>{!instance.archivedAt && <button className="button" disabled={busy} onClick={() => void run(async () => { await api.apply({ type: 'archive_instance', id: instance.id, archived: true }); notify('已移入归档'); })}><Archive size={15} />归档</button>}</div>}
      <div className="execution-steps">{document.steps.map((step, index) => { if (!step.groupId) return matchingIds.has(step.id) ? renderStep(step, index) : null; if (index && document.steps[index - 1].groupId === step.groupId) return null; const group = document.groups?.find(item => item.id === step.groupId); return group ? groupSteps(document, group.id).some(member => matchingIds.has(member.id)) ? renderGroup(group, index) : null : matchingIds.has(step.id) ? renderStep(step, index) : null; })}{filtering && !matchingSteps.length && <p className="variable-search-empty" role="status">没有匹配的变量引用步骤</p>}</div></div></div><CurrentStepActions scrollRef={scrollRef} stepId={instance.status === "in_progress" ? instance.currentStepId : undefined} viewingId={scope.viewing} index={currentIndex} title={document.steps[currentIndex] ? renderText(document.steps[currentIndex].title, instance.parameterValues) : ""} layoutKey={JSON.stringify([[...expanded], [...openGroups], matchSignature])} last={currentIndex === document.steps.length - 1} busy={busy} onReturn={() => { if (instance.currentStepId) navigateStep(instance.currentStepId); }} onComplete={() => recordStep(instance.currentStepId!, currentIndex === document.steps.length - 1)} onFailed={() => reasonDialog(instance.currentStepId!, "failed")} onSkip={() => reasonDialog(instance.currentStepId!, "skipped")} /></div><VariablePanel draftKey={`instance:${instance.id}`} searchState={stepSearch} onSearch={searchSteps} onClearSearch={clearStepSearch} onFindReferences={locate} searchStepCount={matchingSteps.length} document={document} stepId={scope.viewing} onLocateStep={scope.locate} instance={{ ...instance, document }} draftValues={values} edit={edit} canEditDefinition={definitionEditable} canEditValue={valueEditable} canAddScope={ownerId => valueEditable({ id: "", name: "", description: "", defaultValue: "", ...(ownerId ? { ownerId } : {}) })} onValueChange={(id, value) => draft.update({ ...values, [id]: value })} onApplyScope={ownerId => void applyScope(ownerId)} onCancelScope={cancelScope} busy={busy} focusRequest={parameterFocus} /></div></div>;
}

function ActionDialog({ dialog, source, run, busy, onClose, onNavigate, notify }: { dialog: Exclude<Dialog, { type: 'deleteArtifact' } | FavoriteRequest>; source: Selection; run: RunOperation; busy: boolean; onClose: () => void; onNavigate: (selection: Selection) => void; notify: (text: string) => void }) {
  const initialText = 'name' in dialog ? dialog.name ?? '' : '';
  const isReason = dialog.type === 'failed' || dialog.type === 'skipped' || dialog.type === 'terminate';
  const isBlock = dialog.type === 'newBlock' || dialog.type === 'saveBlock';
  const titles = { newWork: '新建工作', renameFavorite: '重命名收藏', newBlock: '新建步骤块', saveBlock: '保存为步骤块', repeatWork: '再做一次', failed: '记录失败', skipped: '跳过这一步', terminate: '终止本次工作', import: '导入预览' };
  const labels = { failed: '失败原因', skipped: '跳过原因', terminate: '终止原因' };
  const id = 'id' in dialog ? dialog.id : source?.id;
  const stepId = dialog.type === 'failed' || dialog.type === 'skipped' ? api.getWorkspace().instances.find(item => item.id === id)?.currentStepId ?? undefined : undefined;
  const target: DraftTarget = { kind: dialog.type === 'renameFavorite' ? 'block' : dialog.type === 'saveBlock' ? source?.kind ?? 'instance' : dialog.type === 'newBlock' ? 'block' : 'instance', id: dialog.type === 'newWork' || dialog.type === 'newBlock' ? '' : id ?? '', stepId, dialog: dialog.type, groupId: dialog.type === 'saveBlock' ? dialog.groupId : undefined };
  const textDraft = useExplicitDraft('dialog:' + JSON.stringify([dialog.type, target.id, stepId, target.groupId]), { text: initialText, carryValues: true }, titles[dialog.type], target);
  const { text, carryValues } = textDraft.value, dirty = textDraft.dirty;
  const setText = (text: string) => textDraft.update({ ...textDraft.value, text });
  const nameLabel = dialog.type === 'renameFavorite' ? '收藏名称' : isBlock ? '步骤块名称' : '工作名称';
  function cancel() { textDraft.reset({ text: initialText, carryValues: true }); onClose(); }
  async function submit() {
    if (dialog.type !== 'import' && !text.trim()) return;
    await run(async () => {
      if (dialog.type === 'newWork') { const id = uid(); await api.apply({ type: 'create_work', id, name: text.trim(), document: emptyDocument() }); onNavigate({ kind: 'instance', id, draftRequest: { key: 'new-work-title', version: Date.now() } }); }
      else if (dialog.type === 'renameFavorite') { await api.apply({ type: 'rename_favorite', id: dialog.id!, name: text.trim() }); notify('收藏已重命名'); }
      else if (dialog.type === 'newBlock') { const id = uid(); await api.apply({ type: 'create_block', id, name: text.trim(), document: blockEmptyDocument(text.trim()) }); onNavigate({ kind: 'block', id }); }
      else if (dialog.type === 'saveBlock') { const block = groupAsBlock(dialog.document, dialog.groupId, text.trim()); await api.apply({ type: 'create_block', id: block.id, name: block.name, document: block.document }); notify('步骤块已保存；原流程保持独立'); }
      else if (dialog.type === 'repeatWork') { const id = uid(); await api.apply({ type: 'repeat_work', id, name: text.trim(), sourceId: dialog.id!, carryValues }); onNavigate({ kind: 'instance', id }); }
      else if (dialog.type === 'failed' || dialog.type === 'skipped') {
        const saved = api.getWorkspace().instances.find(item => item.id === dialog.id)!;
        const pendingValues = draftStore.entries.get('parameters:' + saved.id)?.value as Record<string, string> | undefined;
        if (pendingStepValues(saved.document, saved.currentStepId!, saved.parameterValues, pendingValues ?? {}).length) throw new Error('当前步骤引用的参数有未应用修改，请先查看并应用或取消修改，再提交结果。');
        await api.apply({ type: 'record_result', id: dialog.id!, outcome: dialog.type, reason: text.trim() });
      }
      else if (dialog.type === 'terminate') await api.apply({ type: 'terminate_instance', id: dialog.id!, reason: text.trim() });
      else if (dialog.type === 'import') {
        const before = api.getWorkspace(), imported = await api.commitImport(dialog.preview.token, dialog.preview.duplicate);
        const list = dialog.preview.kind === 'block' ? imported.blocks ?? [] : imported.instances, old = dialog.preview.kind === 'block' ? before.blocks ?? [] : before.instances;
        const oldIds = new Set(old.map(item => item.id)), item = list.find(value => !oldIds.has(value.id));
        if (item) onNavigate({ kind: dialog.preview.kind === 'block' ? 'block' : 'instance', id: item.id });
        notify(dialog.preview.duplicate ? '已导入为独立副本，原记录保持不变' : '导入完成');
      }
      textDraft.reset({ text: initialText, carryValues: true }); onClose();
    });
  }
  const importedLabel = dialog.type === 'import' ? dialog.preview.kind === 'block' ? '收藏' : '工作记录' : '';
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !dirty && !busy) cancel(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={titles[dialog.type]}><header><div><span className="eyebrow">RUNBOOK</span><h2>{titles[dialog.type]}</h2></div><button className="icon-button" title="取消" disabled={busy} onClick={cancel}><X size={18} /></button></header><div className="modal-body">
    {dialog.type === 'import' ? <><div className="import-preview"><span className="tile-icon">{dialog.preview.kind === 'block' ? <Layers size={23} /> : <Archive size={23} />}</span><div><strong>{dialog.preview.name}</strong><span>{importedLabel}</span></div></div><p className="validation-message"><CheckCircle2 size={15} />内容已通过结构与完整性校验</p>{dialog.preview.duplicate ? <div className="warning-note"><strong>本地已存在同一份{importedLabel}</strong><p>将导入为独立副本，完整保留内容；不会覆盖本地原记录。</p></div> : <p className="hint">导入后即可使用，工作记录拥有自己的完整内容。</p>}</>
      : <><p className="modal-description">{dialog.type === 'failed' ? '记录这次问题，当前步骤保持不变。' : dialog.type === 'skipped' ? '填写跳过原因后，推进到下一步。' : dialog.type === 'terminate' ? '终止后保留历史；需要重做时，打开记录再做一次。' : dialog.type === 'repeatWork' ? '复制当前流程和变量定义，创建一份独立工作。结果、评论、图片和操作时间留在原记录。' : dialog.type === 'saveBlock' ? '保存本组流程和变量定义，插入后各自独立。' : dialog.type === 'newBlock' ? '一个块是一组可复用步骤，参数定义在块内。' : '从一个简单步骤开始，逐步整理本次工作。'}</p><label className="field-label">{isReason ? labels[dialog.type as keyof typeof labels] : nameLabel}{isReason ? <textarea autoFocus aria-label={labels[dialog.type as keyof typeof labels]} rows={4} value={text} onChange={event => setText(event.target.value)} placeholder="请填写简短原因（必填）" /> : <input autoFocus aria-label={nameLabel} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit(); }} placeholder="为它起个清楚的名字" />}</label>
      {dialog.type === 'repeatWork' && <label className="repeat-work-values"><input type="checkbox" checked={carryValues} disabled={busy} onChange={event => textDraft.update({ ...textDraft.value, carryValues: event.target.checked })} /><span>带入上次参数值<small>创建后核对本次参数；取消勾选则使用变量默认值。</small></span></label>}</>}
    </div><footer><button className="button" disabled={busy} onClick={cancel}>取消</button><button className={'button ' + (dialog.type === 'terminate' ? 'danger' : 'primary')} disabled={busy || (dialog.type !== 'import' && !text.trim())} onClick={() => void submit()}>{busy ? '正在保存…' : dialog.type === 'import' ? dialog.preview.duplicate ? '导入为独立副本' : '确认导入' : dialog.type === 'failed' ? '保存失败记录' : dialog.type === 'skipped' ? '确认跳过' : dialog.type === 'terminate' ? '确认终止' : dialog.type === 'saveBlock' ? '保存步骤块' : dialog.type === 'newBlock' ? '创建步骤块' : dialog.type === 'renameFavorite' ? '保存名称' : dialog.type === 'repeatWork' ? '创建新工作' : '新建工作'}</button></footer></section></div>;
}
