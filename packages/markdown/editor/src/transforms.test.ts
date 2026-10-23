import { describe,it,expect } from 'vitest';
import { parser,GFM } from '@lezer/markdown';
import { byteToOffset,convertSelection,duplicateStep,repairDuplicateIds,unmarkStep } from './transforms';
import type { StepDefinition } from '@runbook/contracts';
function topBlocks(source:string) {
  const result:{name:string;text:string}[]=[];
  for(let block=parser.configure(GFM).parse(source).topNode.firstChild;block;block=block.nextSibling) result.push({name:block.name,text:source.slice(block.from,block.to)});
  return result;
}

describe('Markdown editor transformations',()=>{
  it('keeps Chinese and supplementary Unicode offsets exact',()=>{ expect(byteToOffset('甲🟢x',7)).toBe(3);expect(()=>byteToOffset('甲🟢x',5)).toThrow(); });
  it('adds a separate fence separator without trimming command spaces',()=>{
    const source='  Write-Output "中文"  ';
    const result=convertSelection(source,{from:0,to:source.length},'command');
    expect(result).toContain('```powershell\n  Write-Output "中文"  \n```');
    expect(result).toContain('runbook:document version="1"');
  });
  it('preserves a selected trailing newline as command content',()=>{
    const source='Write-Output one\n';
    expect(convertSelection(source,{from:0,to:source.length},'command')).toContain('Write-Output one\n\n```');
  });
  it('preserves selected CRLF, blank lines, and indentation exactly',()=>{
    const source='  Write-Output "中文😀"  \r\n\r\n';
    const converted=convertSelection(source,{from:0,to:source.length},'command');
    expect(converted).toContain('```powershell\n'+source+'\n```');
  });
  it.each([0,1,2])('converts only line %i of one paragraph, leaving adjacent prose outside the step',line=>{
    const lines=['echo first','echo middle','echo last'],source=lines.join('\n');
    const selected=lines[line]!,from=source.indexOf(selected),to=from+selected.length;
    const converted=convertSelection(source,{from,to},'command'),parsed=topBlocks(converted);
    expect(parsed.filter(b=>b.name==='FencedCode').map(b=>b.text)).toEqual(['```powershell\n'+selected+'\n```']);
    expect(parsed.filter(b=>b.name==='Paragraph').map(b=>b.text)).toEqual([
      ...(line>0?[lines.slice(0,line).join('\n')]:[]),
      ...(line<2?[lines.slice(line+1).join('\n')]:[]),
    ]);
    expect(parsed.map(b=>b.name)).toEqual([
      'CommentBlock',...(line>0?['Paragraph']:[]),
      'CommentBlock','CommentBlock','FencedCode','CommentBlock',
      ...(line<2?['Paragraph']:[]),
    ]);
    // All original text outside the selected range stays before/after the new step.
    expect(converted.slice(converted.indexOf('-->')+5,converted.indexOf('<!-- runbook:step '))).toBe(source.slice(0,from)+(from?'\n':''));
    expect(converted.slice(converted.indexOf('<!-- /runbook:step -->')+'<!-- /runbook:step -->'.length)).toBe((to<source.length?'\n':'')+source.slice(to));
  });
  it('converts an exact plain-text fragment without swallowing either side',()=>{
    const source='运行前说明 echo one 运行后说明',selected='echo one',from=source.indexOf(selected);
    const converted=convertSelection(source,{from,to:from+selected.length},'command'),parsed=topBlocks(converted);
    expect(parsed.filter(b=>b.name==='FencedCode').map(b=>b.text)).toEqual(['```powershell\necho one\n```']);
    expect(converted).toContain('运行前说明 \n\n<!-- runbook:step ');
    expect(converted).toContain('<!-- /runbook:step -->\n\n 运行后说明');
    expect(parsed.filter(b=>b.name==='Paragraph').map(b=>b.text.trim())).toEqual(['运行前说明','运行后说明']);
  });
  it.each([false,true])('preserves CRLF and selected spaces with trailing newline=%s',includeNewline=>{
    const source='维护前说明\r\n  Write-Output "中文😀"  \r\n维护后说明';
    const selected='  Write-Output "中文😀"  '+(includeNewline?'\r\n':''),from=source.indexOf('  Write-Output');
    const converted=convertSelection(source,{from,to:from+selected.length},'command'),parsed=topBlocks(converted);
    expect(parsed.filter(b=>b.name==='FencedCode').map(b=>b.text)).toEqual(['```powershell\n'+selected+'\n```']);
    expect(converted).toContain('维护前说明\r\n\r\n<!-- runbook:step ');
    expect(converted).toContain('<!-- /runbook:step -->\r\n\r\n维护后说明');
    expect(parsed.filter(b=>b.name==='Paragraph').map(b=>b.text.trim())).toEqual(['维护前说明','维护后说明']);
  });
  it('keeps surrounding lines and the new command within their original step',()=>{
    const source='<!-- runbook:document version="1" -->\n\n<!-- runbook:step id="11111111-1111-4111-8111-111111111111" -->\n\n操作前检查\necho one\n操作后检查\n\n<!-- /runbook:step -->';
    const from=source.indexOf('echo one'),converted=convertSelection(source,{from,to:from+8},'command'),parsed=topBlocks(converted);
    expect(parsed.map(b=>b.name)).toEqual(['CommentBlock','CommentBlock','Paragraph','CommentBlock','FencedCode','Paragraph','CommentBlock']);
    expect(parsed.filter(b=>b.name==='FencedCode').map(b=>b.text)).toEqual(['```powershell\necho one\n```']);
    expect(parsed.filter(b=>b.name==='Paragraph').map(b=>b.text)).toEqual(['操作前检查','操作后检查']);
    expect(converted.match(/<!-- runbook:step /g)).toHaveLength(1);
    expect(converted.match(/<!-- \/runbook:step -->/g)).toHaveLength(1);
    expect(converted).toContain('操作前检查\n\n<!-- runbook:command ');
    expect(converted).toContain('```\n\n操作后检查');
  });
  it.each([
    '# Heading command',
    '<section>HTML command</section>',
    '```sh\necho command\n```',
    '    echo command',
  ])('rejects partial non-paragraph structure: %s',source=>{
    const from=source.indexOf('command');
    expect(()=>convertSelection(source,{from,to:from+7},'command')).toThrow('请选中完整');
  });
  it.each(['- echo command','1. echo command','> echo command'])('keeps list and quote structure protected: %s',source=>{
    const from=source.indexOf('echo');
    expect(()=>convertSelection(source,{from,to:source.length},'command')).toThrow('顶层');
  });
  it('rejects boundaries that split CRLF or a supplementary Unicode character',()=>{
    expect(()=>convertSelection('echo\r\nnext',{from:0,to:5},'command')).toThrow('切开');
    expect(()=>convertSelection('echo 😀 next',{from:6,to:11},'command')).toThrow('切开');
  });
  it('does not convert half a paragraph or nested quoted instructions',()=>{
    expect(()=>convertSelection('first second',{from:0,to:5},'step')).toThrow();
    expect(()=>convertSelection('> quote',{from:0,to:7},'step')).toThrow();
  });
  it('retains an existing code fence and language',()=>{
    const source='~~~bash\necho one\n~~~';
    expect(convertSelection(source,{from:0,to:source.length},'command')).toContain(source);
  });
  it('repairs duplicate real IDs while leaving fenced marker text alone',()=>{
    const id='11111111-1111-4111-8111-111111111111';
    const source=`<!-- runbook:step id="${id}" -->\n\ntext\n\n<!-- /runbook:step -->\n\n<!-- runbook:step id="${id}" -->\n\n\`\`\`\n<!-- runbook:step id="${id}" -->\n\`\`\`\n\n<!-- /runbook:step -->`;
    expect(repairDuplicateIds(source).split(id)).toHaveLength(3);
  });
  it('repairs command IDs case-insensitively without rewriting quoted comments',()=>{
    const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const source=`<!-- runbook:command id="${id}" -->\n\n\`\`\`sh\necho one\n\`\`\`\n\n<!-- runbook:command id="${id.toUpperCase()}" -->\n\n\`\`\`sh\necho two\n\`\`\`\n\n> <!-- runbook:command id="${id}" -->`;
    const result=repairDuplicateIds(source);
    expect(result.split(id)).toHaveLength(3);
    expect(result).not.toContain(id.toUpperCase());
    expect(result).toContain(`> <!-- runbook:command id="${id}" -->`);
  });
  it('converts inside an existing step without adding another header or step',()=>{
    const source='<!-- runbook:document version="1" -->\n\n<!-- runbook:step id="11111111-1111-4111-8111-111111111111" -->\n\n  echo one  \n\n<!-- /runbook:step -->';
    const from=source.indexOf('  echo one'),to=from+'  echo one  '.length;
    const converted=convertSelection(source,{from,to},'command');
    expect(converted.match(/runbook:document/g)).toHaveLength(1);
    expect(converted.match(/<!-- runbook:step /g)).toHaveLength(1);
    expect(converted).toContain('```powershell\n  echo one  \n```');
    expect(()=>convertSelection(source,{from,to},'step')).toThrow('不能嵌套');
  });
  it('rejects existing markers and already annotated commands',()=>{
    const source='<!-- runbook:document version="1" -->\n\n<!-- runbook:step id="11111111-1111-4111-8111-111111111111" -->\n\n<!-- runbook:command id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" -->\n\n```sh\necho one\n```\n\n<!-- /runbook:step -->';
    expect(()=>convertSelection(source,{from:0,to:source.length},'step')).toThrow('交互标记');
    const from=source.indexOf('```sh'),to=source.lastIndexOf('```')+3;
    expect(()=>convertSelection(source,{from,to},'command')).toThrow('已经是指令');
  });
  it('duplicates and unmarks only real identities while preserving fenced examples',()=>{
    const id='11111111-1111-4111-8111-111111111111',commandId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const source=`<!-- runbook:step id="${id}" -->\n\n# Check 中文\n\n<!-- runbook:command id="${commandId}" -->\n\n\`\`\`sh\necho '<!-- runbook:step id="${id}" -->'\n\`\`\`\n\n<!-- /runbook:step -->`;
    const step:StepDefinition={id,title:'Check 中文',markdown:'',commands:[],start:0,end:new TextEncoder().encode(source).length,content_hash:''};
    const duplicated=duplicateStep(source,step);
    expect(duplicated.split(id)).toHaveLength(4);
    expect(duplicated.split(commandId)).toHaveLength(2);
    const unmarked=unmarkStep(source,step);
    expect(unmarked).toContain(`echo '<!-- runbook:step id="${id}" -->'`);
    expect(unmarked).toContain('```sh');
    expect(unmarked).not.toContain(commandId);
    expect(unmarked).not.toContain('<!-- /runbook:step -->');
  });
});
