import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory=await realpath(process.env.RUNBOOK_TEST_DATA_DIR),target=await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(),target.toLowerCase());assert.match(path.basename(directory),/^desktop-smoke-/);
const output=process.env.RUNBOOK_TEST_OUTPUT_DIR??'.artifacts/step-card-click-2026-10-22';await mkdir(output,{recursive:true});
const browser=await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL),page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(10000);
const checks=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
const native=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const apply=action=>native('checklist_apply',{action}),load=()=>native('checklist_load');
const work=async id=>(await load()).instances.find(item=>item.id===id);
const card=id=>page.locator(`[data-step-id="${id}"]`);
const arrow=id=>card(id).locator(':scope > .step-card-heading > button.step-expand-toggle.icon-button');
const title=id=>card(id).locator('[data-inline-field="步骤标题"]');
const plainTitle=id=>title(id).locator('.parts-view > span:not([data-parameter-id])').first();
const isExpanded=id=>expect(card(id)).toHaveClass(/is-expanded/);
const isCollapsed=id=>expect(card(id)).not.toHaveClass(/is-expanded/);
async function collapse(id){if(await card(id).evaluate(node=>node.classList.contains('is-expanded')))await arrow(id).click();await isCollapsed(id);}
async function open(id){if(!await card(id).evaluate(node=>node.classList.contains('is-expanded')))await arrow(id).click();await isExpanded(id);}
async function openGroup(){const group=page.locator('[data-group-id="maintenance"]');if(await group.locator(':scope > .execution-group-heading').getAttribute('aria-expanded')!=='true')await group.locator(':scope > .execution-group-heading > button.group-expand-toggle').last().click();await expect(card('s3')).toBeVisible();}
async function navigate(id){await page.reload();await page.locator(`[data-instance-id="${id}"]`).click();await expect(card('s0')).toBeVisible();}
async function selectText(locator){
  await locator.scrollIntoViewIfNeeded();
  const bounds=await locator.evaluate(node=>{const range=node.ownerDocument.createRange();range.selectNodeContents(node);const rect=[...range.getClientRects()].find(value=>value.width>10&&value.height>5);if(!rect)throw new Error('missing text geometry');return {left:rect.left,right:rect.right,y:(rect.top+rect.bottom)/2};});
  await page.mouse.move(bounds.left+1,bounds.y);await page.mouse.down();await page.mouse.move(bounds.right-1,bounds.y,{steps:8});await page.mouse.up();
  return page.evaluate(()=>window.getSelection()?.toString()??'');
}
async function rapidToggle(id,locator){
  await collapse(id);await locator.scrollIntoViewIfNeeded();
  await page.evaluate(id=>{
    window.getSelection()?.removeAllRanges();const root=document.querySelector(`[data-step-id="${id}"]`),events=[];
    const describe=event=>({tag:event.target.tagName,className:event.target.getAttribute?.('class'),text:event.target.textContent?.slice(0,100),expanded:root.classList.contains('is-expanded')});
    const click=event=>{if(root.contains(event.target))events.push({type:'click',detail:event.detail,target:describe(event)});};
    const down=event=>{if(root.contains(event.target))events.push({type:'mousedown',detail:event.detail,defaultPrevented:event.defaultPrevented,target:describe(event)});};
    document.addEventListener('click',click,true);document.addEventListener('mousedown',down);
    window.__rapidCardTrace={id,events,finish(){document.removeEventListener('click',click,true);document.removeEventListener('mousedown',down);return events;}};
  },id);
  const bounds=await locator.boundingBox();assert.ok(bounds);const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
  await page.mouse.click(x,y,{clickCount:1});await isExpanded(id);const firstSelection=await page.evaluate(()=>window.getSelection()?.toString()??'');assert.equal(firstSelection,'','a heading click must not create a text selection');
  // mouse.click(clickCount:2) sends two complete clicks. Here only the second
  // press/release is needed, retaining detail=2 without adding a third click.
  await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});await isCollapsed(id);const secondSelection=await page.evaluate(()=>window.getSelection()?.toString()??'');assert.equal(secondSelection,'','rapid repeated heading clicks must not select a word');
  const events=await page.evaluate(()=>window.__rapidCardTrace.finish());assert.deepEqual(events.filter(event=>event.type==='click').map(event=>event.detail),[1,2]);assert.ok(events.filter(event=>event.type==='mousedown').every(event=>!event.defaultPrevented),'heading selection styling must not prevent native mousedown');
  return {events,firstSelection,secondSelection};
}
const document={parameters:[{id:'environment',name:'环境',description:'测试环境',defaultValue:'preview'}],groups:[{id:'maintenance',name:'维护步骤组',description:'组内步骤单击切换展开与收起'}],steps:[
  {id:'s0',title:['准备工作 ',{parameterId:'environment'}],description:['检查参数与维护窗口'],commands:[{id:'c0',text:['record-only ',{parameterId:'environment'}]}]},
  {id:'s1',title:['核对发布内容'],description:['查看发布范围'],commands:[]},
  {id:'s2',title:['通知维护开始'],description:['人工检查点'],commands:[]},
  {id:'s3',groupId:'maintenance',title:['组内操作'],description:['核对状态'],commands:[{id:'c3',text:['record-only maintenance']}]},
  {id:'s4',groupId:'maintenance',title:['组内复核'],description:['再次确认'],commands:[]},
  {id:'s5',title:['完成收尾'],description:['保留本次记录'],commands:[]},
]};

