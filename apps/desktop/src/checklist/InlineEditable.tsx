import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { PartsView, TextField, type TextFieldProps } from './TextField';
import { isVariableEditingSurface, useVariableEditing } from './VariableEditing';
import { snapshotReferences } from './snapshot-references';
import './inline-editing.css';

export interface InlinePartsProps extends TextFieldProps {
  className?: string;
  displayValues?: Record<string, string>;
  snapshot?: { text: string; parameterValues: Record<string, string> };
  activationKey?: string | number;
  onActivated?: () => void;
}

/** Display is the default. Placeholder text never becomes document content. */
export function InlineParts({ readOnly = false, className = '', displayValues, snapshot, activationKey, onActivated, ...props }: InlinePartsProps) {
  const variables = useVariableEditing();
  const [editing, setEditing] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const composing = useRef(false);
  const lastActivation = useRef<string | number | undefined>(undefined);
  const pendingActivation = useRef(false);
  const empty = readOnly && snapshot ? !snapshot.text.trim() : props.value.every(part => typeof part === 'string') && !props.value.join('').trim();
  useLayoutEffect(() => {
    if (readOnly || activationKey === undefined || activationKey === lastActivation.current) return;
    lastActivation.current = activationKey; pendingActivation.current = true; setEditing(true);
  }, [activationKey, readOnly]);
  useLayoutEffect(() => {
    if (!editing || !pendingActivation.current) return;
    pendingActivation.current = false; onActivated?.();
  }, [editing, onActivated]);
  useEffect(() => { if (readOnly) setEditing(false); }, [readOnly]);
  useEffect(() => { if (!editing) composing.current = false; }, [editing]);
  useEffect(() => {
    if (!editing) return;
    function externalFocus(event: FocusEvent) { if (!isVariableEditingSurface(event.target) && !(event.target instanceof Node && wrapper.current?.contains(event.target))) setEditing(false); }
    document.addEventListener('focusin', externalFocus);
    return () => document.removeEventListener('focusin', externalFocus);
  }, [editing]);
  useLayoutEffect(() => { if (!editing && restoreFocus.current) { restoreFocus.current = false; wrapper.current?.focus({ preventScroll: true }); } }, [editing]);
  function start() { if (!readOnly) setEditing(true); }
  function finish(focus = false) { restoreFocus.current = focus; setEditing(false); }
  return <div ref={wrapper} className={`inline-editable inline-parts ${props.singleLine ? 'is-title' : 'is-description'} ${editing && !readOnly ? 'is-editing' : 'is-display'} ${readOnly ? 'is-readonly' : ''} ${className}`} data-inline-field={props.label} data-inline-empty={empty} role={!editing && !readOnly ? props.singleLine ? 'group' : 'button' : undefined} tabIndex={!editing && !readOnly ? 0 : undefined} aria-label={!editing && !readOnly ? `编辑${props.label}` : undefined}
    onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}
    onClick={event => event.stopPropagation()} onDoubleClick={event => { event.stopPropagation(); start(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (editing && !props.singleLine && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !(event.target instanceof Element && event.target.closest('.variable-popover'))) { event.preventDefault(); finish(true); return; }
      if (event.defaultPrevented) return;
      if (editing) { if (event.key === 'Escape') { event.preventDefault(); finish(true); } }
      else if (!readOnly && (event.key === 'Enter' || event.key === 'F2')) { event.preventDefault(); start(); }
    }}
    onBlur={event => { const next = event.relatedTarget; if (isVariableEditingSurface(next) || (next instanceof Node && wrapper.current?.contains(next))) return; if (editing) finish(); }}>
    {editing && !readOnly ? <TextField {...props} autoFocus readOnly={false} /> : empty ? <span className="inline-empty">{props.placeholder}</span> : readOnly && snapshot ? <span className="parts-view">{snapshotReferences(props.value, snapshot.text, snapshot.parameterValues).map((part, index) => <span key={index} data-frozen-reference={part.parameterId}>{part.text}</span>)}</span> : <PartsView parts={props.value} parameters={props.parameters} values={displayValues} onVariableClick={variables && props.ownerId ? (parameterId, trigger) => variables.locateVariable({ parameterId, stepId: props.ownerId!, trigger }) : undefined} />}
    {!editing && !readOnly && props.singleLine && <button className="inline-edit-trigger" type="button" aria-label={`编辑${props.label}`} title={`编辑${props.label}（双击或 F2）`} onMouseDown={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); start(); }}><Pencil size={13} aria-hidden="true" /></button>}
  </div>;
}

