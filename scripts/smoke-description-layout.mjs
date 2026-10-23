// Only the harness-owned workspace; commands remain inert text.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const actual=await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target=await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(),target.toLowerCase()); assert.match(path.basename(actual),/^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.equal(process.env.RUNBOOK_DATA_DIR,process.env.RUNBOOK_TEST_DATA_DIR);
const browser=await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page=browser.contexts()[0].pages()[0]; page.setDefaultTimeout(10000);
const output=process.env.RUNBOOK_LAYOUT_EVIDENCE_DIR??'.artifacts/description-layout-2026-10-21'; await mkdir(output,{recursive:true});
const errors=[], geometries=[]; page.on('pageerror',error=>errors.push(error.message));
const native=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const apply=action=>native('checklist_apply',{action}), workspace=()=>native('checklist_load');
const fixture=grouped=>({groups:grouped?[{id:'layout-group',name:'测试服更新',description:'按顺序核对。'}]:[],parameters:[{id:'layout-env',...(grouped?{ownerId:'layout-group'}:{}),name:'操作环境',defaultValue:'release',description:'只供复制。'}],steps:[
  {id:'layout-first',...(grouped?{groupId:'layout-group'}:{}),title:['前一天 · 设置维护时间'],description:['本次环境：',{parameterId:'layout-env'},'\n维护窗口：08:00 至 09:00\n核对本次维护窗口后复制命令，在外部工具操作。'],commands:[{id:'layout-command',text:['maintain ',{parameterId:'layout-env'},' GameServer 08:00 09:00']}]},
  {id:'layout-second',...(grouped?{groupId:'layout-group'}:{}),title:['后续核验'],description:[''],commands:[]},
]});
const contexts=[{kind:'template',id:'layout-template',name:'模板',document:fixture(false)},{kind:'block',id:'layout-block',name:'步骤块',document:fixture(true)},{kind:'instance',id:'layout-instance',name:'当前工作'},{kind:'instance',id:'layout-running',name:'当前工作'}];
const step=()=>page.locator('[data-step-id="layout-first"]');
const description=()=>step().locator('[data-inline-field="操作说明"]');
async function open(context){
  await page.locator('.app-sidebar nav button').filter({hasText:context.name}).click();
  await page.locator(`[data-${context.kind}-id="${context.id}"]${context.kind==='instance'?'':' .tile-open'}`).click();
  if(context.kind==='instance' && !await description().count()) await step().getByRole('button',{name:'展开步骤 1',exact:true}).first().click();
  await expect(description()).toBeVisible();
}
async function theme(value){if(await page.locator('html').getAttribute('data-theme')!==value)await page.locator('.theme-switcher').click();await expect(page.locator('html')).toHaveAttribute('data-theme',value);}
async function measure(context,state,value,size){
  const geometry=await step().evaluate(node=>{
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const desc=node.querySelector('[data-inline-field="操作说明"]'), command=node.querySelector('[data-command-id="layout-command"]'), editor=desc.querySelector('[contenteditable]');
    const root=node.closest('.workspace-scroll'), style=getComputedStyle(desc);
    return {description:rect(desc),command:rect(command),editor:editor?rect(editor):null,workspace:rect(root),gap:command.getBoundingClientRect().top-desc.getBoundingClientRect().bottom,marginTop:style.marginTop,marginBottom:style.marginBottom,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  geometries.push({kind:context.kind,id:context.id,theme:value,width:size.width,state,...geometry});
  assert.ok(geometry.gap>=12,`${context.id}/${value}/${size.width}/${state}: description must leave a visible gap, got ${geometry.gap}px`);
  assert.ok(geometry.description.right<=geometry.workspace.right+1 && geometry.description.left>=geometry.workspace.left-1,'Description stays inside its workspace');
  assert.ok(geometry.documentWidth<=geometry.viewport+1,'Root must not overflow horizontally');
  if(state==='hover'||state==='editing')await page.screenshot({path:`${output}/${context.id}-${value}-${size.width}-${state}.png`});
}
try{
  for(const context of contexts.filter(c=>c.document))await apply({type:context.kind==='block'?'create_block':'create_template',id:context.id,name:`QA 说明布局 · ${context.name}`,document:context.document});
  for(const context of contexts.filter(c=>c.kind==='instance'))await apply({type:'create_instance',id:context.id,name:`QA 说明布局 · ${context.id}`,templateId:'layout-template',fromInstanceId:null});
  await apply({type:'start_instance',id:'layout-running'});
  await page.reload();
  for(const context of contexts){
    await open(context); const before=await workspace();
    for(const size of [{width:1360,height:940},{width:940,height:640}]){
      await page.setViewportSize(size);
      for(const value of ['dark','light']){
        await theme(value); await page.mouse.move(1,1); await description().scrollIntoViewIfNeeded(); await measure(context,'display',value,size);
        await description().hover(); await measure(context,'hover',value,size);
        await description().focus(); await measure(context,'focus',value,size);
        await description().dblclick(); await expect(description().getByRole('textbox')).toBeVisible(); await measure(context,'editing',value,size);
        await description().getByRole('textbox').press('Escape'); await measure(context,'finished',value,size);
      }
    }
    assert.deepEqual(await workspace(),before,'Inspecting/entering/leaving description editing must not change data');
  }
  await apply({type:'record_result',id:'layout-running',outcome:'completed',reason:null}); await page.reload();
  const running=contexts.at(-1); await open(running); const frozenBefore=await workspace();
  for(const size of [{width:1360,height:940},{width:940,height:640}]){await page.setViewportSize(size);for(const value of ['dark','light']){await theme(value);await description().hover();await expect(description()).toHaveClass(/is-readonly/);await measure(running,'readonly',value,size);}}
  assert.deepEqual(await workspace(),frozenBefore); assert.deepEqual(errors,[]);
  await writeFile(`${output}/report.json`,JSON.stringify({ok:true,dataDirectory:actual,geometries,errors,clipboardTouched:false},null,2));
  console.log(JSON.stringify({ok:true,dataDirectory:actual,cases:geometries.length,errors}));
}catch(error){await page.screenshot({path:`${output}/failure.png`});await writeFile(`${output}/failure.json`,JSON.stringify({error:String(error),dataDirectory:actual,geometries,errors},null,2));throw error;}
finally{await browser.close();}
