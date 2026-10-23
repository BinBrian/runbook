// Post-exit, read-only verification of the preserved native GUI session.
// This does not replay UI or turn the failed original runner into a passing run.
// node scripts/verify-native-session.mjs --session=desktop-smoke-rDBvQh
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const requested = process.argv.find(value => value.startsWith('--session='))?.slice('--session='.length);
assert.equal(requested, 'desktop-smoke-rDBvQh', 'This corrective verifier is limited to the explicitly named isolated session');
const target = await realpath('target'), directory = await realpath(path.join(target, requested));
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
const artifacts = await realpath(path.join('.artifacts/interaction-audit/native-ui', requested));
const failurePath = path.join(artifacts, 'native-interactions-failure.json');
const failureBytes = await readFile(failurePath), receipt = JSON.parse(failureBytes.toString('utf8'));
const finalPhase = JSON.parse(await readFile(path.join(artifacts, 'native-phase.json'), 'utf8'));
const windowReceiptPath = path.join(artifacts, 'window-controls-done.json');
const windowReceipt = JSON.parse(await readFile(windowReceiptPath, 'utf8'));
const requiredPhases = ['save-template', 'open-template', 'save-instance', 'open-instance', 'window-controls', 'close-blocked', 'close-final'];
assert.deepEqual(receipt.phases.map(phase => phase.id), requiredPhases);
assert.deepEqual(receipt.pageErrors, []);
assert.equal(receipt.checks.length, 4);
assert.ok(receipt.error.includes('原生关闭后已保存'), 'Original failure must be the known final saved-name comparison');
assert.ok(receipt.error.includes('AssertionError'));
assert.equal(finalPhase.id, 'close-final');
const pid = receipt.phases[0].processId;
for (const phase of receipt.phases) {
  assert.equal(path.resolve(phase.isolatedDataDirectory).toLowerCase(), directory.toLowerCase());
  assert.equal(phase.processId, pid);
}
assert.equal(finalPhase.processId, pid);
const files = {
  template: path.join(directory, 'native-exports', '文件交互模板.runbook.json'),
  instance: path.join(directory, 'native-exports', '文件交互实例.runbook.zip'),
};
for (const kind of ['template', 'instance']) {
  const savedPhase = receipt.phases.find(phase => phase.id === 'save-' + kind);
  const openedPhase = receipt.phases.find(phase => phase.id === 'open-' + kind);
  assert.equal(path.resolve(savedPhase.path), files[kind]);
  assert.equal(path.resolve(openedPhase.path), files[kind]);
}
const python = [
  'import sqlite3,json,sys,zipfile',
  'c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)',
  'c.execute("PRAGMA query_only=ON")',
  'saved=json.loads(c.execute("SELECT body FROM checklist_workspace WHERE id=1").fetchone()[0])',
  'c.close()',
  'with open(sys.argv[2],encoding="utf-8") as f: template=json.load(f)',
  'with zipfile.ZipFile(sys.argv[3]) as z:',
  ' names=z.namelist()',
  ' archive=json.loads(z.read("runbook.json"))',
  'print(json.dumps({"workspace":saved,"templateFile":template,"archiveFile":archive,"zipEntries":names},ensure_ascii=True))',
].join('\n');
const verification = spawnSync('python', ['-c', python, path.join(directory, 'checklist.sqlite3'), files.template, files.instance], { windowsHide: true, encoding: 'utf8' });
assert.equal(verification.status, 0, verification.stderr);
assert.ok(/^[\x00-\x7f]*$/.test(verification.stdout), 'The corrected transport must emit only ASCII JSON escapes');
const data = JSON.parse(verification.stdout);
const document = { groups: [], parameters: [], steps: [{ id: 'native-check', title: ['核对维护文件'], description: ['本流程只验证文件和窗口交互。'], commands: [{ id: 'native-command', text: ['echo 本地交互验证'] }] }] };
const sourceTemplate = data.workspace.templates.find(item => item.id === 'native-file-template');
const sourceInstance = data.workspace.instances.find(item => item.id === 'native-file-instance');
assert.ok(sourceTemplate && sourceInstance);
assert.equal(sourceTemplate.name, '原生关闭后已保存');
assert.deepEqual(sourceTemplate.document, document);
assert.deepEqual(sourceInstance.document, document);
assert.equal(sourceInstance.status, 'in_progress');
assert.equal(sourceInstance.currentStepId, 'native-check');
assert.ok(sourceInstance.entries.some(entry => entry.type === 'comment' && entry.text === '原生关闭保护验证'));
assert.equal(data.templateFile.id, 'native-file-template');
assert.equal(data.templateFile.name, '文件交互模板');
assert.deepEqual(data.templateFile.document, document);
assert.equal(data.archiveFile.id, 'native-file-instance');
assert.equal(data.archiveFile.status, 'in_progress');
assert.deepEqual(data.archiveFile.document, document);
assert.deepEqual(data.archiveFile.entries, []);
assert.deepEqual(data.zipEntries, ['runbook.json']);
// Native duplicate import deliberately names each copy with this suffix
// (store.rs import commit); the initial verifier incorrectly expected no suffix.
const templateCopies = data.workspace.templates.filter(item => item.id !== sourceTemplate.id && item.name === data.templateFile.name + '（导入副本）');
const instanceCopies = data.workspace.instances.filter(item => item.id !== sourceInstance.id && item.name === data.archiveFile.name + '（导入副本）');
assert.equal(templateCopies.length, 1); assert.equal(instanceCopies.length, 1);
assert.deepEqual(templateCopies[0].document, document);
assert.deepEqual(instanceCopies[0].document, document);
assert.deepEqual(instanceCopies[0].entries, data.archiveFile.entries);
assert.equal(instanceCopies[0].status, data.archiveFile.status);
const screenshots = ['native-export-template.png', 'native-import-template-preview.png', 'native-export-instance.png', 'native-import-instance-preview.png', 'native-close-blocked.png'];
const screenshotEvidence = [];
for (const name of screenshots) {
  const file = path.join(artifacts, name), info = await stat(file);
  assert.ok(info.size > 0);
  screenshotEvidence.push({ path: file, bytes: info.size });
}
const artifactsVerified = [];
for (const [kind, file] of Object.entries(files)) {
  const bytes = await readFile(file);
  artifactsVerified.push({ kind, path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const dragPassed = windowReceipt.drag?.passed === true;
const result = {
  ok: dragPassed, status: dragPassed ? 'passed-composite' : 'partial',
  mode: 'composite-native-GUI-receipts-plus-corrected-post-exit-read-only-verification',
  verifiedAt: new Date().toISOString(), isolatedDataDirectory: directory,
  originalRunner: {
    status: 'failed', originalRunnerExitZeroClaimed: false, failureReceipt: failurePath,
    failureReceiptSha256: createHash('sha256').update(failureBytes).digest('hex'),
    originalError: receipt.error,
    correction: '仅修正最终 Python stdout 的编码输出为 ensure_ascii=True；不重跑或改写已经完成的 GUI 证据。',
  },
  correctiveVerifierFixture: {
    initialError: '副本定位误按原名称筛选，导致 0 !== 1；并非导入数据丢失。',
    correctedRule: '按原生 store.rs:545/561 的“（导入副本）”后缀精确识别模板和实例副本；仍要求各一个、独立 ID、文档与记录严格一致。',
  },
  nativeProcessExit: {
    code: 0, directlyRecordedInFailureReceipt: false,
    evidence: '原 runner 的已保存名称比较位于 await exited / assert.equal(code,0) 之后；本次失败确在该比较，故 native 子进程退出检查已通过。原 runner 本身仍失败。',
  },
  nativeGui: { phases: receipt.phases, recordedChecks: receipt.checks, screenshots: screenshotEvidence, pageErrors: receipt.pageErrors },
  postExitReadOnly: {
    ok: true, sqliteUriMode: 'ro', pragmaQueryOnly: true, pythonJsonEnsureAscii: true,
    checks: [
      '原模板名称确为“原生关闭后已保存”，文本在 SQLite 中没有乱码。',
      '关闭前提交的“原生关闭保护验证”评论确已保存到来源实例。',
      '来源模板和来源实例保持完整且未被重复导入覆盖。',
      '实际导出的 JSON 与 ZIP 均含预期文档，ZIP 的 runbook.json 可直接读取。',
      '模板和实例各存在一个独立导入副本，其文档、状态和导出时记录完整。',
    ],
    sourceTemplateId: sourceTemplate.id, sourceInstanceId: sourceInstance.id,
    importedTemplateId: templateCopies[0].id, importedInstanceId: instanceCopies[0].id,
    exportFiles: artifactsVerified,
  },
  windowControls: {
    sourceReceipt: windowReceiptPath, recordedChecks: windowReceipt.checks,
    normalGeometry: windowReceipt.normalGeometry, maximizedGeometry: windowReceipt.maximizedGeometry,
    restoredGeometry: windowReceipt.restoredGeometry, dragGeometry: windowReceipt.dragGeometry,
    drag: windowReceipt.drag,
    status: dragPassed ? 'all-recorded-checks-passed' : 'partial-drag-attempt-did-not-move-window',
  },
  limitations: [
    '组合报告保留并引用原始 GUI 记录，不声称原 runner 成功退出。',
    '窗口拖动沿用原始 passed:false 结果，原因尚未确认；不得写成通过或仅归因于自动化。',
    '离线脚本不重新打开窗口、不进行 UI 操作、不执行维护命令、不访问系统剪贴板。',
    '本次修正仅适用于明确指定的 rDBvQh 隔离库。',
  ],
  maintenanceCommandsExecuted: false, osClipboardTouched: false,
};
await writeFile(path.join(artifacts, 'native-interactions-check.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ status: result.status, nativeGuiFileDialogsRecorded: 4, postExitReadOnlyVerified: true, windowDragPassed: dragPassed, originalRunnerStatus: 'failed', resultPath: path.join(artifacts, 'native-interactions-check.json') }));