export interface InlinePlainProps {
  activationKey?: number;
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  singleLine?: boolean;
  readOnly?: boolean;
  className?: string;
}

export function InlinePlain({ value, onChange, label, placeholder, singleLine = false, readOnly = false, className = '', activationKey }: InlinePlainProps) {
  const [editing, setEditing] = useState(false);
  const lastActivation = useRef<number | undefined>(undefined);
  useLayoutEffect(() => { if (!readOnly && activationKey !== undefined && activationKey !== lastActivation.current) { lastActivation.current = activationKey; setEditing(true); } }, [activationKey, readOnly]);
  const wrapper = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const restoreFocus = useRef(false);
  const composing = useRef(false);
  const empty = !value.trim();
  useEffect(() => { if (readOnly) setEditing(false); }, [readOnly]);
  useEffect(() => { if (!editing) composing.current = false; }, [editing]);
  useEffect(() => {
    if (!editing) return;
    function externalFocus(event: FocusEvent) { if (!isVariableEditingSurface(event.target) && !(event.target instanceof Node && wrapper.current?.contains(event.target))) setEditing(false); }
    document.addEventListener('focusin', externalFocus);
    return () => document.removeEventListener('focusin', externalFocus);
  }, [editing]);
  useLayoutEffect(() => {
    if (editing && !readOnly) field.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) { restoreFocus.current = false; wrapper.current?.focus({ preventScroll: true }); }
  }, [editing, readOnly]);
  function finish(focus = false) { restoreFocus.current = focus; setEditing(false); }
  const editorProps = { 'aria-label': label, value, placeholder, className: 'inline-plain-editor', onChange: (event: { target: { value: string } }) => onChange(event.target.value) };
  return <div ref={wrapper} className={`inline-editable inline-plain ${singleLine ? 'is-title' : 'is-description'} ${editing && !readOnly ? 'is-editing' : 'is-display'} ${readOnly ? 'is-readonly' : ''} ${className}`} data-inline-field={label} data-inline-empty={empty} role={!editing && !readOnly ? singleLine ? 'group' : 'button' : undefined} tabIndex={!editing && !readOnly ? 0 : undefined} aria-label={!editing && !readOnly ? `编辑${label}` : undefined}
    onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}
    onClick={event => event.stopPropagation()} onDoubleClick={event => { event.stopPropagation(); if (!readOnly) setEditing(true); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (editing) { if (event.key === 'Escape' || (event.key === 'Enter' && !event.nativeEvent.isComposing && (singleLine || event.ctrlKey || event.metaKey))) { event.preventDefault(); finish(true); } }
      else if (!readOnly && (event.key === 'Enter' || event.key === 'F2')) { event.preventDefault(); setEditing(true); }
    }}
    onBlur={event => { const next = event.relatedTarget; if (isVariableEditingSurface(next) || (next instanceof Node && wrapper.current?.contains(next))) return; if (editing) finish(); }}>
    {editing && !readOnly ? singleLine ? <input {...editorProps} ref={node => { field.current = node; }} /> : <textarea {...editorProps} rows={3} ref={node => { field.current = node; }} /> : empty ? <span className="inline-empty">{placeholder}</span> : <span>{value}</span>}
    {!editing && !readOnly && singleLine && <button className="inline-edit-trigger" type="button" aria-label={`编辑${label}`} title={`编辑${label}（双击或 F2）`} onMouseDown={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setEditing(true); }}><Pencil size={13} aria-hidden="true" /></button>}
  </div>;
}