try{
  for(const [width,height,theme] of [[1360,780,'light'],[940,700,'dark']]){
    await page.setViewportSize({width,height});if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('.theme-switcher').click();
    const id='card-click-'+width;await apply({type:'create_work',id,name:'步骤卡点击 '+width,document});await navigate(id);const initial=await work(id);

    await collapse('s0');await plainTitle('s0').click();await isExpanded('s0');await plainTitle('s0').click();await isCollapsed('s0');await plainTitle('s0').click();await isExpanded('s0');
    await card('s0').locator('.step-description .parts-view').click();await isExpanded('s0');
    await card('s0').locator('.command-list .parts-view').click();await isExpanded('s0');
    await card('s0').click({position:{x:8,y:8}});await isCollapsed('s0');await card('s0').click({position:{x:8,y:8}});await isExpanded('s0');
    checks.push({width,check:'Plain title and card whitespace toggle both ways; clicking an open description or command keeps it expanded'});

    await arrow('s0').click();await isCollapsed('s0');await arrow('s0').click();await isExpanded('s0');
    await arrow('s0').press('Enter');await isCollapsed('s0');await arrow('s0').press('Space');await isExpanded('s0');await collapse('s0');
    checks.push({width,check:'Explicit arrow toggles once with mouse, Enter and Space'});

    await collapse('s1');await collapse('s2');await card('s0').getByRole('checkbox',{name:'选择步骤 1',exact:true}).click();
    await card('s2').getByRole('checkbox',{name:'选择步骤 3',exact:true}).click({modifiers:['Shift']});
    for(const stepId of ['s0','s1','s2']){await isCollapsed(stepId);await expect(card(stepId).getByRole('checkbox')).toHaveAttribute('aria-checked','true');}
    await page.getByRole('button',{name:'取消选择',exact:true}).click();for(const stepId of ['s0','s1','s2'])await isCollapsed(stepId);
    checks.push({width,check:'Number selection and Shift range selection leave collapsed cards closed'});

    for(const expanded of [false,true])for(const label of ['步骤新增','更多步骤操作']){
      await (expanded?open('s1'):collapse('s1'));const unchanged=()=>expanded?isExpanded('s1'):isCollapsed('s1');
      await card('s1').hover();await card('s1').getByRole('button',{name:label,exact:true}).click();const menu=page.getByRole('menu',{name:label,exact:true});await expect(menu).toBeVisible();await unchanged();
      await menu.click({position:{x:12,y:3}});await expect(menu).toBeVisible();await unchanged();
      await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await unchanged();
    }
    checks.push({width,check:'Add and more menus and their body portals leave both closed and open cards unchanged'});

    for(const expanded of [false,true]){
      await (expanded?open('s0'):collapse('s0'));await title('s0').locator('[data-parameter-id="environment"]').click();
      const variableInput=page.locator('.variable-panel [data-variable-id="environment"] input[data-parameter-id="environment"]');await expect(variableInput).toBeFocused();await (expanded?isExpanded('s0'):isCollapsed('s0'));await variableInput.press('Escape');
    }
    checks.push({width,check:'A variable token keeps its exact-variable focus action without toggling either closed or open cards'});

    await openGroup();await isCollapsed('s3');await plainTitle('s3').click();await isExpanded('s3');await plainTitle('s3').click();await isCollapsed('s3');await plainTitle('s3').click();await isExpanded('s3');await card('s3').locator('.step-description .parts-view').click();await isExpanded('s3');
    assert.deepEqual(await work(id),initial,'viewing, selecting, menus and variable focus must not save business data');
    checks.push({width,check:'Grouped steps toggle both ways, and all view-only interactions leave the saved work unchanged'});

    let editedTitle;
    for(const expanded of [false,true]){
      await (expanded?open('s1'):collapse('s1'));await plainTitle('s1').dblclick();await isExpanded('s1');const editor=title('s1').getByRole('textbox',{name:'步骤标题',exact:true});await expect(editor).toBeFocused();
      const selected=await selectText(editor);assert.match(selected,/核对发布内容/,'the title editor must allow real mouse text selection');await isExpanded('s1');
      if(expanded)await page.screenshot({path:`${output}/editor-selection-${width}.png`});
      editedTitle=`核对发布内容 · ${expanded?'展开':'收起'}时双击编辑 ${width}`;await editor.fill(editedTitle);await editor.press('Tab');
      await expect.poll(async()=>(await work(id)).document.steps.find(step=>step.id==='s1').title).toEqual([editedTitle]);await expect(editor).toHaveCount(0);
    }
    const edited=await work(id),expectedDocument=structuredClone(initial.document);expectedDocument.steps.find(step=>step.id==='s1').title=[editedTitle];assert.deepEqual(edited.document,expectedDocument);assert.deepEqual(edited.entries,[]);assert.equal(edited.status,'draft');
    checks.push({width,check:'Double click from either initial state opens the title editor; real mouse selection remains available there and only the intended field is saved'});
    await page.screenshot({path:`${output}/draft-${width}.png`});await page.locator('.back-button').click();

    await apply({type:'start_instance',id});await apply({type:'record_result',id,outcome:'completed',reason:null});await navigate(id);const running=await work(id);
    await expect(card('s1')).toHaveClass(/is-current/);await plainTitle('s1').click();await isCollapsed('s1');await plainTitle('s1').click();await isExpanded('s1');await card('s1').locator('.step-description .parts-view').click();await isExpanded('s1');await expect(card('s1').locator('.result-actions')).toBeVisible();
    await isCollapsed('s2');await card('s2').locator('.step-status-label').click();await isExpanded('s2');await card('s2').locator('.step-status-label').click();await isCollapsed('s2');await card('s2').locator('.step-status-label').click();await isExpanded('s2');
    await expect(card('s2').locator('.step-status-label')).toHaveText('待处理');
    await isCollapsed('s0');await plainTitle('s0').click();await isExpanded('s0');await plainTitle('s0').click();await isCollapsed('s0');await card('s0').locator('.step-status-label').click();await isExpanded('s0');await card('s0').locator('.step-status-label').click();await isCollapsed('s0');await plainTitle('s0').click();await isExpanded('s0');await expect(card('s0').locator('.step-status-label')).toHaveText('已完成');await expect(card('s0').locator('.step-result-summary time')).toBeVisible();
    await expect(card('s0').locator('[data-inline-field="步骤标题"]')).toHaveClass(/is-readonly/);await plainTitle('s0').dblclick();await expect(card('s0').getByRole('textbox')).toHaveCount(0);await open('s0');
    await card('s0').locator('.command-list .parts-view').click();await isExpanded('s0');
    await arrow('s0').click();await isCollapsed('s0');await arrow('s0').press('Enter');await isExpanded('s0');
    const rapidTitle=await rapidToggle('s0',plainTitle('s0')),rapidStatus=await rapidToggle('s0',card('s0').locator('.step-status-label'));
    await page.screenshot({path:`${output}/heading-no-selection-${width}.png`});
    checks.push({width,check:'Real rapid readonly-title and status clicks with click details 1 and 2 toggle twice without blue text selection or prevented mousedown',rapidTitle,rapidStatus});
    await open('s0');const commandSelection=await selectText(card('s0').locator('.command-list .parts-view'));assert.match(commandSelection,/record-only/,'command text must remain selectable with the mouse');await isExpanded('s0');
    await page.screenshot({path:`${output}/command-selection-${width}.png`});
    await plainTitle('s0').click();await isCollapsed('s0');assert.equal(await page.evaluate(()=>window.getSelection()?.toString()??''),'');await plainTitle('s0').click();await isExpanded('s0');
    checks.push({width,check:'Command text keeps real mouse selection; a subsequent header click toggles normally without being blocked by the old body selection',commandSelection});
    assert.deepEqual(await work(id),running,'opening current, future and frozen history must not alter progress, parameters or result snapshots');
    checks.push({width,check:'Current titles, future statuses and historical titles/statuses toggle both ways; bodies stay open, history remains read-only and all saved execution data stays exact'});
    await card('s0').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/history-${width}.png`});
    await open('s1');await card('s1').getByRole('button',{name:'完成并下一步',exact:true}).click();await expect(card('s2')).toHaveClass(/is-current/);
    const advanced=await work(id);assert.equal(advanced.currentStepId,'s2');assert.equal(advanced.entries.filter(entry=>entry.type==='result').length,2);assert.deepEqual(advanced.entries[0],running.entries[0]);assert.equal(advanced.entries.find(entry=>entry.type==='result'&&entry.stepId==='s1').snapshot.title,editedTitle);
    checks.push({width,check:'After current-heading toggles, Complete and Next still records exactly one result and advances once without changing the earlier result'});
    await page.locator('.back-button').click();
  }
  assert.deepEqual(errors,[]);const report={ok:true,directory,checks,errors,realUserDataOpened:false,maintenanceCommandsExecuted:false,systemClipboardAccessed:false};await writeFile(`${output}/inspection.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){const rapidTrace=await page.evaluate(()=>({id:window.__rapidCardTrace?.id,events:window.__rapidCardTrace?.events,selection:window.getSelection()?.toString()??'',cards:[...document.querySelectorAll('.step-card[data-step-id]')].map(node=>({id:node.dataset.stepId,expanded:node.classList.contains('is-expanded')}))})).catch(()=>null);await page.screenshot({path:`${output}/failure.png`}).catch(()=>{});await writeFile(`${output}/inspection.json`,JSON.stringify({ok:false,directory,checks,rapidTrace,errors,error:String(error)},null,2));throw error;}
finally{await browser.close();}
