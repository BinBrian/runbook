import type { Run, Workspace } from '@runbook/contracts';

/** Isolated display fixture. Never sent to the native API or persisted. */
export function previewWorkspace(): Workspace {
  const timestamp = '2026-10-13T06:30:00Z';
  const specs = [
    { id: '11111111-1111-4111-8111-111111111111', title: '确认维护窗口', body: '确认维护时间、当前环境与负责人。\n\n- [x] 已确认维护窗口\n- [x] 已通知相关负责人', command: "Write-Output '已确认维护窗口'" },
    { id: '22222222-2222-4222-8222-222222222222', title: '核对补丁包', body: '查看补丁文件摘要，人工核对预期值。\n\n确保文件名称与本次维护工单一致，校验结果符合预期后再继续。', command: "Get-FileHash -LiteralPath 'C:\\RunbookExample\\patch.zip' `\n  -Algorithm SHA256" },
    { id: '33333333-3333-4333-8333-333333333333', title: '备份当前版本', body: '确认已保留可用的回退文件，并记录备份位置。', command: '' },
    { id: '44444444-4444-4444-8444-444444444444', title: '检查服务状态', body: '在外部工具完成检查，确认服务状态与预期一致。', command: '' },
    { id: '55555555-5555-4555-8555-555555555555', title: '记录维护结论', body: '记录本次维护的检查结果和遗留事项。', command: '' },
  ];
  let markdown = '# 补丁维护流程\n\n示例流程，仅用于只读界面预览。\n\n<!-- runbook:document version="1" -->\n\n';
  const byteLength = (text: string) => new TextEncoder().encode(text).length;
  const definitions = specs.map((spec, index) => {
    const start = byteLength(markdown);
    const commandId = `${index + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const beforeCommand = `<!-- runbook:step id="${spec.id}" -->\n\n## ${spec.title}\n\n${spec.body}\n\n`;
    const commandPrefix = spec.command ? `<!-- runbook:command id="${commandId}" -->\n\n` : '';
    const fence = spec.command ? '```powershell\n' + spec.command + '\n```\n' : '';
    const body = `${beforeCommand}${commandPrefix}${fence}\n<!-- /runbook:step -->\n\n`;
    const commandStart = start + byteLength(beforeCommand + commandPrefix);
    markdown += body;
    return { id: spec.id, title: spec.title, markdown: `## ${spec.title}\n\n${spec.body}\n\n${commandPrefix}${fence}`, commands: spec.command ? [{ id: commandId, language: 'powershell', text: spec.command, start: commandStart, end: commandStart + byteLength(fence) }] : [], start, end: byteLength(markdown), content_hash: `preview-${index}` };
  });
  const run: Run = { id: 'preview-run', name: '生产环境补丁维护 · 10月13日', context: '维护窗口 14:00–15:00 · 补丁校验与服务检查', source_template_id: 'preview-template', initial_template_snapshot: { template_id: 'preview-template', name: '生产环境补丁维护', revision: 3, markdown, parameters: {} }, parameters: {}, draft_parameters: {}, draft_markdown: markdown, applied_markdown: markdown, revision: 7, applied_revision: 1, created_at: timestamp, updated_at: timestamp, closed_at: null, summary_note: '', selected_step_id: specs[1].id, summary: { pending: 4, active: 0, completed: 1, failed: 0, skipped: 0, removed: 0, conclusion: 'incomplete' }, steps: definitions.map((definition, index) => ({ step_id: definition.id, content_version: 1, position: index, present: true, definition, status: index === 0 ? 'completed' : 'pending', attempts: index === 0 ? [{ id: 'preview-attempt', attempt_no: 1, content_version: 1, document_revision: 1, step_snapshot: definition, parameters: {}, outcome: 'completed', output_text: '已确认维护窗口', note: '已确认本次维护范围和负责人。', created_at: timestamp, finished_at: timestamp, annotations: [] }] : [] })) };
  return { templates: [ { id: 'preview-template', name: '生产环境补丁维护', description: '按步骤完成维护窗口确认、补丁核对和服务检查。', draft_markdown: markdown, applied_markdown: markdown, revision: 3, applied_revision: 3, source_hash: 'preview', created_at: timestamp, updated_at: timestamp, archived: false }, { id: 'preview-template-2', name: '每日服务巡检', description: '把日常检查整理为清晰、可复用的操作流程。', draft_markdown: markdown, applied_markdown: markdown, revision: 1, applied_revision: 1, source_hash: 'preview', created_at: timestamp, updated_at: timestamp, archived: false } ], runs: [run] };
}
