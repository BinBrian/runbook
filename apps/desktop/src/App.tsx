import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Archive, ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Clock3, FileCheck2, FileClock, FileJson2, FilePlus2, FileText, FolderOpen, HardDrive, Import, Layers, LoaderCircle, MoreHorizontal, Plus, Search, ShieldCheck, Terminal, Upload, X } from 'lucide-react';
import { Button, Dialog, Input, Textarea } from '@runbook/ui';
import { api, installCloseGuard } from '@runbook/desktop-api';
import type { ParameterDefinition, Run, Template, Workspace } from '@runbook/contracts';
import { setParameterDefault } from '@runbook/editor';
import { EditorWorkspace } from './EditorWorkspace';
import { ExecutionWorkspace, SummaryCounts, conclusionLabels, formatTime } from './ExecutionWorkspace';
import { getUnsavedInputs, useDialogDraft } from './hooks';
import { MarkdownPreview } from './Preview';
import { previewWorkspace } from './previewFixture';
import { parameterValue, parameterValues, sameParameters } from './parameters';

type View = 'templates' | 'active' | 'history';
type Route = { type: 'list' } | { type: 'template' | 'run' | 'edit-run'; id: string };
type RunSource = { templateId?: string; runId?: string; name: string };
type ImportDraft = { name: string; content: string; kind: 'markdown' | 'json'; templates: number; runs: number; diagnostics: string[] };
const emptyWorkspace: Workspace = { templates: [], runs: [] };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const suggestedName = (name: string) => `${name} · ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date())}`;

