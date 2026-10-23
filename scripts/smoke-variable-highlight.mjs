import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase()); assert.match(path.basename(directory), /^desktop-smoke-/);
const output = process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/variable-highlight-2026-10-22'; await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(12000);
const checks = [], errors = [], layouts = []; page.on('pageerror', e => errors.push(e.message));
const native = (command, args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const apply = action => native('checklist_apply', {action}), load = () => native('checklist_load');
const id = 'reference-highlight-work', work = async () => (await load()).instances.find(i => i.id === id);
const panel = page.getByRole('complementary', {name:'变量面板'}), search = panel.locator('input[aria-label="搜索变量"]');
const row = id => panel.locator(`[data-variable-id="${id}"]`), step = id => page.locator(`[data-step-id="${id}"]`);
const highlights = page.locator('.execution-steps [data-variable-match]');
async function clear() { await panel.getByRole('button', {name:'清空变量搜索',exact:true}).click(); await expect(search).toHaveValue(''); await expect(highlights).toHaveCount(0); }
async function choose(id) { await row(id).getByRole('button', {name:'选择变量 环境',exact:true}).click(); }
async function matches(id, count) {
  await expect(highlights).toHaveCount(count);
  assert.deepEqual(await highlights.evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.parameterId??n.dataset.frozenReference))]), [id]);
  assert.equal(await panel.locator('[data-variable-match]').count(),0);
}
async function stopped() { await expect.poll(()=>highlights.evaluateAll(nodes=>nodes.every(n=>n.getAnimations({subtree:true}).every(a=>a.playState==='finished')))).toBe(true); }
async function expand(name) { const button=panel.getByRole('button',{name:'展开 '+name,exact:true});if(await button.count())await button.click(); }
const document = { groups:[{id:'ga',name:'玩家转区'},{id:'gb',name:'更新外服'}], parameters:[
  {id:'global',name:'环境',description:'全局环境',defaultValue:'preview'},
  {id:'a',name:'环境',ownerId:'ga',description:'玩家转区环境',defaultValue:'preview'},
  {id:'b',name:'环境',ownerId:'gb',description:'外服环境',defaultValue:'preview'},
  {id:'deep',name:'环境',ownerId:'long',description:'只在末尾命令使用',defaultValue:'sandboxd'},
  {id:'unused',name:'环境',description:'没有引用',defaultValue:'preview'},
], steps:[
  {id:'prepare',title:['维护 ',{parameterId:'global'}],description:['literal preview / ',{parameterId:'global'}],commands:[{id:'cmd-first',text:['stop ',{parameterId:'global'},' all']}]},
  ...Array.from({length:16},(_,i)=>({id:'intro-'+i,title:['人工核对 '+i],description:[],commands:[]})),
  {id:'long',groupId:'ga',title:['转区 ',{parameterId:'a'}],description:['核对 ',{parameterId:'a'},'；普通文本 preview\n',...Array.from({length:26},(_,i)=>`长步骤说明 ${i}\n`)],commands:[{id:'cmd-a',text:['transfer ',{parameterId:'a'},' ',{parameterId:'a'},' ',{parameterId:'deep'}]}]},
  {id:'other',groupId:'gb',title:['外服维护'],description:[],commands:[{id:'cmd-b',text:['stop ',{parameterId:'b'},' all']}]},
]};
try {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await apply({type:'create_work',id,name:'正文变量引用高亮',document}); await page.reload(); await page.locator(`[data-instance-id="${id}"]`).click();
  const original = await work(); await expand('玩家转区'); await expand('更新外服');
  await choose('a'); await matches('a',4);
  const animation = await highlights.first().evaluate(n=>{const a=n.getAnimations({subtree:true})[0];window.__previousHighlight=a;window.__referenceBounds=n.getBoundingClientRect().toJSON();return {pseudo:a.effect.pseudoElement,duration:a.effect.getTiming().duration};});
  assert.ok(animation.duration>=1200&&animation.duration<=1600,'slower expand, hold and recover');
  assert.equal(animation.pseudo,'::before','animate only the background, never the text');
  await expect.poll(()=>highlights.first().evaluate(n=>{
    const text=getComputedStyle(n), background=getComputedStyle(n,'::before'), time=Number(window.__previousHighlight.currentTime);
    return text.transform==='none'&&background.top==='-4px'&&background.left==='-4px'&&time>=420&&time<560;
  }),{intervals:[15,25,30]}).toBe(true);
  const heldAt=await highlights.first().evaluate(n=>({time:Number(window.__previousHighlight.currentTime),top:getComputedStyle(n,'::before').top,left:getComputedStyle(n,'::before').left}));
  await expect.poll(()=>page.evaluate(()=>Number(window.__previousHighlight.currentTime)),{intervals:[20,30]}).toBeGreaterThanOrEqual(heldAt.time+180);
  assert.deepEqual(await highlights.first().evaluate(n=>({top:getComputedStyle(n,'::before').top,left:getComputedStyle(n,'::before').left})),{top:heldAt.top,left:heldAt.left},'expanded background must remain still long enough to locate the reference');
  assert.equal(await highlights.first().evaluate(n=>n.getBoundingClientRect().width===window.__referenceBounds.width&&n.getBoundingClientRect().height===window.__referenceBounds.height),true,'only the background grows; text geometry stays fixed');
  await page.screenshot({path:`${output}/highlight-active.png`});
  await stopped(); await choose('a'); await matches('a',4);
  assert.equal(await highlights.first().evaluate(n=>n.getAnimations({subtree:true})[0]!==window.__previousHighlight),true,'same variable must replay the animation');
  await stopped(); await choose('a');
  await highlights.first().evaluate(n=>{window.__clearedAnimation=n.getAnimations({subtree:true})[0];}); await clear();
  assert.equal(await page.evaluate(()=>window.__clearedAnimation.playState),'idle','clearing must cancel an in-flight bounce');
  await choose('deep'); await matches('deep',1);
  await expect.poll(()=>highlights.first().evaluate(n=>{const r=n.getBoundingClientRect(),v=n.closest('.workspace-scroll').getBoundingClientRect();return r.top>=v.top&&r.bottom<=v.bottom;})).toBe(true);
  await stopped(); await page.screenshot({path:`${output}/highlight-command.png`});
  checks.push('Exact stable IDs highlight every occurrence in titles/descriptions/commands; identical names/values and literal text do not match; 1400ms background-only expand/hold/recover expands every side by 3px, the expanded geometry stays constant across a real-time hold, text transform/bounds stay fixed, repeated selection restarts, and long steps scroll to the actual reference');
  await clear();
  const command = step('long').locator('[data-inline-field="命令 1"]'); await command.dblclick();
  const editor = command.getByRole('textbox'); await expect(editor).toBeFocused();
  await editor.evaluate(n=>{window.__editor=n;window.__editorText=n.firstChild;const s=getSelection(),r=document.createRange();r.setStart(n.firstChild,3);r.collapse(true);s.removeAllRanges();s.addRange(r);window.__anchor=s.anchorNode;window.__offset=s.anchorOffset;});
  await choose('a'); await matches('a',4);
  assert.deepEqual(await editor.evaluate(n=>({same:n===window.__editor&&n.firstChild===window.__editorText,selection:getSelection().anchorNode===window.__anchor&&getSelection().anchorOffset===window.__offset})),{same:true,selection:true});
  await clear(); assert.equal(await editor.evaluate(n=>n===window.__editor&&n.firstChild===window.__editorText),true);
  await editor.press('Escape'); await expect(command.getByRole('textbox')).toHaveCount(0);
  // The deep variable also matches its rendered owner namespace "转区 preview".
  await search.fill('preview'); await expect(highlights).toHaveCount(9);
  assert.deepEqual(await highlights.evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.parameterId))].sort()),['a','b','deep','global']); await clear();
  await choose('unused'); await expect(highlights).toHaveCount(0); await search.press('Escape'); await expect(search).toHaveValue('');
  assert.deepEqual(await work(),original,'view markers must not alter business data');
  checks.push('Search updates preserve the live contenteditable node, text node and collapsed selection; clearing and Escape remove all markers, typed queries highlight all matched identities, and zero-reference variables leave no stale marks or data changes');
  for(const theme of ['light','dark']) {
    if(await page.locator('html').getAttribute('data-theme')!==theme) await page.locator('.theme-switcher').click();
    for(const width of [1360,940]) {
      await page.setViewportSize({width,height:780}); await choose('a'); await stopped();
      const info=await highlights.first().evaluate(n=>({background:getComputedStyle(n,'::before').backgroundColor,border:getComputedStyle(n,'::before').borderStyle,transform:getComputedStyle(n).transform,decorationTransform:getComputedStyle(n,'::before').transform,top:getComputedStyle(n,'::before').top,left:getComputedStyle(n,'::before').left,overflow:document.documentElement.scrollWidth>innerWidth}));
      assert.equal(info.border,'solid'); assert.equal(info.transform,'none'); assert.equal(info.decorationTransform,'none'); assert.equal(info.top,'-1px'); assert.equal(info.left,'-1px'); assert.equal(info.overflow,false); layouts.push({theme,width,...info});
      // Capture the title/description marks, then command marks in the same long step.
      await page.screenshot({path:`${output}/highlight-${theme}-${width}.png`}); await clear();
    }
  }
  await page.emulateMedia({reducedMotion:'reduce'}); await choose('a'); await matches('a',4);
  assert.equal(await highlights.evaluateAll(nodes=>nodes.some(n=>n.getAnimations({subtree:true}).length)),false,'reduced motion keeps the highlight without scaling');
  await clear(); await page.emulateMedia({reducedMotion:'no-preference'});
  checks.push('Light/dark and wide/narrow screenshots retain visible highlights without horizontal overflow; settled transforms reset, and reduced-motion preference suppresses the bounce while preserving highlights');
  await page.getByRole('button',{name:'开始记录',exact:true}).click(); await step('prepare').getByRole('button',{name:'完成并下一步',exact:true}).click();
  await expect(step('intro-0')).toHaveClass(/is-current/);
  // Global used only by a completed step: keep its immutable preview snapshot
  // even after the current applied value is changed to production.
  await row('global').locator('[data-variable-value]').dblclick(); const input=row('global').locator('input[data-parameter-id]'); await input.fill('production'); await input.press('Enter');
  await panel.getByRole('button',{name:'应用全局参数',exact:true}).click(); await expect.poll(async()=>(await work()).parameterValues.global).toBe('production');
  const beforeHistory=await work(); await clear(); await choose('global'); await matches('global',3);
  await expect(step('prepare').locator('[data-frozen-reference]')).toHaveText(['preview','preview','preview']);
  assert.equal(await step('prepare').locator('.variable-token').count(),0,'frozen text must never become interactive tokens');
  assert.equal(await step('prepare').locator('[data-frozen-reference][role], [data-frozen-reference][tabindex], [contenteditable="true"]').count(),0);
  await stopped(); await page.screenshot({path:`${output}/highlight-history.png`}); await clear();
  assert.deepEqual(await work(),beforeHistory); await expect(step('prepare').locator('[data-inline-field="步骤标题"]')).toHaveText('维护 preview');
  checks.push('Completed fields highlight only original frozen-reference segments using their historical snapshot values; they remain plain read-only text, current parameters/results/snapshots remain byte-for-byte unchanged, and clearing restores their neutral display');
  assert.deepEqual(errors,[]); const report={ok:true,directory,checks,layouts,errors,realUserDataOpened:false,maintenanceCommandsExecuted:false,systemClipboardAccessed:false,nativeCodeChanged:false}; await writeFile(`${output}/inspection.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) { await page.screenshot({path:`${output}/failure.png`}).catch(()=>{}); await writeFile(`${output}/inspection.json`,JSON.stringify({ok:false,directory,checks,errors,error:String(error)},null,2));throw error; }
finally { await browser.close(); }
