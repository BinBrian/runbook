import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory=await realpath(process.env.RUNBOOK_TEST_DATA_DIR),target=await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(),target.toLowerCase());assert.match(path.basename(directory),/^desktop-smoke-/);
const output=process.env.RUNBOOK_TEST_OUTPUT_DIR??'.artifacts/step-advance-scroll-2026-10-22';await mkdir(output,{recursive:true});
const browser=await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL),page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(12000);
const errors=[],cases=[],navigation=[],extra={};page.on('pageerror',e=>errors.push(e.message));
const native=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const apply=action=>native('checklist_apply',{action}),load=()=>native('checklist_load');
const step=id=>page.locator(`[data-step-id="${id}"]`);
const document={parameters:[],groups:[{id:'g1',name:'维护与转区'},{id:'g2',name:'外服更新'},{id:'g3',name:'收尾检查'}],steps:Array.from({length:32},(_,i)=>({
  id:'s'+i,groupId:i<22?'g1':i<26?'g2':'g3',title:[`维护步骤 ${i+1}`],
  description:[Array.from({length:[2,24,4,35,1][i%5]},(_,j)=>`第 ${i+1} 步说明 ${j+1}：在外部工具操作后核对状态。`).join('\n')],
  commands:i%3===0?[]:[{id:'cmd-'+i,text:[`record-only environment ${i}\n`,...Array.from({length:i%2===0?20:2},(_,j)=>`command-text-${j}\n`)]}],
}))};

async function settle(){await page.evaluate(()=>new Promise(resolve=>{let last=-1,stable=0,frames=0;function check(){const n=document.querySelector('.workspace-scroll'),v=n?.scrollTop??0;stable=Math.abs(v-last)<.25?stable+1:0;last=v;if(stable>=5||++frames>=120)resolve();else requestAnimationFrame(check);}requestAnimationFrame(check);}));}
async function openWork(id,completed){
  await apply({type:'create_work',id,name:'推进定位验证 '+id,document});await apply({type:'start_instance',id});
  for(let i=0;i<completed;i++)await apply({type:'record_result',id,outcome:'completed',reason:null});
  await page.reload();await page.locator(`[data-instance-id="${id}"]`).click();await expect(step('s'+completed)).toHaveClass(/is-current/);await settle();
}

