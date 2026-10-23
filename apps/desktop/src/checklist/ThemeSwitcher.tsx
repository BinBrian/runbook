import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { changeTheme, currentTheme } from './theme';

export function ThemeSwitcher() {
  const [theme, setTheme] = useState(currentTheme);
  const label = theme === 'dark' ? '切换为纯白' : '切换为暗夜';
  const Icon = theme === 'dark' ? Moon : Sun;
  function toggle() { const value = theme === 'dark' ? 'light' : 'dark'; changeTheme(value); setTheme(value); }
  return <button className="icon-button theme-switcher appearance-control" type="button" data-tauri-drag-region="false"
    data-theme={theme} aria-label={label} title={label}
    onMouseDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={toggle}>
    <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
  </button>;
}
