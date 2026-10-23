import { useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';

export function WindowControls({ closeReady, onError }: { closeReady: boolean; onError: (reason: unknown) => void }) {
  const appWindow = useMemo(() => isTauri() ? getCurrentWindow() : null, []);
  const [maximized, setMaximized] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!appWindow) return;
    let active = true, version = 0;
    let remove: (() => void) | undefined;
    const update = async () => { const request = ++version; const value = await appWindow.isMaximized(); if (active && request === version) setMaximized(value); };
    void update().catch(onError);
    void appWindow.onResized(() => { void update().catch(onError); }).then(unlisten => { if (active) remove = unlisten; else unlisten(); }).catch(onError);
    return () => { active = false; version += 1; remove?.(); };
  }, [appWindow, onError]);
  if (!appWindow) return null;
  async function operate(action: 'minimize' | 'maximize' | 'close') {
    if (!appWindow || pending) return;
    setPending(true);
    try {
      if (action === 'minimize') await appWindow.minimize();
      else if (action === 'maximize') { await appWindow.toggleMaximize(); setMaximized(await appWindow.isMaximized()); }
      // Request close so buffered edits and local drafts are saved first.
      else await appWindow.close();
    } catch (error) { onError(`窗口操作失败：${String(error)}`); }
    finally { setPending(false); }
  }
  return <div className="window-controls" role="group" aria-label="窗口控制" data-tauri-drag-region="false">
    <button aria-label="最小化窗口" title="最小化" disabled={pending} onClick={() => void operate('minimize')}><Minus size={15} strokeWidth={1.4} /></button>
    <button aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} disabled={pending} onClick={() => void operate('maximize')}>{maximized ? <Copy size={13} strokeWidth={1.3} /> : <Square size={13} strokeWidth={1.3} />}</button>
    <button className="window-close" aria-label="关闭窗口" title="关闭" disabled={pending || !closeReady} onClick={() => void operate('close')}><X size={17} strokeWidth={1.4} /></button>
  </div>;
}