// Install before the click so the first post-commit frame is included. The wrapper
// records calls without changing their arguments or the browser's native scrolling.
async function startRecording(id,duration=1600){await page.evaluate(({id,duration})=>{
  const root=document.querySelector('.workspace-scroll');if(!root)throw new Error('missing document scroll root');
  window.__advanceTrace?.finish?.();
  const start=performance.now(),calls=[],samples=[],interactions=[],descriptor=Object.getOwnPropertyDescriptor(root,'scrollTo'),original=root.scrollTo;
  const data={id,calls,samples,interactions,originalOverflowAnchor:root.style.overflowAnchor};
  let resolve,frame,finished=false;const done=new Promise(value=>resolve=value);
  const now=()=>performance.now()-start;
  root.scrollTo=function(...args){
    const options=typeof args[0]==='object'?args[0]:{left:args[0],top:args[1]},maxScroll=Math.max(0,root.scrollHeight-root.clientHeight);
    calls.push({t:now(),behavior:options?.behavior??'auto',from:root.scrollTop,to:Math.max(0,Math.min(options?.top??root.scrollTop,maxScroll)),maxScroll,currentStepId:root.querySelector('.step-card.is-current')?.dataset.stepId});
    return Reflect.apply(original,this,args);
  };
  const wheel=event=>interactions.push({t:now(),type:'wheel',deltaY:event.deltaY,scrollTop:root.scrollTop});
  root.addEventListener('wheel',wheel,{capture:true,passive:true});
  function finish(){if(finished)return;finished=true;cancelAnimationFrame(frame);if(descriptor)Object.defineProperty(root,'scrollTo',descriptor);else delete root.scrollTo;root.removeEventListener('wheel',wheel,true);data.finalOverflowAnchor=root.style.overflowAnchor;resolve(data);}
  function sample(){
    const card=root.querySelector(`[data-step-id="${id}"]`),heading=card?.querySelector('.step-card-heading'),r=root.getBoundingClientRect();
    const value={t:now(),scrollTop:root.scrollTop,maxScroll:root.scrollHeight-root.clientHeight,viewport:root.clientHeight,currentStepId:root.querySelector('.step-card.is-current')?.dataset.stepId};
    if(card&&heading){const c=card.getBoundingClientRect(),h=heading.getBoundingClientRect();Object.assign(value,{top:c.top-r.top,documentTop:c.top-r.top+root.scrollTop,headingTop:h.top-r.top,headingBottom:h.bottom-r.top});}
    samples.push(value);if(now()>=duration)finish();else frame=requestAnimationFrame(sample);
  }
  window.__advanceTrace={data,done,finish};sample();
},{id,duration});}
const finishRecording=()=>page.evaluate(()=>window.__advanceTrace.done);
function inspect(trace,currentOnly=true){
  const samples=trace.samples.filter(s=>(!currentOnly||s.currentStepId===trace.id)&&s.headingTop!==undefined),last=samples.at(-1);
  const smooth=trace.calls.filter(call=>call.behavior==='smooth'&&(!currentOnly||call.currentStepId===trace.id)).at(-1);
  const motion=smooth?samples.filter(s=>s.t>=smooth.t):[],distance=smooth?Math.abs(smooth.to-smooth.from):0,direction=smooth?Math.sign(smooth.to-smooth.from):0;
  const positions=smooth?[smooth.from,...motion.map(s=>s.scrollTop)]:[];
  const intermediatePositions=smooth?new Set(motion.filter(s=>Math.abs(s.scrollTop-smooth.from)>.75&&Math.abs(s.scrollTop-smooth.to)>.75).map(s=>Math.round(s.scrollTop*4)/4)).size:0;
  const overshot=smooth?motion.some(s=>s.scrollTop<Math.min(smooth.from,smooth.to)-1.5||s.scrollTop>Math.max(smooth.from,smooth.to)+1.5):false;
  const reversed=positions.some((value,index)=>index>0&&direction*(value-positions[index-1])< -1.5);
  const tail=samples.slice(-8),drift=tail.length?Math.max(...tail.map(s=>s.top))-Math.min(...tail.map(s=>s.top)):Infinity;
  return {...trace,last,smooth,distance,intermediatePositions,overshot,reversed,drift,aligned:Boolean(last&&last.headingTop>=3&&last.headingBottom<=last.viewport-3),settledAtTarget:Boolean(smooth&&last&&Math.abs(last.scrollTop-smooth.to)<1.5)};
}
function assertSmooth(result){
  assert.ok(result.smooth,'normal advancement must request smooth scrolling');
  assert.ok(result.aligned&&result.settledAtTarget&&result.drift<1,'the final heading must be visible and stable at the clamped destination');
  assert.ok(!result.overshot&&!result.reversed,'the smooth trajectory must approach its destination monotonically without passing it and coming back');
  if(result.distance>40)assert.ok(result.intermediatePositions>=3,'a meaningful scroll must contain at least three intermediate positions');
  assert.equal(result.finalOverflowAnchor,result.originalOverflowAnchor,'scroll anchoring must be restored after navigation');
}
async function assertHintsRemoved(){
  await expect(page.getByText('核对后，手动确认结果。',{exact:true})).toHaveCount(0);
  await expect(page.locator('.document-footer')).toHaveCount(0);
  await expect(page.locator('.step-nav-progress small')).toHaveCount(0);
  await expect(page.locator('.step-nav-preview-hint')).toHaveCount(0);
}

