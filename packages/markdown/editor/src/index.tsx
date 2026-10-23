import { useEffect, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
export * from './transforms';
export * from './parameters';
export { VisualEditor } from './VisualEditor';

export interface Selection { from: number; to: number }
export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSelectionChange?: (selection: Selection) => void;
  readOnly?: boolean;
  reveal?: { from: number };
}
export function MarkdownEditor({value, onChange, onSelectionChange, readOnly = false, reveal}: MarkdownEditorProps) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  useEffect(() => {
    if (!reveal || !editor.current?.view) return;
    const view = editor.current.view;
    const position = Math.min(Math.max(reveal.from, 0), view.state.doc.length);
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 30 }) });
  }, [reveal]);
  const extensions = useMemo(() => [markdown({codeLanguages: languages}), EditorView.lineWrapping,
    EditorView.theme({ '&': {height:'100%',fontSize:'13px',backgroundColor:'#fcfdfb'}, '.cm-scroller':{fontFamily:'"Cascadia Code", Consolas, monospace',lineHeight:'1.8'}, '.cm-content':{padding:'24px 20px'}, '.cm-gutters':{backgroundColor:'#f5f7f3',border:'none',color:'#a0aaa3'}, '&.cm-focused':{outline:'none'}, '.cm-activeLine':{backgroundColor:'#eef4ee'}})
  ], []);
  return <CodeMirror ref={editor} className="markdown-editor" value={value} height="100%" readOnly={readOnly} editable={!readOnly} extensions={extensions}
    onChange={onChange} onUpdate={update => { if (update.selectionSet) onSelectionChange?.(update.state.selection.main); }}
    basicSetup={{foldGutter: true,highlightActiveLine: true,autocompletion:false}} />;
}
