import { openCommentComposer } from './step-materials.mjs';
// node scripts/check-desktop.mjs scripts/smoke-theme.mjs
// Only harness-owned records. No system clipboard or maintenance command execution.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const actual = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const evidence = process.env.RUNBOOK_THEME_EVIDENCE_DIR ?? '.artifacts/theme-2026-10-21', checks = [], screenshots = [], metrics = [], errors = [];
await mkdir(evidence, { recursive: true }); page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const apply = action => native('checklist_apply', {action}), workspace = () => native('checklist_load');
const ref = parameterId => ({parameterId});
const document = {
  groups:[{id:'theme-group',name:'测试服更新',description:'核对操作对象，逐步确认并保留记录。'}],
  parameters:[{id:'theme-env',name:'操作环境',description:'本次维护的目标环境',defaultValue:'sandboxa'}, {id:'theme-group-var',ownerId:'theme-group',name:'维护对象',description:'当前步骤组',defaultValue:'测试服'}, {id:'theme-local',ownerId:'theme-3',name:'检查关键词',description:'当前步骤使用',defaultValue:'Already'}],
  steps:[1,2,3,4].map(n => ({id:`theme-${n}`,groupId:'theme-group',title:[['核对维护窗口','等待备份完成','停止测试服','核对服务注册'][n-1]],description:['在外部控制台操作后，核对服务状态并记录结果。'],commands:[{id:`theme-command-${n}`,text:[n===3?'stopserver ':'check ', ref('theme-env'),' all']}]})),
};
const step = n => page.locator(`[data-step-id="theme-${n}"]`);
const switcher = () => page.locator('button.theme-switcher');
async function theme(value) {
  await expect(switcher()).toHaveCount(1);
  if(await page.locator('html').getAttribute('data-theme')!==value) await switcher().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',value);
  await expect(switcher()).toHaveAttribute('aria-label',value==='dark'?'切换为纯白':'切换为暗夜');
  assert.equal(await switcher().innerText(),'');
  await expect(switcher().locator(value==='dark'?'svg.lucide-moon':'svg.lucide-sun')).toHaveCount(1);
  if(await page.locator('.is-current>.step-card-heading').count()) await expect.poll(()=>page.evaluate(()=>getComputedStyle(window.document.querySelector('.result-actions .primary')).backgroundColor===getComputedStyle(window.document.querySelector('.is-current>.step-card-heading'),'::before').backgroundColor)).toBe(true);
}
async function openRun() { await page.locator('.app-sidebar nav button').filter({hasText:'当前工作'}).click(); await page.locator('[data-instance-id="theme-run"]').click(); await expect(step(3).locator('.result-actions')).toBeVisible(); }
async function shot(name) { const filename=`${evidence}/${name}.png`; await page.screenshot({path:filename}); screenshots.push(filename); }
async function inspect(name) {
  const value = await page.evaluate(() => {
    const css = selector => { const node = window.document.querySelector(selector); assertNode(node,selector); const s=getComputedStyle(node); return {fg:s.color,bg:s.backgroundColor,border:s.borderColor,opacity:s.opacity}; };
    function assertNode(node, selector) { if (!node) throw Error(`Missing ${selector}`); }
    const rect = selector => { const node=window.document.querySelector(selector); const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}; };
    const roles=Object.fromEntries(['surface','surface-panel','surface-subtle','surface-raised','text','text-secondary','text-placeholder','accent','accent-text','success','success-soft','failure','failure-soft','warning','warning-soft'].map(key=>[key,getComputedStyle(window.document.documentElement).getPropertyValue(`--${key}`).trim()]));
    return {theme:window.document.documentElement.dataset.theme,viewport:{width:innerWidth,height:innerHeight},rootWidth:window.document.documentElement.scrollWidth,scroll:[scrollX,scrollY],roles,
      primary:css('.result-actions .primary'),failureAction:css('.result-actions .button:not(.primary)'),title:css('.is-current .inline-editable.is-title'),command:css('.is-current .inline-command'),toolbar:css('.is-current .command-card-actions'),token:css('.is-current .variable-token'),
      marker:getComputedStyle(window.document.querySelector('.is-current>.step-card-heading'),'::before').backgroundColor,
      nav:['completed','skipped','failed','pending'].map(status=>({status,...css(`[data-nav-status="${status}"] .step-nav-indicator`)})),
      frame:rect('.workspace-with-navigation'),panel:rect('.variable-panel'),bar:rect('.app-topbar'),appearance:rect('.appearance-control'),workspace:rect('.workspace-scroll'),controls:rect('.window-controls')};
  });
  function rgb(color) { if(color.startsWith('#')) { const hex=color.length===4?color.slice(1).split('').map(c=>c+c).join(''):color.slice(1); return hex.match(/../g).slice(0,3).map(v=>parseInt(v,16)); } return color.match(/[\d.]+/g).slice(0,3).map(Number); }
  function luminance(c) { return rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0); }
  function ratio(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
  value.contrast={}; metrics.push({name,...value});
  for(const [fg,bg] of [['text','surface'],['text-secondary','surface-panel'],['text-secondary','surface-subtle'],['text-placeholder','surface'],['accent-text','accent'],['success','success-soft'],['failure','failure-soft'],['warning','warning-soft']]){
    const contrast=ratio(value.roles[fg],value.roles[bg]); value.contrast[`${fg}/${bg}`]=contrast; assert.ok(contrast>=4.5,`${name} ${fg}/${bg}: ${contrast}`);
  }
  assert.equal(value.primary.bg, `rgb(${rgb(value.roles.accent).join(', ')})`);
  assert.equal(value.title.fg, `rgb(${rgb(value.roles.text).join(', ')})`);
  assert.equal(value.marker, value.primary.bg); assert.notEqual(value.failureAction.bg,value.primary.bg);
  assert.notEqual(value.nav[2].bg,value.primary.bg,'Failed current status stays distinct from the current marker');
  for(const current of [value.command,value.toolbar,value.token]){ const channels=rgb(current.bg); assert.ok(Math.max(...channels)-Math.min(...channels)<=3,`${name}: command/variables remain neutral`); }
  assert.equal(value.rootWidth,value.viewport.width); assert.deepEqual(value.scroll,[0,0]);
  for(const key of ['panel','bar','appearance','workspace','controls']){const r=value[key];assert.ok(r.width>0 && r.x>=0 && r.right<=value.viewport.width+1,`${name}: ${key} in viewport`);}
  assert.ok(value.appearance.right<=value.controls.x,`${name}: appearance does not overlap window controls`);
  assert.ok(value.workspace.width>=320,`${name}: readable workflow width`);
}
try {
  await page.setViewportSize({width:1360,height:940});
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await apply({type:'create_template',id:'theme-template',name:'周末补丁维护',document});
  await apply({type:'create_instance',id:'theme-run',name:'周末补丁维护 · 交互验收',templateId:'theme-template',fromInstanceId:null});
  await apply({type:'start_instance',id:'theme-run'});
  await apply({type:'record_result',id:'theme-run',outcome:'completed',reason:null});
  await apply({type:'record_result',id:'theme-run',outcome:'skipped',reason:'本次无备份任务'});
  await apply({type:'record_result',id:'theme-run',outcome:'failed',reason:'服务尚未完全停止，等待核对'});
  await page.reload(); await openRun();
  const baseline=await workspace();
  for(const size of [{width:1360,height:940},{width:940,height:640}]){
    await page.setViewportSize(size);
    for(const value of ['light','dark']){await theme(value); await inspect(`${value}-${size.width}`); await shot(`${value}-${size.width}`);}
  }
  assert.deepEqual(await workspace(),baseline); checks.push('Light/dark at 1360×940 and 940×640; neutral command/variable surfaces, contrast >=4.5, independent failed/current markers, no horizontal overflow or business writes');
  await page.setViewportSize({width:1360,height:940});
  await openCommentComposer(step(3));
  const comment=step(3).getByRole('textbox',{name:'添加评论',exact:true}); await comment.fill('主题切换保留未提交评论');
  const input=page.locator('[data-variable-id="theme-env"] .variable-instance-value input'); await input.fill('preview-draft');
  const command=step(3).locator('[data-command-id="theme-command-3"] [data-inline-field]'); await command.dblclick();
  const editor=step(3).getByRole('textbox',{name:'命令 1',exact:true}); await expect(editor).toBeVisible();
  await editor.press('End'); await page.keyboard.type(' --note');
  const editorText=await editor.innerText(), caret=await editor.evaluate(()=>{const s=getSelection();return [s.anchorOffset,s.focusOffset];});
  await theme('light'); await expect(editor).toBeFocused(); assert.equal(await editor.innerText(),editorText); assert.deepEqual(await editor.evaluate(()=>{const s=getSelection();return [s.anchorOffset,s.focusOffset];}),caret);
  await theme('dark'); await expect(comment).toHaveValue('主题切换保留未提交评论'); await expect(input).toHaveValue('preview-draft');
  assert.equal((await workspace()).instances[0].parameterValues['theme-env'],'sandboxa');
  checks.push('Mouse appearance switching preserves editor focus/caret, command buffer, explicit comment and unapplied parameter values');
  await editor.press('End'); await page.keyboard.type(' {{操作'); await expect(page.getByRole('listbox',{name:'变量建议'})).toBeVisible(); await shot('dark-variable-candidates'); await editor.press('Escape');
  await editor.press('Escape');
  await comment.fill('');
  await page.locator('.variable-scope-actions').getByRole('button',{name:'取消本范围修改',exact:true}).first().click();
  await page.locator('.workspace-titlebar .more-menu>summary').click(); await page.getByRole('button',{name:'删除实例',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await shot('dark-delete-confirmation');
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await theme('light'); await page.locator('.workspace-titlebar .more-menu>summary').click(); await page.getByRole('button',{name:'删除实例',exact:true}).click();
  await shot('light-delete-confirmation'); await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  checks.push('Variable candidates and deletion dialog render in both themes without changing the target workflow');
  const beforeReload=await workspace(); await theme('dark'); await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme','dark'); await expect(switcher()).toHaveAttribute('data-theme','dark'); assert.deepEqual(await workspace(),beforeReload);
  await theme('light'); await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme','light'); assert.deepEqual(await workspace(),beforeReload);
  checks.push('Display preference survives WebView reload independently of template/instance JSON');
  const darkButton=switcher(); await darkButton.focus(); await darkButton.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  const focus=await darkButton.evaluate(node=>{const s=getComputedStyle(node);return {width:s.outlineWidth,style:s.outlineStyle,visible:node.matches(':focus-visible')};});
  assert.equal(focus.visible,true); assert.equal(focus.style,'solid'); assert.equal(focus.width,'2px');
  assert.deepEqual(await workspace(),beforeReload); checks.push('A single sun/moon icon button exposes the target theme and a visible 2px keyboard focus ring; Space switches without business writes');
  assert.deepEqual(errors,[]);
  await writeFile(`${evidence}/theme-report.json`,JSON.stringify({directory:actual,checks,metrics,screenshots,errors,clipboardTouched:false,maintenanceCommandsExecuted:false},null,2));
  console.log(JSON.stringify({directory:actual,checks,errors}));
} catch(error){ await shot('theme-failure'); await writeFile(`${evidence}/theme-failure.json`,JSON.stringify({checks,metrics,errors,error:String(error)},null,2)); throw error; }
finally {await browser.close();}