export default function App() {
  const previewMode = !('__TAURI_INTERNALS__' in window) && new URLSearchParams(window.location.search).get('preview') === '1';
  const previewList = new URLSearchParams(window.location.search).get('screen') === 'templates';
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState(api.getStatus());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [view, setView] = useState<View>(previewMode && !previewList ? 'active' : 'templates');
  const [route, setRoute] = useState<Route>(previewMode && !previewList ? { type: 'run', id: 'preview-run' } : { type: 'list' });
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [newTemplate, setNewTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [runSource, setRunSource] = useState<RunSource | null>(null);
  const [runName, setRunName] = useState('');
  const [runContext, setRunContext] = useState('');
  const [runParameterDefinitions, setRunParameterDefinitions] = useState<ParameterDefinition[]>([]);
  const [runParameters, setRunParameters] = useState<Record<string, string>>({});
  const [runSourceMarkdown, setRunSourceMarkdown] = useState('');
  const [runParameterError, setRunParameterError] = useState('');
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  useDialogDraft(newTemplate, !!templateName.trim(), '新建模板', { name: templateName });
  useDialogDraft(!!runSource, !!runName.trim() || !!runContext.trim() || Object.keys(runParameters).length > 0, '创建执行实例', { name: runName, context: runContext, parameters: runParameters });
  const onError = (reason: unknown) => { setError(errorMessage(reason)); };
  useEffect(() => {
    if (previewMode) { setWorkspace(previewWorkspace()); setLoading(false); return; }
    const unsubscribe = api.subscribe(setWorkspace);
    const statusUnsubscribe = api.onStatus(setStatus);
    void api.load().then(setWorkspace).catch((reason: unknown) => setStartupError(errorMessage(reason))).finally(() => setLoading(false));
    return () => { unsubscribe(); statusUnsubscribe(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;
    void installCloseGuard(setError).then((handler) => { if (disposed) handler(); else remove = handler; }).catch(onError);
    return () => { disposed = true; remove?.(); };
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  const perform = (task: () => Promise<unknown>) => {
    if (previewMode) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void task().catch(onError).finally(() => { busyRef.current = false; setBusy(false); });
  };
  const go = (next: Route, nextView?: View) => perform(async () => { await api.flush(); setRoute(next); setError(''); if (nextView) { setView(nextView); setSearch(''); } });
  const beginRun = (source: RunSource) => perform(async () => {
    await api.flush();
    const latest = await api.load();
    const origin = source.templateId ? latest.templates.find((item) => item.id === source.templateId) : latest.runs.find((item) => item.id === source.runId);
    if (!origin) throw new Error('来源流程已不可用，请重新选择。');
    const parsed = await api.parse(source.templateId ? origin.draft_markdown : origin.applied_markdown);
    if (parsed.diagnostics.length) throw new Error('来源草稿尚有标记错误，请修复后再创建执行实例。');
    setRunParameterDefinitions(parsed.parameters);
    setRunParameters(parameterValues(parsed.parameters, 'parameters' in origin ? origin.parameters : {}));
    setRunSourceMarkdown(source.templateId ? origin.draft_markdown : origin.applied_markdown);
    setRunParameterError('');
    setRunSource({ ...source, name: origin.name });
    setRunName(suggestedName(origin.name));
    setRunContext('');
  });
  const importFile = () => perform(async () => {
    await api.flush();
    const file = await api.importFile();
    if (!file) return;
    const isJson = /\.json$/i.test(file.name);
    if (isJson) { const counts = await api.previewImport(file.content); setImportDraft({ ...file, kind: 'json', ...counts, diagnostics: [] }); }
    else { const parsed = await api.parse(file.content); setImportDraft({ ...file, kind: 'markdown', templates: 1, runs: 0, diagnostics: parsed.diagnostics.map((item) => `第 ${item.line} 行：${item.message}`) }); }
  });
  const selectedTemplate = route.type === 'template' ? workspace.templates.find((template) => template.id === route.id) : undefined;
  const selectedRun = route.type === 'run' || route.type === 'edit-run' ? workspace.runs.find((run) => run.id === route.id) : undefined;
  const selectedObject = selectedTemplate ?? selectedRun;
  const selectedHasDraft = !!selectedObject && (selectedObject.draft_markdown !== selectedObject.applied_markdown || (!!selectedRun && !sameParameters(selectedRun.draft_parameters, selectedRun.parameters)));
  const createInstance = () => perform(async () => {
    try {
      await api.flush();
      const resolved = await api.resolve(runSourceMarkdown, runParameters);
      if (resolved.document.diagnostics.length) { setRunParameterError(resolved.document.diagnostics.map((item) => `第 ${item.line} 行：${item.message}`).join('\n')); return; }
      const id = crypto.randomUUID();
      await api.mutate({ type: 'create_run', id, template_id: runSource?.templateId ?? null, from_run_id: runSource?.runId ?? null, name: runName.trim(), context: runContext, parameters: runParameters });
      setRunSource(null); setRoute({ type: 'run', id }); setView('active');
    } catch (reason) { setRunParameterError(errorMessage(reason)); throw reason; }
  });
  const exportContent = (kind: 'plain' | 'runbook' | 'report' | 'json') => perform(async () => {
    await api.flush();
    const refreshed = await api.load();
    const object = selectedTemplate ? refreshed.templates.find((item) => item.id === selectedTemplate.id) : selectedRun ? refreshed.runs.find((item) => item.id === selectedRun.id) : undefined;
    let content: string;
    let filename: string;
    if (kind === 'json') { content = await api.backup(); filename = `Runbook-完整备份-${new Date().toISOString().slice(0, 10)}.json`; }
    else {
      if (!object) throw new Error('请先打开要导出的模板或执行实例。');
      if (kind === 'plain') { content = await api.plainMarkdown(object.applied_markdown, 'parameters' in object ? object.parameters : {}); filename = `${object.name}.md`; }
      else if (kind === 'runbook') { content = object.applied_markdown; if ('parameters' in object) for (const [name, value] of Object.entries(object.parameters)) content = setParameterDefault(content, name, value); filename = `${object.name}.runbook.md`; }
      else { content = await api.report(object.id); filename = `${object.name}.report.md`; }
    }
    if (await api.exportFile(filename, content)) { setNotice('文件已导出'); setExportOpen(false); }
  });
  const activeRuns = workspace.runs.filter((run) => !run.closed_at);
  const historyRuns = workspace.runs.filter((run) => run.closed_at);
  const templates = workspace.templates.filter((template) => template.archived === showArchived && template.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const runs = (view === 'active' ? activeRuns : historyRuns).filter((run) => `${run.name} ${run.context} ${run.initial_template_snapshot.name}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const nativeAvailable = '__TAURI_INTERNALS__' in window;

  if (loading) return <div className="startup"><div className="brand-symbol"><Terminal size={24}/></div><LoaderCircle className="spin" size={22}/><h2>正在打开本地工作区</h2><p>读取模板和执行记录…</p></div>;
  if (startupError) return <div className="startup"><div className="brand-symbol"><Terminal size={28}/></div><div className="eyebrow">RUNBOOK · WINDOWS DESKTOP</div><h1>{nativeAvailable ? '本地工作区暂时无法打开' : '在桌面端打开你的操作手册'}</h1><p>{nativeAvailable ? startupError : 'Runbook 使用桌面端的 SQLite 保存模板和执行记录。请启动 Windows 桌面应用，继续编辑与维护。'}</p>{!nativeAvailable && <code>pnpm dev</code>}<Button onClick={() => window.location.reload()}><RotateIcon/>重新尝试</Button><span className="startup-footnote"><HardDrive size={14}/>本地优先 · 无需登录 · 操作有迹可循</span></div>;
  return <>{previewMode && <div className="preview-ribbon">只读界面预览 · 示例数据 · 不执行、不保存任何操作</div>}<div className={`app-shell ${previewMode ? 'is-preview' : ''}`} inert={previewMode}><aside className="sidebar"><button className="brand" onClick={() => go({ type: 'list' }, 'templates')}><div className="brand-symbol"><Terminal size={22}/></div><div><strong>Runbook<span>桌面工作区</span></strong></div></button><div className="sidebar-workspace"><span className="workspace-avatar">本</span><div><strong>本地工作区</strong><span>操作有迹可循</span></div><ChevronRight size={14}/></div><div className="nav-caption">工作台</div><nav>{([{ id: 'templates', icon: BookOpen, label: '模板', count: workspace.templates.filter((template) => !template.archived).length }, { id: 'active', icon: Clock3, label: '进行中', count: activeRuns.length }, { id: 'history', icon: FileClock, label: '已留档', count: historyRuns.length }] as const).map(({ id, icon: Icon, label, count }) => <button key={id} aria-label={label} className={view === id ? 'active' : ''} onClick={() => go({ type: 'list' }, id)}><Icon size={18}/><span>{label}</span><b>{count}</b></button>)}</nav><div className="sidebar-divider"/><div className="nav-caption">资料与数据</div><div className="sidebar-tools"><button onClick={importFile} disabled={busy}><Import size={17}/>导入文档 / 备份</button><button onClick={() => setExportOpen(true)}><HardDrive size={17}/>备份工作区</button><button onClick={() => setHelpOpen(true)}><CircleHelp size={17}/>使用指南</button></div><div className="sidebar-bottom"><div><span className={`save-dot ${status === 'error' ? 'error' : status === 'saving' ? 'pending' : ''}`}/><span>{status === 'error' ? '保存失败，请处理' : status === 'saving' ? '正在保存到本地…' : '本地存储已就绪'}</span></div><small>V0.1 <span>离线也能安心工作</span></small></div></aside>
    <div className="app-content">{error && <div className="error-banner" role="alert"><AlertCircle size={18}/><div><strong>操作未完成</strong><span>{error}</span></div><Button size="sm" onClick={() => perform(async () => { await api.flush(); setError(''); setNotice('待保存内容已写入本地'); })}>重试保存</Button><Button size="sm" onClick={() => perform(async () => { const inputs = getUnsavedInputs(); const content = `Runbook 未保存输入（临时救出文件，不是完整备份）\n导出时间：${new Date().toISOString()}\n\n${JSON.stringify(inputs, null, 2)}`; if (await api.exportFile('Runbook-未保存输入.txt', content)) setNotice('未保存输入已导出'); })}>导出未保存输入</Button><Button size="icon" variant="ghost" aria-label="关闭提示" onClick={() => setError('')}><X size={16}/></Button></div>}
      {route.type === 'template' && selectedTemplate ? <EditorWorkspace key={selectedTemplate.id} template={selectedTemplate} onError={onError} perform={perform} busy={busy} onBack={() => go({ type: 'list' }, 'templates')} onCreateRun={() => beginRun({ templateId: selectedTemplate.id, name: selectedTemplate.name })} onExport={() => setExportOpen(true)}/> : route.type === 'edit-run' && selectedRun ? <EditorWorkspace key={`edit-${selectedRun.id}`} run={selectedRun} onError={onError} perform={perform} busy={busy} onBack={() => go({ type: 'list' }, 'active')} onReadRun={() => setRoute({ type: 'run', id: selectedRun.id })} onExport={() => setExportOpen(true)}/> : route.type === 'run' && selectedRun ? <ExecutionWorkspace key={selectedRun.id} run={selectedRun} sourceTemplate={workspace.templates.find((template) => template.id === selectedRun.source_template_id)} onError={onError} perform={perform} busy={busy} onBack={() => go({ type: 'list' }, selectedRun.closed_at ? 'history' : 'active')} onEdit={() => go({ type: 'edit-run', id: selectedRun.id })} onExport={() => setExportOpen(true)} onRepeat={(from) => beginRun(from === 'run' ? { runId: selectedRun.id, name: selectedRun.name } : { templateId: selectedRun.source_template_id!, name: workspace.templates.find((template) => template.id === selectedRun.source_template_id)?.name ?? selectedRun.name })}/> : <main className="library"><header className="library-topline"><div className="breadcrumb"><span>工作台</span><ChevronRight size={14}/><strong>{view === 'templates' ? '模板' : view === 'active' ? '进行中' : '已留档'}</strong></div><span className="local-chip"><ShieldCheck size={14}/>数据仅保存在此设备</span></header><section className="library-heading"><div className="eyebrow">YOUR OPERATIONS, IN ORDER</div><div><div><h1>{view === 'templates' ? '把经验，留成流程。' : view === 'active' ? '接着上一次，稳步推进。' : '每一次操作，都有记录。'}</h1><p>{view === 'templates' ? '从一份 Markdown 开始，让每次维护都有清晰的步骤。' : view === 'active' ? '恢复执行现场，查看回显与异常，继续完成本次流程。' : '查看已留档的流程、轮次和结论，随时还原操作过程。'}</p></div><div className="header-actions"><Button onClick={importFile} disabled={busy}><Import size={15}/>导入</Button><Button variant="primary" onClick={() => { setTemplateName(''); setNewTemplate(true); }}><Plus size={16}/>新建模板</Button></div></div></section><div className="library-toolbar"><div className="library-tabs"><button className={!showArchived || view !== 'templates' ? 'selected' : ''} onClick={() => setShowArchived(false)}>{view === 'templates' ? '可用模板' : view === 'active' ? '当前记录' : '执行历史'}<span>{view === 'templates' ? workspace.templates.filter((template) => !template.archived).length : runs.length}</span></button>{view === 'templates' && <button className={showArchived ? 'selected' : ''} onClick={() => setShowArchived(true)}>已归档模板<span>{workspace.templates.filter((template) => template.archived).length}</span></button>}</div><div className="search-box"><Search size={16}/><Input readOnly={busy} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={view === 'templates' ? '搜索模板…' : '搜索记录、背景或来源…'} aria-label="搜索"/>{search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={14}/></button>}</div></div>
        {view === 'templates' ? templates.length > 0 ? <div className="template-grid">{templates.map((template) => <TemplateCard key={template.id} template={template} open={() => go({ type: 'template', id: template.id })} create={() => beginRun({ templateId: template.id, name: template.name })} archive={() => setArchiveTarget(template)} restore={() => perform(async () => { await api.mutate({ type: 'archive_template', id: template.id, archived: false }); setNotice('模板已恢复'); })} busy={busy}/>)}{!showArchived && !search && <button className="new-template-card" onClick={() => { setTemplateName(''); setNewTemplate(true); }}><span><Plus size={23}/></span><strong>创建另一份流程</strong><p>把重复工作整理成可复用的手册</p></button>}</div> : <div className="empty-state"><div className="empty-illustration"><FileText size={48}/><span><Check size={20}/></span></div><h2>{search ? '没有找到匹配的模板' : showArchived ? '没有已归档的模板' : '第一份操作手册，从这里开始'}</h2><p>{search ? '试试其他名称，或清空搜索。' : showArchived ? '归档的模板会保存在这里，随时可以恢复。' : '粘贴已有 Markdown，手动标记步骤与指令。整理一次，每次维护独立记录。'}</p>{!search && !showArchived && <div><Button variant="primary" onClick={() => { setTemplateName(''); setNewTemplate(true); }}><Plus size={16}/>新建模板</Button><Button onClick={importFile}><FolderOpen size={16}/>导入 Markdown</Button></div>}</div> : runs.length > 0 ? <div className="run-list">{runs.map((run) => <button key={run.id} className="run-list-item" onClick={() => go({ type: 'run', id: run.id })}><div className={`run-list-icon ${run.closed_at ? 'closed' : ''}`}>{run.closed_at ? <FileCheck2 size={22}/> : <Clock3 size={22}/>}</div><div className="run-list-info"><h3>{run.name}{run.closed_at && <span className={`badge badge-${run.summary.conclusion}`}>{conclusionLabels[run.summary.conclusion] ?? run.summary.conclusion}</span>}</h3><p>{run.initial_template_snapshot.name} <span>·</span> 更新于 {formatTime(run.updated_at)}</p><SummaryCounts summary={run.summary}/></div><ChevronRight size={18}/></button>)}</div> : <div className="empty-state"><div className="empty-illustration">{view === 'active' ? <Clock3 size={48}/> : <FileClock size={48}/>}</div><h2>{search ? '没有找到匹配的记录' : view === 'active' ? '还没有进行中的流程' : '完成一轮，留下一份记录'}</h2><p>{search ? '试试其他关键词。' : view === 'active' ? '从模板创建执行实例，每次操作和回显都会独立保存。' : '执行实例结束留档后，会在这里保留全部步骤、历史轮次和异常说明。'}</p>{!search && <Button onClick={() => go({ type: 'list' }, 'templates')}>前往模板<ArrowRight size={15}/></Button>}</div>}<footer className="library-footer"><span><HardDrive size={13}/>本地优先，自动保存</span><span>你来操作，Runbook 帮你记住每一步。</span></footer></main>}
    </div>{notice && <div className="toast" role="status"><Check size={16}/>{notice}</div>}
    <Dialog busy={busy} open={newTemplate} onOpenChange={setNewTemplate} title="新建 Runbook 模板" description="为这份可复用的操作手册起个名字，然后粘贴或编辑 Markdown。" footer={<><Button onClick={() => setNewTemplate(false)}>取消</Button><Button variant="primary" disabled={busy || !templateName.trim()} onClick={() => perform(async () => { await api.flush(); const id = crypto.randomUUID(); await api.mutate({ type: 'create_template', id, name: templateName.trim(), markdown: '' }); setNewTemplate(false); setRoute({ type: 'template', id }); setView('templates'); })}>创建并编辑<ArrowRight size={15}/></Button></>}><label className="field-label">模板名称<Input readOnly={busy} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="例如：生产环境补丁维护" autoFocus/></label><div className="dialog-tip"><Layers size={18}/><span>模板只保存流程；每次执行都拥有自己的步骤状态和记录。</span></div></Dialog>
    <Dialog busy={busy} open={!!runSource} onOpenChange={(open) => { if (!open) setRunSource(null); }} title="创建独立执行实例" description={`基于「${runSource?.name ?? ''}」创建本次流程，后续调整不会影响来源。`} footer={<><Button onClick={() => setRunSource(null)}>取消</Button><Button variant="primary" disabled={busy || !runName.trim()} onClick={createInstance}>创建并开始记录<ArrowRight size={15}/></Button></>}><label className="field-label">本次记录名称<Input readOnly={busy} value={runName} onChange={(event) => setRunName(event.target.value)} autoFocus/></label><label className="field-label">维护背景（可选）<Textarea readOnly={busy} rows={3} value={runContext} onChange={(event) => setRunContext(event.target.value)} placeholder="环境、维护窗口、工单或本次注意事项…"/></label>{runParameterError && <p className="field-error parameter-error" role="alert">{runParameterError}</p>}{runParameterDefinitions.length > 0 && <div className="create-run-parameters"><h3>填写本次参数</h3><p>已填入默认值。本次修改只属于新实例，之后仍可继续编辑。</p>{runParameterDefinitions.map((definition) => <label className="field-label" key={definition.name}>{definition.name}<Textarea aria-label={`参数 ${definition.name}`} readOnly={busy} rows={1} value={parameterValue(runParameters, definition.name, definition.default_value)} onChange={(event) => { setRunParameterError(''); setRunParameters((current) => ({ ...current, [definition.name]: event.target.value })); }}/></label>)}</div>}</Dialog>
    <Dialog busy={busy} open={!!importDraft} onOpenChange={(open) => { if (!open) setImportDraft(null); }} title="确认导入" description="导入创建独立副本，现有模板与记录会保留。" footer={<><Button onClick={() => setImportDraft(null)}>取消</Button><Button variant="primary" disabled={busy} onClick={() => perform(async () => { if (!importDraft) return; if (importDraft.kind === 'json') { await api.mutate({ type: 'import_bundle', json: importDraft.content }); setRoute({ type: 'list' }); setNotice(`已导入 ${importDraft.templates} 个模板、${importDraft.runs} 个执行实例`); } else { const id = crypto.randomUUID(); await api.mutate({ type: 'create_template', id, name: importDraft.name.replace(/\.(runbook\.)?md$/i, '').replace(/\.markdown$/i, ''), markdown: importDraft.content }); setRoute({ type: 'template', id }); setView('templates'); setNotice('Markdown 已导入为新模板'); } setImportDraft(null); })}><Import size={15}/>导入副本</Button></>}><div className="import-summary"><FileText size={24}/><div><strong>{importDraft?.name}</strong><span>{importDraft?.kind === 'json' ? 'Runbook JSON 完整数据包' : 'Markdown 文档'} · {importDraft?.templates} 个模板 · {importDraft?.runs} 个实例</span></div></div>{importDraft?.diagnostics.length ? <div className="diagnostics"><strong>原文可保存为草稿，以下标记需要修复</strong>{importDraft.diagnostics.map((message) => <span key={message}>{message}</span>)}</div> : <p className="validation-success"><Check size={15}/>校验通过，可以导入</p>}{importDraft?.kind === 'markdown' && <div className="import-preview"><MarkdownPreview source={importDraft.content.slice(0, 5000)}/></div>}</Dialog>
    <Dialog busy={busy} open={exportOpen} onOpenChange={setExportOpen} title="导出与备份" description={selectedObject ? `当前对象：${selectedObject.name}` : '导出工作区的完整数据，在需要时恢复独立副本。'}><div className="export-options">{selectedObject && <><button disabled={busy} onClick={() => exportContent('plain')}><FileText size={21}/><div><strong>普通 Markdown</strong><span>使用默认值或本次已应用参数，移除交互标记</span></div><ArrowDownToLine size={17}/></button><button disabled={busy} onClick={() => exportContent('runbook')}><Layers size={21}/><div><strong>Runbook Markdown</strong><span>保留变量、步骤与指令，实例值作为导出副本默认值</span></div><ArrowDownToLine size={17}/></button>{selectedRun && <button disabled={busy} onClick={() => exportContent('report')}><FileCheck2 size={21}/><div><strong>执行报告 Markdown</strong><span>包含当前结论、历史轮次、回显与更正</span></div><ArrowDownToLine size={17}/></button>}</>}<button disabled={busy} onClick={() => exportContent('json')}><FileJson2 size={21}/><div><strong>完整 JSON 备份</strong><span>整个工作区的模板、实例、草稿与全部历史</span></div><ArrowDownToLine size={17}/></button></div>{selectedHasDraft && <p className="muted small">当前存在未应用草稿。Markdown 导出对应已应用流程，完整 JSON 同时保留草稿。</p>}</Dialog>
    <Dialog busy={busy} open={!!archiveTarget} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }} title="归档模板" description="已创建的执行实例保留自己的快照，不受影响。归档后可随时恢复模板。" footer={<><Button onClick={() => setArchiveTarget(null)}>取消</Button><Button variant="primary" disabled={busy} onClick={() => perform(async () => { await api.flush(); await api.mutate({ type: 'archive_template', id: archiveTarget!.id, archived: true }); setArchiveTarget(null); setNotice('模板已归档'); })}>确认归档</Button></>}><p>{archiveTarget?.name}</p></Dialog>
    <Dialog busy={busy} open={helpOpen} onOpenChange={setHelpOpen} title="从文档到可追踪的操作流程" description="整理一次，重复使用；每次维护保留独立记录。"><ol className="help-steps"><li><b>直接编辑文档</b><p>新建模板，输入正文或粘贴 Markdown。使用工具栏设置标题、列表和格式，需要时可切换到源码。</p></li><li><b>整理步骤、指令和变量</b><p>点击当前行左侧的“＋”，选择步骤、指令或检查点；也可选中文字转换。把固定内容设为变量，之后统一填写参数。</p></li><li><b>创建独立执行实例</b><p>填写本次参数，复制指令到外部工具执行，再粘贴回显，手动标记完成、失败或跳过。</p></li><li><b>记录变化，结束留档</b><p>实例可独立编辑，应用后更新本次流程。重试保留旧轮次，更正保留原结果，完成后留档或导出报告。</p></li></ol><div className="dialog-tip"><HardDrive size={18}/><span>数据保存在此设备。使用完整 JSON 定期备份，可以恢复模板、草稿和全部执行历史。</span></div></Dialog>
  </div></>;
}

function RotateIcon() { return <LoaderCircle size={15}/>; }
function TemplateCard({ template, open, create, archive, restore, busy }: { template: Template; open: () => void; create: () => void; archive: () => void; restore: () => void; busy: boolean }) {
  return <article className="template-card"><button className="template-card-open" onClick={open}><div className="template-card-top"><span className="template-icon"><BookOpen size={22}/></span><span className="type-tag">{template.archived ? '已归档' : 'MARKDOWN'}</span></div><h2>{template.name}</h2><p>{template.description || '一份可重复使用的操作流程。打开查看并整理步骤。'}</p><div className="template-card-meta"><Clock3 size={12}/>更新于 {formatTime(template.updated_at)}<span>版本 {template.applied_revision}</span></div></button><div className="template-card-actions"><Button size="sm" variant="ghost" onClick={open}>打开{template.archived ? '查看' : '编辑'}<ArrowRight size={13}/></Button>{template.archived ? <Button size="sm" disabled={busy} onClick={restore}>恢复模板</Button> : <><Button size="icon" variant="ghost" title="归档模板" aria-label={`归档 ${template.name}`} onClick={archive}><Archive size={14}/></Button><Button size="sm" className="create-run-button" disabled={busy} onClick={create}><Plus size={14}/>创建实例</Button></>}</div></article>;
}
