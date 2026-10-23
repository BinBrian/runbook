// Native workspace + real WebView2, always in the harness-owned data directory.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory=await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target=await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(),target.toLowerCase());assert.match(path.basename(directory),/^desktop-smoke-[A-Za-z0-9_-]+$/);assert.equal(process.env.RUNBOOK_DATA_DIR,process.env.RUNBOOK_TEST_DATA_DIR);
const browser=await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL),page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(12000);
const output='.artifacts/variable-locate-2026-10-21';await mkdir(output,{recursive:true});const checks=[],errors=[],geometry=[];page.on('pageerror',e=>errors.push(e.message));
const native=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args}), apply=action=>native('checklist_apply',{action}), workspace=()=>native('checklist_load');
const ref=parameterId=>({parameterId}), templateId='locate-template',runId='locate-run',blockId='locate-block';
const doc={groups:[{id:'group-a',name:'示例环境A'},{id:'group-b',name:'示例环境B'}],parameters:[
 {id:'global-env',name:'环境',description:'整个流程',defaultValue:'GLOBAL'},
 ...Array.from({length:24},(_,i)=>({id:`filler-${i}`,name:`全局备注 ${i}`,description:'用于真实面板滚动',defaultValue:`note-${i}`})),
 {id:'local-a',ownerId:'group-a',name:'环境',description:'示例环境A组',defaultValue:'sandboxa'},
 {id:'local-b',ownerId:'group-b',name:'环境',description:'示例环境B组',defaultValue:'sandboxb'},
 {id:'step-a-var',ownerId:'step-a',name:'区服',description:'本步骤',defaultValue:'201'}],steps:[
 {id:'step-a',groupId:'group-a',title:['更新 ',ref('local-a')],description:['全局：',ref('global-env'),'\n区服：',ref('step-a-var')],commands:[{id:'command-a',text:['publishgame ',ref('local-a'),' --global ',ref('global-env')]}]},
 {id:'step-b',groupId:'group-b',title:['核验 ',ref('local-b')],description:['当前组：',ref('local-b')],commands:[{id:'command-b',text:['check ',ref('local-b'),' --global ',ref('global-env')]}]}
]};
const step=id=>page.locator(`[data-step-id="${id}"]`),panel=()=>page.getByRole('complementary',{name:'变量面板',exact:true}), form=()=>panel().getByRole('dialog',{name:'编辑变量定义',exact:true}), defaultInput=()=>form().getByRole('textbox',{name:'变量默认值',exact:true});
const token=(stepId,paramId,field='命令 1')=>step(stepId).locator(`[data-inline-field="${field}"] .variable-token[data-parameter-id="${paramId}"]`).first();
const row=id=>panel().locator(`[data-variable-id="${id}"]`), value=id=>row(id).locator('input[data-parameter-id]');
const template=async()=> (await workspace()).templates.find(t=>t.id===templateId), run=async()=> (await workspace()).instances.find(t=>t.id===runId);
async function open(kind,id){await page.locator('.app-sidebar nav button').filter({hasText:kind==='template'?'模板':kind==='block'?'步骤块':'当前工作'}).click();await page.locator(`[data-${kind}-id="${id}"]${kind==='instance'?'':' .tile-open'}`).click();}
async function locateStep(id){await page.locator(`[data-nav-step-id="${id}"]`).click();await expect(panel()).toHaveAttribute('data-variable-target-step-id',id);}
async function cancel(){await form().getByRole('button',{name:'取消',exact:true}).click();await expect(form()).toHaveCount(0);}
async function capture(name){
 const m=await panel().evaluate(node=>{const r=node.getBoundingClientRect(),f=document.activeElement?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,rootWidth:document.documentElement.scrollWidth,bodyScroll:[scrollX,scrollY],panel:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},focus:f?{left:f.left,right:f.right,top:f.top,bottom:f.bottom}:null,activeName:document.activeElement?.getAttribute('aria-label')};});
 assert.ok(m.rootWidth<=m.width+1);assert.deepEqual(m.bodyScroll,[0,0]);assert.ok(m.focus&&m.focus.left>=m.panel.left&&m.focus.right<=m.panel.right+1&&m.focus.top>=m.panel.top&&m.focus.bottom<=m.panel.bottom+1,`${name}: focused editor stays visible in the panel`);
 geometry.push({name,...m});await page.screenshot({path:`${output}/${name}.png`});
}
try{
 await apply({type:'create_template',id:templateId,name:'QA 点击变量定位',document:doc});
 await apply({type:'create_instance',id:runId,name:'QA 本次变量定位',templateId,fromInstanceId:null});await apply({type:'start_instance',id:runId});await apply({type:'record_result',id:runId,outcome:'failed',reason:'保留原始变量快照'});
 await apply({type:'create_block',id:blockId,name:'QA 块变量定位',document:{groups:[{id:'block-group',name:'更新测试服'}],parameters:[{id:'block-env',ownerId:'block-group',name:'环境',description:'块局部',defaultValue:'sandboxd'}],steps:[{id:'block-step',groupId:'block-group',title:['更新'],description:[''],commands:[{id:'block-command',text:['publishgame ',ref('block-env')]}]}]}});
 await page.reload();await page.setViewportSize({width:1360,height:940});await open('template',templateId);await locateStep('step-a');
 for(const [label,ownerId] of [['新增全局变量',undefined],['新增步骤组变量','group-a'],['新增步骤变量','step-a']]){
   const button=panel().getByRole('button',{name:label,exact:true});await expect(button).toBeEnabled();await expect(button).toContainText('新增');await button.click();
   const add=panel().getByRole('dialog',{name:'新增变量',exact:true});await add.getByRole('textbox',{name:'变量名称',exact:true}).fill(label);await add.getByRole('textbox',{name:'变量默认值',exact:true}).fill('新增默认值');await add.getByRole('button',{name:'保存变量',exact:true}).click();
   await expect.poll(async()=>Boolean((await template()).document.parameters.find(p=>p.name===label&&p.ownerId===ownerId))).toBe(true);
 }
 checks.push('Template global/group/step headers expose visible +新增 buttons and create parameters with the correct owner');
 const beforeLookup=await workspace();await panel().getByRole('searchbox',{name:'搜索变量'}).fill('NO_MATCH');await panel().getByRole('button',{name:'收起变量面板'}).click();
 await token('step-a','local-a').click();await expect(defaultInput()).toBeFocused();await expect(defaultInput()).toHaveValue('sandboxa');await expect(form()).toContainText('示例环境A');await expect(panel().getByRole('searchbox')).toHaveValue('');assert.deepEqual(await workspace(),beforeLookup);await capture('template-group-default');
 await defaultInput().fill('sandboxa-draft');await token('step-a','local-a').click();await expect(defaultInput()).toHaveValue('sandboxa-draft');
 // Another group with the same name must not replace the unsubmitted definition.
 await token('step-b','local-b').click();await expect(defaultInput()).toHaveValue('sandboxa-draft');await expect(form()).toContainText('示例环境A');await expect(panel()).toContainText('请先保存或取消');assert.deepEqual(await workspace(),beforeLookup);
 await form().getByRole('button',{name:'保存变量',exact:true}).click();await expect.poll(async()=>(await template()).document.parameters.find(p=>p.id==='local-a').defaultValue).toBe('sandboxa-draft');assert.equal((await template()).document.parameters.find(p=>p.id==='local-b').defaultValue,'sandboxb');
 await token('step-b','local-b').focus();await token('step-b','local-b').press('Enter');await expect(defaultInput()).toBeFocused();await expect(defaultInput()).toHaveValue('sandboxb');await expect(form()).toContainText('示例环境B');await cancel();
 await token('step-a','global-env','操作说明').click();await expect(defaultInput()).toBeFocused();await expect(defaultInput()).toHaveValue('GLOBAL');await expect(form()).toContainText('全局变量');await cancel();
 await token('step-a','step-a-var','操作说明').click();await expect(defaultInput()).toHaveValue('201');await expect(form()).toContainText('当前步骤');await cancel();
 checks.push('Click/Enter resolves stable IDs across same-name scopes, opens collapsed/filtered panels, focuses defaults, preserves same-form drafts and protects a different pending definition');
 for(const size of [{width:1360,height:940},{width:940,height:640}]){await page.setViewportSize(size);for(const theme of ['dark','light']){if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('.theme-switcher').click();await token('step-b','local-b').click();await expect(defaultInput()).toBeFocused();await capture(`definition-${theme}-${size.width}`);await cancel();}}
 await page.setViewportSize({width:1360,height:940});await locateStep('step-a');
 const command=step('step-a').locator('[data-inline-field="命令 1"]');await command.dblclick({position:{x:5,y:8}});const editor=step('step-a').getByRole('textbox',{name:'命令 1',exact:true});await expect(editor).toBeVisible();
 const beforeEditing=await workspace();await token('step-a','local-a').click();await expect(defaultInput()).toBeFocused();await expect(editor).toBeVisible();await cancel();assert.deepEqual(await workspace(),beforeEditing);
 // Return keyboard focus to the raw DOM token, not the contenteditable text.
 await token('step-a','local-a').focus();await token('step-a','local-a').press('Space');await expect(defaultInput()).toBeFocused();await cancel();
 // Dragging a token must keep selection behavior instead of opening a form.
 const box=await token('step-a','local-a').boundingBox();assert.ok(box);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width+60,box.y+box.height/2,{steps:8});await page.mouse.up();await expect(form()).toHaveCount(0);assert.deepEqual(await workspace(),beforeEditing);
 await token('step-b','local-b').click();await expect(defaultInput()).toBeFocused();await expect(defaultInput()).toHaveValue('sandboxb');await expect(form()).toContainText('示例环境B');await cancel();
 checks.push('Raw editor tokens support mouse/Space lookup without content writes, drag selection does not open editing, and another group wins over an old active editor');
 await open('block',blockId);await step('block-step').locator('.variable-token').click();await expect(defaultInput()).toBeFocused();await expect(defaultInput()).toHaveValue('sandboxd');await expect(panel().getByRole('button',{name:'新增步骤组变量'})).toContainText('新增');await cancel();
 await open('instance',runId);await locateStep('step-b');const original=await run();await panel().getByRole('searchbox').fill('NO_MATCH');await panel().getByRole('button',{name:'收起变量面板'}).click();
 await token('step-b','local-b').click();await expect(value('local-b')).toBeFocused();await expect(value('local-b')).toHaveValue('sandboxb');await expect(row('local-b')).toHaveAttribute('data-variable-highlighted','true');await expect(form()).toHaveCount(0);
 await value('local-b').fill('sandboxb-draft');assert.deepEqual(await run(),original);await token('step-b','local-b').click();await expect(value('local-b')).toHaveValue('sandboxb-draft');await expect(value('local-b')).toBeFocused();
 await locateStep('step-a');await token('step-a','local-a').click();await expect(value('local-a')).toBeFocused();await locateStep('step-b');await token('step-b','local-b').click();await expect(value('local-b')).toHaveValue('sandboxb-draft');await capture('instance-pending-group');assert.deepEqual(await run(),original);
 await panel().getByRole('button',{name:'应用本组参数',exact:true}).click();await expect.poll(async()=>(await run()).parameterValues['local-b']).toBe('sandboxb-draft');assert.deepEqual((await run()).entries,original.entries);assert.equal((await run()).currentStepId,'step-a');
 checks.push('Instance lookup focuses the correct group input, preserves unapplied drafts across scopes, does not auto-apply or advance, and explicit scope application preserves old failure snapshots');
 await apply({type:'terminate_instance',id:runId,reason:'QA 只读定位'});await page.reload();await open('instance',runId);await locateStep('step-b');const ended=await workspace();await token('step-b','local-b').click();await expect(value('local-b')).toBeFocused();await expect(value('local-b')).toHaveAttribute('readonly','');await expect(form()).toHaveCount(0);assert.deepEqual(await workspace(),ended);
 checks.push('Ended instances only locate the readonly applied value, without reopening editing or changing history');
 assert.deepEqual(errors,[]);await writeFile(`${output}/report.json`,JSON.stringify({ok:true,directory,checks,geometry,errors,clipboardTouched:false},null,2));console.log(JSON.stringify({ok:true,directory,checks,errors}));
}catch(error){await page.screenshot({path:`${output}/failure.png`});await writeFile(`${output}/failure.json`,JSON.stringify({error:String(error),directory,checks,geometry,errors},null,2));throw error;}finally{await browser.close();}
