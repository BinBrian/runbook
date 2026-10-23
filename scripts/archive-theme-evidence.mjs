import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory='.artifacts/theme-2026-10-21';
const suites=[['theme','both','theme-report.json'],['definition-commands','light','definition-commands-check.json'],['inline-commands','light','inline-commands-check.json'],['checklist','light','checklist-check.json'],['variable-panel','dark','variable-panel-check.json'],['step-navigation','dark','step-navigation-check.json'],['slash-variables','dark','slash-variables-check.json'],['step-actions','dark','step-actions-check.json']];
const rows=[];
await mkdir(`${directory}/reports`,{recursive:true});
await mkdir(`${directory}/screenshots`,{recursive:true});
for(const [name,appearance,reportName] of suites){
  const log=await readFile(`${directory}/smoke-${name}.log`,'utf8');
  assert.ok(log.includes('Desktop verification complete; test application closed normally.'),`${name}: harness completion`);
  const testDirectory=log.match(/Isolated test data: (.+)\r?\n/)?.[1].trim(); assert.ok(testDirectory);
  const source=name==='theme'?`${directory}/${reportName}`:`.artifacts/${reportName}`;
  const report=JSON.parse(await readFile(source,'utf8'));
  assert.equal(report.directory??report.isolatedDataDirectory,testDirectory,`${name}: fresh report directory`);
  assert.deepEqual(report.pageErrors??report.errors,[],`${name}: no page errors`);
  if(name!=='theme') assert.equal(report.ok,true,`${name}: completed assertions`);
  await copyFile(source,`${directory}/reports/${reportName}`);
  rows.push({name,appearance,dataDirectory:testDirectory,report:`reports/${reportName}`,log:`smoke-${name}.log`,normalExit:true});
}
const exe=await readFile('target/debug/runbook-desktop.exe');
const html=await readFile('apps/desktop/dist/index.html','utf8');
const manifest={executable:path.resolve('target/debug/runbook-desktop.exe'),sha256:createHash('sha256').update(exe).digest('hex'),assets:[...html.matchAll(/\/assets\/([^"']+)/g)].map(m=>m[1]),suites:rows,frontendTests:155,systemClipboardVerified:false,fullProcessPreferenceRestartVerified:false,themePersistence:'WebView reload',businessDataChangedByTheme:false};
await copyFile('.artifacts/slash-long-940.png',`${directory}/screenshots/dark-variable-long-940.png`);
await writeFile(`${directory}/manifest.json`,JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
