import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase()); assert.match(path.basename(directory), /^desktop-smoke-/);
const output = process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/variable-click-2026-10-22'; await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(10000);
const checks = [], errors = []; page.on('pageerror', e => errors.push(e.message));
const native = (command, args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const apply = action => native('checklist_apply', {action}), load = () => native('checklist_load');
const id = 'click-search-work', work = async () => (await load()).instances.find(i => i.id === id);
const panel = page.getByRole('complementary', {name:'变量面板'}), search = panel.locator('input[aria-label="搜索变量"]');
const row = p => panel.locator(`[data-variable-id="${p}"]`), shown = p => row(p).locator('[data-variable-value]');
async function clear() { await panel.getByRole('button', {name:'清空变量搜索',exact:true}).click(); await expect(search).toHaveValue(''); }
async function refs(expected) { await expect.poll(() => page.locator('[data-step-id]').evaluateAll(nodes => nodes.map(n => n.dataset.stepId))).toEqual(expected); }
async function choose(parameter, expected, query, keyboard = false) {
  const button = row(parameter).getByRole('button', {name:'选择变量 环境',exact:true});
  await button.scrollIntoViewIfNeeded(); const before = await button.boundingBox();
  if (keyboard) await button.press('Enter'); else await button.click();
  const after = await button.boundingBox(); assert.ok(Math.abs(before.y - after.y) < 2, 'selection must keep the right tree row stable');
  await expect(search).toHaveValue(query); await refs(expected); await expect(row(parameter)).toHaveAttribute('data-selected','true');
  assert.equal(await row(parameter).locator('input[data-parameter-id]').count(),0,'single selection must not start editing');
}
const document = {groups:[{id:'ga',name:'玩家转区'},{id:'gb',name:'更新外服'}],parameters:[
  {id:'global',name:'环境',description:'全局',defaultValue:'release'},
  {id:'a',ownerId:'ga',name:'环境',description:'转区环境',defaultValue:'preview'},
  {id:'b',ownerId:'gb',name:'环境',description:'外服环境',defaultValue:'sandboxa'},
  {id:'step-local',ownerId:'a-three',name:'环境',description:'单步环境',defaultValue:'sandboxd'},
  {id:'unused',name:'环境',description:'尚未引用',defaultValue:'sandboxc'},
],steps:[
  ...Array.from({length:24},(_,index)=>({id:'intro-'+index,title:['人工准备 '+index],description:[],commands:[]})),
  {id:'a-one',groupId:'ga',title:['检查 ',{parameterId:'a'}],description:[{parameterId:'global'}],commands:[]},
  {id:'a-two',groupId:'ga',title:['无变量的人工核对'],description:[],commands:[]},
  {id:'a-three',groupId:'ga',title:['执行转区'],description:[{parameterId:'step-local'}],commands:[{id:'cmd-a',text:['transfer ',{parameterId:'a'}]}]},
  {id:'b-one',groupId:'gb',title:['停止服务'],description:[],commands:[{id:'cmd-b',text:['stop ',{parameterId:'b'}]}]},
  {id:'b-two',groupId:'gb',title:['核验服务'],description:[{parameterId:'global'}],commands:[]},
]};
try {
  await apply({type:'create_work',id,name:'单击变量定位',document}); await page.reload(); await page.locator(`[data-instance-id="${id}"]`).click();
  const original = await work(); await choose('global',['a-one','b-two'],'环境');
  await expect.poll(() => page.locator('[data-step-id="a-one"]').evaluate(n=>{const r=n.getBoundingClientRect(), v=n.closest('.workspace-scroll').getBoundingClientRect();return r.top>=v.top-2&&r.top<v.bottom;})).toBe(true);
  await clear(); await panel.getByRole('button',{name:'展开 玩家转区',exact:true}).count().then(async count=>{if(count)await panel.getByRole('button',{name:'展开 玩家转区',exact:true}).click();});
  await choose('a',['a-one','a-three'],'玩家转区.环境'); await clear();
  if(await panel.getByRole('button',{name:'展开 更新外服',exact:true}).count()) await panel.getByRole('button',{name:'展开 更新外服',exact:true}).click();
  await choose('b',['b-one'],'更新外服.环境',true); await clear(); await choose('step-local',['a-three'],'玩家转区.执行转区.环境'); await clear();
  checks.push('Single click and keyboard activation filter all exact references, open matching steps/groups and visibly scroll to a match; global, group and step variables sharing one name never mix, and non-referencing group members are excluded');
  await choose('unused',[],'环境'); await expect(page.locator('.execution-steps')).toContainText('没有匹配的变量引用步骤'); await search.press('Escape'); await expect(search).toHaveValue(''); await expect(page.locator('[data-group-id]')).toHaveCount(2);
  await search.fill('sandboxa'); await expect(shown('b')).toHaveText('sandboxa'); await shown('b').dblclick(); const localInput = row('b').locator('input[data-parameter-id]'); await expect(localInput).toBeFocused(); await localInput.fill('draft-local'); await localInput.press('Enter'); await clear();
  await shown('global').dblclick(); const input = row('global').locator('input[data-parameter-id]'); await expect(input).toBeFocused(); await input.fill('draft-only'); await input.press('Enter'); await clear();
  await choose('a',['a-one','a-three'],'玩家转区.环境'); await clear(); await expect(shown('global')).toHaveText('draft-only');
  assert.deepEqual(await work(),original,'search and inline drafts must not change saved business data');
  const stored = await page.evaluate(()=>JSON.parse(localStorage.getItem('runbook.explicit-drafts.v1')));assert.equal(stored.entries.find(([key])=>key==='parameters:click-search-work')[1].value.global,'draft-only');
  checks.push('Zero-reference selection shows an empty result and Escape restores the flow; real double click still edits, switching searches retains unapplied values, and all saved parameters, status and result data remain exact');
  for(const theme of ['light','dark']) { if(await page.locator('html').getAttribute('data-theme')!==theme) await page.locator('.theme-switcher').click(); await page.setViewportSize({width:theme==='light'?1360:940,height:780}); await choose('a',['a-one','a-three'],'玩家转区.环境'); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); await page.screenshot({path:`${output}/click-${theme}.png`,animations:'disabled'}); await clear(); }
  assert.deepEqual(errors,[]);const report={ok:true,directory,checks,errors,realUserDataOpened:false,maintenanceCommandsExecuted:false,systemClipboardAccessed:false}; await writeFile(`${output}/inspection.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) { await page.screenshot({path:`${output}/failure.png`}).catch(()=>{}); await writeFile(`${output}/inspection.json`,JSON.stringify({ok:false,directory,checks,errors,error:String(error)},null,2));throw error; }
finally { await browser.close(); }
