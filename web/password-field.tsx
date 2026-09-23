import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const passwordVisibilityShortcut = 'Alt+Shift+V';

export function isPasswordVisibilityShortcut(event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'key'>): boolean {
  return event.altKey && event.shiftKey && event.key.toLowerCase() === 'v';
}

export function passwordVisibilityLabel(visible: boolean): 'Show password' | 'Hide password' {
  return visible ? 'Hide password' : 'Show password';
}

export function PasswordField({ label, aside, id: suppliedId, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string; aside?: ReactNode;
}) {
  const generatedId = useId();
  const shortcutId = useId();
  const id = suppliedId ?? generatedId;
  const [visible, setVisible] = useState(false);
  const describedBy = [input['aria-describedby'], shortcutId].filter(Boolean).join(' ');
  const toggleVisibility = () => setVisible((current) => !current);
  return <div className="mb-[1.15rem] grid gap-2">
    <div className="flex items-baseline justify-between gap-3">
      <Label htmlFor={id}>{label}</Label>{aside}</div>
    <div className="relative flex items-center">
      <Input {...input} id={id} type={visible ? 'text' : 'password'} className="pe-11"
        aria-describedby={describedBy} aria-keyshortcuts={passwordVisibilityShortcut}
        onKeyDown={(event) => {
          input.onKeyDown?.(event);
          if (!event.defaultPrevented && isPasswordVisibilityShortcut(event.nativeEvent)) {
            event.preventDefault();
            toggleVisibility();
          }
        }} />
      <button type="button" aria-label={passwordVisibilityLabel(visible)}
        className="absolute end-1 grid size-8 place-items-center rounded-sm text-muted-foreground hover:bg-accent [&_svg]:size-[1.15rem] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.6]"
        aria-pressed={visible} aria-keyshortcuts={passwordVisibilityShortcut} tabIndex={-1} onClick={toggleVisibility}>
        {visible ? <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 5.1 9 5.1a13.7 13.7 0 0 1-2.1 2.6M6.6 6.6C4.3 8.1 3 10 3 10s3.5 5 9 5a10.7 10.7 0 0 0 3.4-.6" /></svg>
          : <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 10s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5Z" /><circle cx="12" cy="10" r="2.5" /></svg>}
      </button></div>
    <span id={shortcutId} className="sr-only">Press Alt+Shift+V while focused here to show or hide this password.</span>
  </div>;
}
