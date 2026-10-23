import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

export function Button({ className, variant = 'default', size = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'default' | 'sm' | 'icon' }) {
  return <button className={cn('button', `button-${variant}`, `button-${size}`, className)} {...props} />;
}
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) { return <input className={cn('input', className)} {...props} />; }
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className={cn('textarea', className)} {...props} />; }
export function Dialog({ open, onOpenChange, title, description, children, footer, className, busy = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode; className?: string; busy?: boolean }) {
  return <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay" /><DialogPrimitive.Content className={cn('dialog-content', className)}><div className="dialog-heading"><div><DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title><DialogPrimitive.Description className={description ? "dialog-description" : "sr-only"}>{description || "查看内容并选择操作。"}</DialogPrimitive.Description></div><DialogPrimitive.Close asChild><Button variant="ghost" size="icon" disabled={busy} aria-label="关闭对话框"><X size={18}/></Button></DialogPrimitive.Close></div><div className="dialog-body"><fieldset className="dialog-fieldset" disabled={busy}>{children}</fieldset></div>{footer && <div className="dialog-footer"><fieldset className="dialog-fieldset" disabled={busy}>{footer}</fieldset></div>}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}
