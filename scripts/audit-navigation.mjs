import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const directory=await realpath(process.env.RUNBOOK_TEST_DATA_DIR),target=await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(),target.toLowerCase());assert.match(path.basename(directory),/^desktop-smoke-/);
const output=path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR);await mkdir(output,{recursive:true});
const browser=await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL),page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(12000);
const records=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const native=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const apply=action=>native('checklist_apply',{action}),load=()=>native('checklist_load');
const card=id=>page.locator(`[data-step-id="${id}"]`);
async function settle(){await page.evaluate(()=>new Promise(resolve=>{let last=-1,stable=0,frames=0;const tick=()=>{const n=document.querySelector('.workspace-scroll'),v=n?.scrollTop??0;stable=Math.abs(v-last)<.25?stable+1:0;last=v;if(stable>=6||++frames>=120)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);}));}
async function record(id,title,action,expected,observed,notes=[],status='passed'){
  await page.screenshot({path:`${output}/${id}.png`});
  records.push({id,title,section:'导航、外观与窗口',action,expected,observed,status,screenshotPath:`${output}/${id}.png`,notes});await writeFile(`${output}/records.json`,JSON.stringify(records,null,2));
}
try{
 await page.setViewportSize({width:1360,height:780});
 const document={parameters:[{id:'env',name:'环境',description:'本次维护目标',defaultValue:'sandboxa'}],groups:[{id:'prep',name:'维护准备'},{id:'patch',name:'更新测试服'},{id:'finish',name:'维护收尾'}],steps:Array.from({length:28},(_,i)=>({id:`n${i}`,groupId:i<6?'prep':i<23?'patch':'finish',title:[`${String(i+1).padStart(2,'0')} ${['核对维护窗口','停止测试服','检查发布内容','同步资源','启动服务','检查服务日志','通知复核'][i%7]}`],description:[i===8?Array.from({length:18},(_,j)=>`检查项目 ${j+1}：比对输出和预期服务状态。`).join('\n'):'在外部工具核对结果后，回到本页记录。'],commands:i%3?[{id:`nc${i}`,text:['check-status ',{parameterId:'env'},` service-${i}`]}]:[]}))};
 await apply({type:'create_work',id:'navigation-audit',name:'外服补丁维护 · 长流程验收',document});await apply({type:'start_instance',id:'navigation-audit'});
 for(let i=0;i<8;i++)await apply({type:'record_result',id:'navigation-audit',outcome:i===3?'skipped':'completed',reason:i===3?'本次无该项变更':null});
 await page.reload();await page.locator('[data-instance-id="navigation-audit"]').click();await settle();
 await expect(card('n8')).toHaveClass(/is-current/);
 await record('N01','长流程默认聚焦当前步骤','打开进行中的工作记录','正文展开当前步骤，左侧显示整体进度','28步流程打开后聚焦第9步，已完成与跳过状态保留',['前置流程与8条历史结果通过原生接口建立，打开和导航为真实UI操作']);
 await page.getByRole('button',{name:'展开步骤目录',exact:true}).click();await expect(page.locator('.step-navigation')).toHaveClass(/expanded/);
 await record('N02','展开左侧目录','点击左侧目录图标','显示步骤名称、组分界和状态','目录展开，进度与当前阅读位置保持一致');
 const nav=page.locator('[data-nav-step-id="n10"]');await nav.hover();await expect(page.locator('.step-nav-preview')).toBeVisible();
 await record('N03','悬停预览步骤','鼠标移到目录中的后续步骤','无需跳转即可查看说明和命令','悬浮预览展示目标步骤内容，执行位置未改变');
 await nav.click();await settle();await expect(card('n10')).toHaveClass(/is-expanded/);assert.equal((await load()).instances.find(w=>w.id==='navigation-audit').currentStepId,'n8');
 await page.mouse.move(1330,70);await record('N04','目录定位与返回当前步骤','点击后续步骤，再使用“返回当前步骤”','浏览位置与执行位置独立','点击目录展开并定位目标，当前执行仍停留第9步');
 await page.getByRole('button',{name:'返回当前步骤',exact:true}).click();await settle();await expect(card('n8')).toHaveClass(/is-expanded/);
 await page.getByRole('button',{name:'收起步骤目录',exact:true}).click();
 await page.getByRole('button',{name:'收起变量面板',exact:true}).click();await expect(page.getByRole('button',{name:'展开变量面板',exact:true})).toBeVisible();
 await record('N05','收起两侧面板','收起目录和变量面板','正文获得更多空间，入口仍可见','左右面板收起，长说明区域可用宽度增加');
 await page.getByRole('button',{name:'展开变量面板',exact:true}).click();
 await page.locator('.theme-switcher').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await record('N06','单按钮切换暗夜主题','点击顶栏太阳或月亮按钮','主题切换不丢失当前工作和浏览位置','进入暗夜，当前步骤与面板状态保持');
 await page.setViewportSize({width:940,height:700});await settle();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await record('N07','窄窗口布局','将窗口内容区域缩到940像素宽','主内容、目录与变量栏仍可操作','侧栏收紧，正文没有横向溢出',['WebView2视口调整用于窄屏布局验收；跨显示器缩放与真实DPI未覆盖']);
 await page.setViewportSize({width:1360,height:780});await card('n8').getByRole('button',{name:'完成并下一步',exact:true}).click();await settle();await expect(card('n9')).toHaveClass(/is-current/);await expect(card('n9')).toHaveClass(/is-expanded/);
 await record('N08','完成后聚焦下一步','点击“完成并下一步”','保存结果后平滑定位下一步骤','第9步记录完成，第10步自动展开并成为当前步骤',['完整逐帧过冲检查另由本轮26次推进专项提供证据']);
 await page.getByRole('button',{name:'展开步骤目录',exact:true}).click();const keyboardNav=page.locator('[data-nav-step-id="n9"]');await keyboardNav.focus();await keyboardNav.press('ArrowDown');await expect(page.locator('[data-nav-step-id="n10"]')).toBeFocused();await page.keyboard.press('Enter');await settle();await expect(card('n10')).toHaveClass(/is-expanded/);
 await record('N09','目录键盘浏览','在目录使用方向键，再按Enter定位','焦点与定位均可用键盘完成','方向键切换条目，Enter展开对应步骤');
 // Native window actions are real, while screenshots still capture WebView content.
 const win=command=>native(`plugin:window|${command}`,{label:'main'});
 if(await win('is_maximized'))await page.getByRole('button',{name:'还原窗口',exact:true}).click();
 await page.getByRole('button',{name:'最大化窗口',exact:true}).click();await expect.poll(()=>win('is_maximized')).toBe(true);
 await page.getByRole('button',{name:'还原窗口',exact:true}).click();await expect.poll(()=>win('is_maximized')).toBe(false);
 await record('N10','窗口最大化与还原','点击顶栏最大化，再点击还原','窗口状态改变，内容和记录保留','原生窗口状态两次变化均确认，工作页面继续可用',['截图为还原后的WebView内容；窗口拖动、系统贴边停靠未覆盖']);
 assert.deepEqual(errors,[]);await writeFile(`${output}/inspection.json`,JSON.stringify({ok:true,directory,records,errors},null,2));console.log(JSON.stringify({ok:true,directory,records:records.length}));
}catch(error){await page.screenshot({path:`${output}/failure.png`}).catch(()=>{});await writeFile(`${output}/inspection.json`,JSON.stringify({ok:false,directory,records,errors,error:String(error)},null,2));throw error;}finally{await browser.close();}