try{
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const [width,height] of [[1360,780],[940,660]]){
    await page.setViewportSize({width,height});const id='advance-'+width;await openWork(id,18);
    await expect(step('s18').locator('.step-status-label')).toHaveText('待处理');await assertHintsRemoved();
    await page.getByRole('button',{name:'展开步骤目录',exact:true}).click();await page.locator('[data-nav-step-id="s18"]').focus();await expect(page.locator('.step-nav-preview')).toBeVisible();await assertHintsRemoved();
    await page.getByRole('button',{name:'收起步骤目录',exact:true}).click();
    const edited=new Map();
    for(let i=18;i<31;i++){
      await expect(step('s'+i)).toHaveClass(/is-current/);
      if(i===20||i===24){
        const field=step('s'+i).locator('[data-inline-field="操作说明"]');await field.dblclick();
        const editor=field.getByRole('textbox',{name:'操作说明',exact:true});const text=document.steps[i].description.join('')+'\n提交前临时补充说明';
        await editor.fill(text);edited.set('s'+i,text);
      }
      const complete=step('s'+i).getByRole('button',{name:'完成并下一步',exact:true});await complete.scrollIntoViewIfNeeded();await settle();
      await startRecording('s'+(i+1));await complete.click();await expect(step('s'+(i+1))).toHaveClass(/is-current/);
      const result={width,from:i+1,to:i+2,editedBeforeAdvance:edited.has('s'+i),...inspect(await finishRecording())};cases.push(result);
      try{assertSmooth(result);}catch(error){await page.screenshot({path:`${output}/overshoot-${width}-${i+2}.png`});throw error;}
    }
    const saved=(await load()).instances.find(w=>w.id===id);assert.equal(saved.currentStepId,'s31');assert.equal(saved.entries.filter(e=>e.type==='result').length,31);
    for(const [stepId,text] of edited)assert.equal(saved.entries.find(e=>e.type==='result'&&e.stepId===stepId).snapshot.description,text,'advance must flush the inline edit before freezing its result');
    await startRecording('s19');await page.locator('[data-nav-step-id="s19"]').click();const history=inspect(await finishRecording(),false);navigation.push({width,kind:'history',...history});assert.ok(history.aligned&&history.drift<1);assert.ok(history.calls.some(c=>c.behavior==='smooth'));
    await expect(step('s19').locator('.step-status-label')).toHaveText('已完成');
    await startRecording('s31');await page.locator('.step-nav-return').click();const current=inspect(await finishRecording());navigation.push({width,kind:'return',...current});assertSmooth(current);
    assert.deepEqual((await load()).instances.find(w=>w.id===id),saved,'manual history navigation and return must not write execution data');
    await page.screenshot({path:`${output}/final-${width}.png`});await page.locator('.back-button').click();
  }

  await openWork('advance-reduced',18);await page.emulateMedia({reducedMotion:'reduce'});
  const reducedComplete=step('s18').getByRole('button',{name:'完成并下一步',exact:true});await reducedComplete.scrollIntoViewIfNeeded();await settle();
  await startRecording('s19');await reducedComplete.click();await expect(step('s19')).toHaveClass(/is-current/);
  extra.reduced=inspect(await finishRecording());assert.equal(extra.reduced.calls.filter(c=>c.behavior==='smooth').length,0,'reduced motion must never start a smooth advancement');assert.ok(extra.reduced.calls.some(c=>c.behavior==='instant'));assert.ok(extra.reduced.aligned&&extra.reduced.drift<1);
  assert.equal(extra.reduced.finalOverflowAnchor,extra.reduced.originalOverflowAnchor);await page.locator('.back-button').click();

  await page.emulateMedia({reducedMotion:'no-preference'});await openWork('advance-interrupted',20);
  const interruptedComplete=step('s20').getByRole('button',{name:'完成并下一步',exact:true});await interruptedComplete.scrollIntoViewIfNeeded();await settle();
  await startRecording('s21',1800);await interruptedComplete.click();await expect(step('s21')).toHaveClass(/is-current/);
  await page.waitForFunction(()=>window.__advanceTrace.data.calls.some(c=>c.behavior==='smooth'&&Math.abs(c.to-c.from)>40),{},{polling:'raf'});
  // The result button was clicked within the document viewport; keep the pointer
  // there and send a real wheel event while its native animation is in flight.
  await page.mouse.wheel(0,-180);
  extra.interrupted=inspect(await finishRecording());
  const wheel=extra.interrupted.interactions.find(e=>e.type==='wheel'),smooth=extra.interrupted.calls.filter(c=>c.behavior==='smooth').at(-1);assert.ok(wheel&&smooth);
  assert.ok(Math.abs(wheel.scrollTop-smooth.to)>4,'the wheel must interrupt before the original animation reaches its destination');
  assert.ok(!extra.interrupted.calls.some(c=>c.t>=wheel.t&&c.behavior==='smooth'),'the canceled request must not start another animation');
  assert.ok(!extra.interrupted.calls.some(c=>c.t>=wheel.t&&c.behavior==='instant'&&Math.abs(c.to-c.from)>1.5),'the canceled request must not jump back either');
  assert.ok(extra.interrupted.drift<1&&Math.abs(extra.interrupted.last.scrollTop-smooth.to)>4,'the user scroll position must stay settled away from the canceled destination');
  assert.equal(extra.interrupted.finalOverflowAnchor,extra.interrupted.originalOverflowAnchor);
  const interruptedSaved=(await load()).instances.find(w=>w.id==='advance-interrupted');assert.equal(interruptedSaved.currentStepId,'s21');assert.equal(interruptedSaved.entries.filter(e=>e.type==='result').length,21);
  await assertHintsRemoved();assert.deepEqual(errors,[]);assert.equal(cases.length,26);
  const report={ok:true,directory,cases,navigation,extra,errors,realUserDataOpened:false,maintenanceCommandsExecuted:false};await writeFile(`${output}/inspection.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,directory,cases:cases.map(({samples,calls,interactions,...value})=>value),reduced:{aligned:extra.reduced.aligned,smoothCalls:0},interrupted:{drift:extra.interrupted.drift,canceledDestination:smooth.to,finalScrollTop:extra.interrupted.last.scrollTop}}));
}catch(error){
  const pendingTrace=await page.evaluate(()=>window.__advanceTrace?.data).catch(()=>null);
  await page.screenshot({path:`${output}/failure.png`}).catch(()=>{});await writeFile(`${output}/inspection.json`,JSON.stringify({ok:false,directory,cases,navigation,extra,pendingTrace,errors,error:String(error)},null,2));throw error;
}finally{await page.evaluate(()=>window.__advanceTrace?.finish?.()).catch(()=>{});await browser.close();}
