import { useRef, useState } from 'react';
import { AlignLeft, ArrowDown, ArrowLeft, ArrowUp, Braces, Check, ChevronRight, Code2, Columns2, Copy, Eye, FileText, Layers, Plus, Scissors, Trash2, Unlink, WandSparkles } from 'lucide-react';
import { Button, Dialog, Input, Textarea } from '@runbook/ui';
import { api } from '@runbook/desktop-api';
import { MarkdownEditor, VisualEditor, byteToOffset, convertSelection, convertSelectionToVariable, duplicateStep, moveStep, parameterDefaults, parameterNamePattern, removeStep, setParameterDefault, unmarkStep, repairDuplicateIds, validateVariableSelection } from '@runbook/editor';
import type { Run, StepDefinition, Template } from '@runbook/contracts';
import { useAutosave, useDialogDraft, useDocument, useResolvedDocument } from './hooks';
import { MarkdownPreview, RangePreview } from './Preview';
import { parameterValue, sameParameters } from './parameters';

type Props = { template?: Template; run?: Run; onError: (error: unknown) => void; perform: (task: () => Promise<unknown>) => void; onBack: () => void; onCreateRun?: () => void; onExport: () => void; onReadRun?: () => void; busy: boolean };
export function EditorWorkspace({ template, run, onError, perform, onBack, onCreateRun, onExport, onReadRun, busy }: Props) {
  const object = template ?? run!;
  const readonly = !!template?.archived || !!run?.closed_at;
  const draft = useAutosave({ markdown: object.draft_markdown, name: object.name, description: template?.description ?? '', parameters: run?.draft_parameters ?? {} as Record<string, string> }, async (value) => {
    if (template) await api.mutate({ type: 'save_template', id: object.id, name: value.name, description: value.description, markdown: value.markdown });
    else await api.mutate({ type: 'save_run_draft', id: object.id, markdown: value.markdown, parameters: value.parameters });
  }, onError);
  const parsed = useDocument(draft.value.markdown, onError);
  const preview = useResolvedDocument(draft.value.markdown, run ? draft.value.parameters : {}, onError);
  const [mode, setMode] = useState<'visual' | 'source' | 'preview' | 'split'>('visual');
  const parameterPanel = useRef<HTMLDetailsElement>(null);
  const [visualDialog, setVisualDialog] = useState<Record<string, unknown> | null>(null);
  useDialogDraft(!!visualDialog, !!visualDialog, '文档编辑', visualDialog ?? {});
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ from: number }>();
  const [applyOpen, setApplyOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StepDefinition | null>(null);
  const [diff, setDiff] = useState({ added: 0, changed: 0, moved: 0, removed: 0 });
  const [variableSelection, setVariableSelection] = useState<{ source: string; from: number; to: number; text: string } | null>(null);
  const [variableName, setVariableName] = useState('');
  const [variableDefault, setVariableDefault] = useState('');
  useDialogDraft(!!variableSelection, !!variableName || !!variableDefault, '转换变量', { name: variableName, default_value: variableDefault, selected_text: variableSelection?.text });
  let defaults: Record<string, string> = {};
  try { defaults = parameterDefaults(draft.value.markdown); } catch { /* Native diagnostics explain invalid metadata. */ }
  const reuseVariable = Object.hasOwn(defaults, variableName);
  const openVariable = () => perform(async () => {
    const source = draft.current.current.markdown;
    const text = validateVariableSelection(source, selection);
    const doc = await api.parse(source);
    if (doc.diagnostics.length) throw new Error('请先修复草稿中的标记错误，再转换变量。');
    setVariableSelection({ source, ...selection, text });
    setVariableName('');
    setVariableDefault(text);
  });
  const confirmVariable = () => {
    try {
      if (!variableSelection || variableSelection.source !== draft.current.current.markdown) throw new Error('文档已改变，请重新选中文本后转换变量。');
      const source = convertSelectionToVariable(variableSelection.source, variableSelection, variableName, variableDefault);
      const values = parameterDefaults(source);
      draft.update({ ...draft.current.current, markdown: source, parameters: run ? { ...draft.current.current.parameters, [variableName]: parameterValue(draft.current.current.parameters, variableName, parameterValue(values, variableName)) } : draft.current.current.parameters });
      setVariableSelection(null);
    } catch (error) { onError(error); }
  };
  const updateSource = (markdown: string) => {
    const parameters = { ...draft.current.current.parameters };
    if (run) {
      try {
        for (const [name, value] of Object.entries(parameterDefaults(markdown))) {
          if (!Object.hasOwn(parameters, name)) Object.defineProperty(parameters, name, { value, enumerable: true, configurable: true, writable: true });
        }
      } catch { /* Keep partial source drafts intact; native diagnostics explain errors. */ }
    }
    draft.update({ ...draft.current.current, markdown, parameters });
  };
  const editVariable = (name: string) => {
    const panel = parameterPanel.current;
    if (!panel) return;
    panel.open = true;
    const input = [...panel.querySelectorAll<HTMLTextAreaElement>('textarea')].find(item => item.getAttribute('aria-label') === `参数 ${name}`);
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'nearest' });
  };
  const copyVisualCommand = async (text: string, commandId?: string) => {
    if (!commandId) return api.copy(text);
    const current = draft.current.current;
    const resolved = await api.resolve(current.markdown, run ? current.parameters : {});
    if (resolved.document.diagnostics.length) throw new Error('请先修复文档或参数，再复制指令。');
    const command = resolved.document.steps.flatMap(step => step.commands).find(item => item.id === commandId);
    if (!command) throw new Error('指令已改变，请重新选择。');
    await api.copy(command.text);
  };
  const selectEditorStep = (id: string) => perform(async () => {
    const source = draft.current.current.markdown;
    const doc = await api.parse(source);
    const step = doc.steps.find((item) => item.id === id);
    if (!step || doc.diagnostics.length) throw new Error('请先修复草稿中的标记错误，再定位步骤。');
    setSelectedStep(id);
    if (mode === 'preview') setMode('visual');
    setReveal({ from: byteToOffset(source, step.start) });
  });
  const convert = (kind: 'step' | 'command') => { try { updateSource(convertSelection(draft.current.current.markdown, selection, kind)); } catch (error) { onError(error); } };
  const transform = (id: string, operation: 'up' | 'down' | 'duplicate' | 'remove' | 'unmark') => perform(async () => {
    const source = draft.current.current.markdown;
    const doc = await api.parse(source);
    if (doc.diagnostics.length) throw new Error('请先修复文档标记错误，再调整步骤。');
    const step = doc.steps.find((item) => item.id === id);
    if (!step) throw new Error('步骤已发生变化，请重新选择。');
    const next = operation === 'up' || operation === 'down' ? moveStep(source, step, operation === 'up' ? -1 : 1, doc.steps) : operation === 'duplicate' ? duplicateStep(source, step) : operation === 'remove' ? removeStep(source, step) : unmarkStep(source, step);
    updateSource(next);
    setRemoveTarget(null);
  });
  const prepareApply = () => perform(async () => {
    await api.flush();
    const { document: doc } = await api.resolve(draft.current.current.markdown, draft.current.current.parameters);
    if (doc.diagnostics.length) throw new Error('源码尚有错误，请修复后再应用。草稿已自动保存。');
    const present = run!.steps.filter((step) => step.present);
    setDiff({ added: doc.steps.filter((s) => !present.some((old) => old.step_id === s.id)).length, changed: doc.steps.filter((s) => present.some((old) => old.step_id === s.id && old.definition.content_hash !== s.content_hash)).length, moved: doc.steps.filter((s, index) => present.some((old) => old.step_id === s.id && old.position !== index)).length, removed: present.filter((old) => !doc.steps.some((s) => s.id === old.step_id)).length });
    setApplyOpen(true);
  });
  const exitEditor = () => {
    if (run && (draft.current.current.markdown !== run.applied_markdown || !sameParameters(draft.current.current.parameters, run.parameters))) setLeaveOpen(true);
    else perform(async () => { await api.flush(); onReadRun?.(); });
  };
  const steps = parsed.document?.steps ?? [];
  const rawErrors = parsed.current ? parsed.document?.diagnostics ?? [] : [];
  const errors = rawErrors.length ? rawErrors : preview.current ? preview.resolved?.document.diagnostics ?? [] : [];
  return <div className="workspace editor-workspace">
    <header className="workspace-header"><div className="breadcrumb"><Button variant="ghost" size="icon" onClick={run ? exitEditor : onBack} aria-label="返回"><ArrowLeft size={18}/></Button><span>{run ? '编辑实例' : template?.archived ? '归档模板' : '模板编辑'}</span><ChevronRight size={14}/><strong>{object.name}</strong></div><div className="header-actions"><span className="save-label"><span className={`save-dot ${draft.dirty ? 'pending' : ''}`}/>{draft.dirty ? '等待保存' : '已保存'}</span><Button onClick={onExport}><FileText size={15}/>导出</Button>{run && !readonly ? <Button variant="primary" disabled={busy} onClick={prepareApply}><Check size={15}/>应用并返回执行</Button> : !readonly && <Button variant="primary" disabled={busy || rawErrors.length > 0 || !parsed.current} onClick={onCreateRun}><Plus size={15}/>创建执行实例</Button>}</div></header>
    <section className="editor-titlebar"><div className="eyebrow">{run ? 'INSTANCE WORKFLOW' : 'RUNBOOK TEMPLATE'}</div>{template && !readonly ? <Input className="title-input" aria-label="模板名称" value={draft.value.name} readOnly={busy} onChange={(event) => draft.update({ ...draft.current.current, name: event.target.value })}/> : <h1>{object.name}</h1>}{template ? <Input className="description-input" aria-label="模板描述" placeholder="添加一句说明，方便下次找到这份流程…" value={draft.value.description} readOnly={readonly || busy} onChange={(event) => draft.update({ ...draft.current.current, description: event.target.value })}/> : <p>本次文档、参数、指令和检查点均可独立编辑，来源模板不受影响。应用后受影响步骤需要重新确认。</p>}</section>
    <div className="editor-toolbar"><div className="segmented">{([['visual', FileText, '文档'], ['source', Code2, '源码'], ['split', Columns2, '源码对照'], ['preview', Eye, '预览']] as const).map(([key, Icon, text]) => <button key={key} className={mode === key ? 'selected' : ''} onClick={() => { setMode(key); setSelection({ from: 0, to: 0 }); }}><Icon size={14}/>{text}</button>)}</div>{!readonly && mode !== 'visual' && mode !== 'preview' && <div className="conversion-tools"><span>选择原文后</span><Button size="sm" onClick={() => convert('step')} disabled={busy || selection.from === selection.to}><Layers size={14}/>转为步骤</Button><Button size="sm" onClick={() => convert('command')} disabled={busy || selection.from === selection.to}><Code2 size={14}/>转为指令</Button><Button size="sm" onClick={openVariable} disabled={busy || selection.from === selection.to}><Braces size={14}/>转为变量</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { try { const separator = draft.value.markdown.endsWith('\n') ? '\n' : '\n\n'; const block = '## 新检查点\n\n确认检查事项并记录预期结果。'; const source = draft.value.markdown + separator + block; updateSource(convertSelection(source, { from: source.length - block.length, to: source.length }, 'step')); } catch (error) { onError(error); } }}><Plus size={14}/>新增检查点</Button></div>}</div>
    <details ref={parameterPanel} className="parameter-panel" open={Object.keys(defaults).length > 0}><summary><Braces size={14}/><strong>{run ? '本次实例参数' : '模板变量与默认值'}</strong><span>{Object.keys(defaults).length} 个变量</span><small>{run ? '修改后点击应用，才会更新执行流程' : '选中文本后点击“转为变量”'}</small></summary><div className="parameter-fields">{Object.entries(defaults).map(([name, defaultValue]) => <label className="parameter-field" key={name}><span><code>{name}</code>{run && <small>本次值</small>}</span><Textarea aria-label={`参数 ${name}`} rows={1} readOnly={readonly || busy} value={run ? parameterValue(draft.value.parameters, name, defaultValue) : defaultValue} onChange={(event) => { if (run) draft.update({ ...draft.current.current, parameters: { ...draft.current.current.parameters, [name]: event.target.value } }); else { try { updateSource(setParameterDefault(draft.current.current.markdown, name, event.target.value)); } catch (error) { onError(error); } } }}/></label>)}{Object.keys(defaults).length === 0 && <p>选择正文或指令中的固定内容，设为变量后可在这里统一填写。</p>}</div></details>
    {errors.length > 0 && <div className="diagnostics"><strong>{template && rawErrors.length === 0 ? '默认值预览需要调整；创建实例时可填写其他值' : '草稿已保留，尚未应用'}</strong><Button size="sm" disabled={busy || readonly} onClick={() => updateSource(repairDuplicateIds(draft.current.current.markdown))}>修复重复身份</Button>{errors.map((error, index) => <span key={index}>第 {error.line} 行 · {error.message}</span>)}</div>}
    <div className="editor-body"><aside className="outline"><div className="section-caption"><span>步骤目录</span><span>{steps.length}</span></div>{steps.length === 0 ? <div className="outline-empty"><Scissors size={22}/><p>点击文档行左侧的“＋”新增步骤，或将选中的内容设为步骤。</p><span>普通标题不会自动成为步骤</span></div> : steps.map((step, index) => <div key={step.id} className={`outline-item ${selectedStep === step.id ? 'selected' : ''}`}><button className="outline-select" onClick={() => selectEditorStep(step.id)}><span className="step-index">{String(index + 1).padStart(2, '0')}</span><span>{step.title}</span></button>{selectedStep === step.id && !readonly && <div className="step-tools"><Button size="icon" variant="ghost" title="上移" disabled={busy || index === 0 || !parsed.current} onClick={() => transform(step.id, 'up')}><ArrowUp size={14}/></Button><Button size="icon" variant="ghost" title="下移" disabled={busy || index === steps.length - 1 || !parsed.current} onClick={() => transform(step.id, 'down')}><ArrowDown size={14}/></Button><Button size="icon" variant="ghost" title="复制步骤" disabled={busy || !parsed.current} onClick={() => transform(step.id, 'duplicate')}><Copy size={14}/></Button><Button size="icon" variant="ghost" title="取消步骤标记，保留正文" disabled={busy || !parsed.current} onClick={() => transform(step.id, 'unmark')}><Unlink size={14}/></Button><Button size="icon" variant="ghost" title="移除步骤及正文" disabled={busy || !parsed.current} onClick={() => setRemoveTarget(step)}><Trash2 size={14}/></Button></div>}</div>)}<div className="outline-note"><WandSparkles size={14}/><span>Markdown 是原文，步骤标记让操作有迹可循。</span></div></aside>
      <div className={`editor-panels mode-${mode}`}>{mode === 'visual' ? <VisualEditor value={draft.value.markdown} onChange={updateSource} readOnly={readonly || busy} reveal={reveal} revealStepId={selectedStep ?? undefined} onError={onError} onCopy={copyVisualCommand} copyLabel={run ? '复制草稿指令' : '复制指令'} onOpenSource={() => setMode('source')} onEditVariable={editVariable} onPendingDialogChange={setVisualDialog} renderRaw={(source) => <MarkdownPreview source={source}/>}/> : <>{mode !== 'preview' && <div className="source-panel"><div className="panel-caption"><Code2 size={13}/> MARKDOWN <span>{draft.value.markdown.length.toLocaleString()} 字符</span></div><MarkdownEditor reveal={reveal} value={draft.value.markdown} onChange={updateSource} onSelectionChange={setSelection} readOnly={readonly || busy}/></div>}{mode !== 'source' && <div className="preview-panel"><div className="panel-caption"><AlignLeft size={13}/> 文档预览 <span>{run ? '使用本次参数' : '使用默认参数'}</span></div><div className="preview-content">{draft.value.markdown.trim() ? preview.current && errors.length === 0 && preview.resolved ? <RangePreview source={preview.resolved.markdown} commands={preview.resolved.document.steps.flatMap((step) => step.commands)} onError={onError}/> : <MarkdownPreview source={draft.value.markdown}/> : <div className="preview-empty"><FileText size={36}/><h3>让维护文档变成操作手册</h3><p>在左侧粘贴 Markdown，选择要跟踪的段落，再点击“转为步骤”。</p></div>}</div></div>}</>}</div>
    </div>
    <Dialog busy={busy} open={!!variableSelection} onOpenChange={(open) => { if (!open) setVariableSelection(null); }} title="将选中文本转为变量" description="只替换本次选区。变量默认值保留原文本，创建实例时可填写独立值。" footer={<><Button onClick={() => setVariableSelection(null)}>取消</Button><Button variant="primary" disabled={busy || !parameterNamePattern.test(variableName)} onClick={confirmVariable}>转换为变量</Button></>}><label className="field-label">变量名称<Input aria-label="变量名称" autoFocus list="existing-parameter-names" value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="例如 HOST、SERVER_PATH"/><datalist id="existing-parameter-names">{Object.keys(defaults).map((name) => <option key={name} value={name}/>)}</datalist></label><p className="parameter-name-hint">以字母或下划线开头，仅包含字母、数字和下划线，最多 64 个字符。</p><label className="field-label">{reuseVariable ? '复用已有变量的默认值' : '默认值'}<Textarea aria-label="默认值" rows={3} spellCheck={false} readOnly={busy || reuseVariable} value={reuseVariable ? parameterValue(defaults, variableName) : variableDefault} onChange={(event) => setVariableDefault(event.target.value)}/></label>{reuseVariable && <p className="muted small">本次复用已有变量，保留其默认值{run ? '和本次实例值' : ''}。可在参数面板统一修改。</p>}<div className="variable-preview"><span>替换为</span><code>{`{{rb:${variableName || '变量名'}}}`}</code></div></Dialog>
    <Dialog busy={busy} open={applyOpen} onOpenChange={setApplyOpen} title="应用本次流程调整" description="正文、指令或参数替换结果发生变化的步骤需要重新确认。仅调整顺序保留已有结果。" footer={<><Button onClick={() => setApplyOpen(false)}>继续编辑</Button><Button variant="primary" disabled={busy || readonly} onClick={() => perform(async () => { await api.flush(); await api.mutate({ type: 'apply_run_draft', id: run!.id }); setApplyOpen(false); onReadRun?.(); })}>应用修改</Button></>}><div className="change-summary">{[['新增', diff.added], ['内容变化', diff.changed], ['位置调整', diff.moved], ['移除', diff.removed]].map(([label, count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div><p className="muted small">正在记录的步骤如被修改或移除，需要先结束或作废该轮记录。旧轮次的指令与参数快照、已移除步骤的历史都继续保留。</p></Dialog>
    <Dialog busy={busy} open={leaveOpen} onOpenChange={setLeaveOpen} title="本次流程还有未应用的草稿" description="可以保留编辑内容，回到已应用的流程继续操作。" footer={<><Button onClick={() => setLeaveOpen(false)}>继续编辑</Button><Button onClick={() => perform(async () => { await api.flush(); setLeaveOpen(false); onReadRun?.(); })}>保留草稿并返回</Button><Button variant="primary" onClick={() => { setLeaveOpen(false); prepareApply(); }}>应用修改</Button></>}><p className="muted">已应用版本与编辑草稿分别保存，尚未应用的修改不会改变现有指令或记录。</p></Dialog>
    <Dialog busy={busy} open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }} title="移除这一步骤？" description="这会从当前文档中删除整个步骤及正文；执行历史仍会保留。" footer={<><Button onClick={() => setRemoveTarget(null)}>取消</Button><Button variant="danger" onClick={() => removeTarget && transform(removeTarget.id, 'remove')}>移除步骤及正文</Button></>}><p>{removeTarget?.title}</p><p className="muted small">如果希望保留文档正文，请使用步骤目录中的“取消步骤标记”。</p></Dialog>
  </div>;
}
