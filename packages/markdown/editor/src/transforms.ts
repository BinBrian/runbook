import { parser, GFM } from '@lezer/markdown';
import type { StepDefinition } from '@runbook/contracts';

type Selection = {from:number;to:number};
type Block = Selection & {name:string;text:string};
const FORMAT = '<!-- runbook:document version="1" -->';
const marker = /^<!--\s*(?:\/?runbook:)(?:document|parameters|step|command)\b[^]*?-->$/;
function blocks(source:string):Block[] {
  const result:Block[]=[];
  const root = parser.configure(GFM).parse(source).topNode;
  for (let child=root.firstChild;child;child=child.nextSibling) result.push({from:child.from,to:child.to,name:child.name,text:source.slice(child.from,child.to)});
  return result;
}
function isMarker(block:Block) { return block.name === 'CommentBlock' && marker.test(block.text.trim()); }
function newId() { return crypto.randomUUID(); }
function ensureHeader(source:string) { return blocks(source).some(b=>b.name==='CommentBlock' && b.text.trim()===FORMAT) ? source : `${FORMAT}\n\n${source}`; }
function withBoundaries(source:string, from:number,to:number,value:string):string {
  const before=source.slice(0,from),after=source.slice(to);
  const endings=(text:string)=>text.match(/\r\n|\n|\r/g)??[];
  const trailing=(text:string)=>endings(text.match(/(?:\r\n|\n|\r)+$/)?.[0]??'').length;
  const leading=(text:string)=>endings(text.match(/^(?:\r\n|\n|\r)+/)?.[0]??'').length;
  const beforeEnding=endings(before).at(-1)??endings(source)[0]??'\n';
  const afterEnding=endings(after)[0]??beforeEnding;
  // A single line break cannot reliably interrupt an existing paragraph with
  // an HTML comment. Add only structural separators, outside command content.
  const prefix=before ? beforeEnding.repeat(Math.max(0,2-trailing(before)-leading(value))) : '';
  const suffix=after ? afterEnding.repeat(Math.max(0,2-trailing(value)-leading(after))) : '';
  return before+prefix+value+suffix+after;
}
export function convertSelection(source:string, selection:Selection, kind:'step'|'command'):string {
  if(!Number.isInteger(selection.from)||!Number.isInteger(selection.to)||selection.from<0||selection.to>source.length||selection.from>=selection.to) throw new Error('请先选择需要转换的文本或完整代码块。');
  const splitsCharacter=(at:number)=>at>0&&at<source.length&&((/[\uD800-\uDBFF]/.test(source[at-1]!)&&/[\uDC00-\uDFFF]/.test(source[at]!))||(source[at-1]==='\r'&&source[at]==='\n'));
  if(splitsCharacter(selection.from)||splitsCharacter(selection.to)) throw new Error('选区切开了字符或换行，请重新选择。');
  const selected=blocks(source).filter(b=>b.to>selection.from && b.from<selection.to);
  if (selection.from===selection.to || !selected.length) throw new Error('请先选择需要转换的完整段落或代码块。');
  if (selected.some(b=>b.name==='BulletList'||b.name==='OrderedList'||b.name==='Blockquote')) throw new Error('请将需要转换的内容放在顶层段落或代码块中。');
  if (selected.some(isMarker)) throw new Error('选区包含交互标记，请选择步骤正文。');
  const first=selected[0]!,last=selected[selected.length-1]!;
  const existingFence=selected.length===1 && first.name==='FencedCode';
  const exactParagraphCommand=kind==='command'&&selected.length===1&&first.name==='Paragraph';
  const partialBlock=source.slice(first.from,selection.from).trim()||source.slice(selection.to,last.to).trim();
  if(!exactParagraphCommand&&partialBlock) throw new Error(kind==='step'?'转为步骤时请选中完整段落或代码块。':'请选中完整的标题、HTML 或代码围栏；普通段落可只选择需要转换的文本。');
  // A paragraph can span several consecutive source lines. Commands use the
  // actual selection so surrounding prose never becomes executable text.
  // Whole-block operations retain selected boundary whitespace as before.
  const from=exactParagraphCommand?selection.from:Math.min(first.from,selection.from);
  const to=exactParagraphCommand?selection.to:Math.max(last.to,selection.to);
  let currentStep:string|null=null;
  for (const block of blocks(source)) {
    if (block.from>=from) break;
    if (block.name!=='CommentBlock') continue;
    const open=block.text.trim().match(/^<!-- runbook:step id="([^"]+)" -->$/);
    if(open) currentStep=open[1]!;
    if(block.text.trim()==='<!-- /runbook:step -->') currentStep=null;
  }
  if(kind==='step' && currentStep) throw new Error('选区已在步骤内，不能嵌套步骤。');
  const previous=blocks(source).filter(b=>b.to<=from).at(-1);
  if(kind==='command' && previous?.name==='CommentBlock' && /^<!-- runbook:command /.test(previous.text.trim())) throw new Error('该代码块已经是指令。');
  let value=source.slice(from,to);
  if(kind==='command') {
    if(!value.trim()) throw new Error('指令正文不能为空。');
    if(!existingFence) {
      // Selection trailing whitespace belongs to the user's command; add a separate structural newline.
      const longest=Math.max(0,...[...value.matchAll(/`+/g)].map(m=>m[0].length));
      const fence='`'.repeat(Math.max(3,longest+1));
      value=`${fence}powershell\n${value}\n${fence}`;
    }
    value=`<!-- runbook:command id="${newId()}" -->\n\n${value}`;
  }
  if(!currentStep) value=`<!-- runbook:step id="${newId()}" -->\n\n${value}\n\n<!-- /runbook:step -->`;
  return ensureHeader(withBoundaries(source,from,to,value));
}
export function byteToOffset(source:string, byte:number):number {
  const bytes=new TextEncoder().encode(source);
  if(!Number.isInteger(byte)||byte<0||byte>bytes.length) throw new Error('文档位置已失效，请重新选择。');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(0,byte)).length;
}
function span(source:string,step:StepDefinition):Selection { return {from:byteToOffset(source,step.start),to:byteToOffset(source,step.end)}; }
export function moveStep(source:string,step:StepDefinition,direction:-1|1,steps:StepDefinition[]):string {
  const ordered=[...steps].sort((a,b)=>a.start-b.start),at=ordered.findIndex(s=>s.id===step.id),other=ordered[at+direction];
  if(!other) return source;
  const [a,b]=[step,other].sort((a,b)=>a.start-b.start).map(s=>span(source,s));
  if(!a||!b) return source;
  return source.slice(0,a.from)+source.slice(b.from,b.to)+source.slice(a.to,b.from)+source.slice(a.from,a.to)+source.slice(b.to);
}
function rewriteIds(source:string, all:boolean):string {
  const edits:{from:number;to:number;value:string}[]=[],seen=new Set<string>();
  for(const block of blocks(source)) {
    if(block.name!=='CommentBlock') continue;
    const match=block.text.match(/^(\s*<!-- runbook:(?:step|command) id=")([^"]+)(" -->\s*)$/);
    if(!match) continue;
    const identity=match[2]!.toLowerCase();
    if(all||seen.has(identity)) edits.push({from:block.from,to:block.to,value:match[1]+newId()+match[3]});
    seen.add(identity);
  }
  return edits.reverse().reduce((text,e)=>text.slice(0,e.from)+e.value+text.slice(e.to),source);
}
export function duplicateStep(source:string,step:StepDefinition):string {
  const {from,to}=span(source,step);
  return source.slice(0,to)+'\n\n'+rewriteIds(source.slice(from,to),true)+source.slice(to);
}
export function removeStep(source:string,step:StepDefinition):string { const {from,to}=span(source,step);return source.slice(0,from)+source.slice(to); }
export function unmarkStep(source:string,step:StepDefinition):string {
  const {from,to}=span(source,step),part=source.slice(from,to);
  const plain=blocks(part).filter(isMarker).reverse().reduce((text,b)=>text.slice(0,b.from)+text.slice(b.to),part);
  return source.slice(0,from)+plain+source.slice(to);
}
export function repairDuplicateIds(source:string):string { return rewriteIds(source,false); }
