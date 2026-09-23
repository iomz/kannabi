import type { ReactNode } from 'react';
import { Switch as SwitchControl } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

/** A switch that is always named by the words beside it.
 *
 * The label wraps the control rather than pointing at it, so the words are
 * part of the target: a switch is a small thing to hit, and reading one that
 * has no name is worse. The control keeps a real form field underneath, so a
 * switch inside a `<Form>` submits like a checkbox and is restored by a reset.
 */
export function Switch({ label, className, onCheckedChange, ...control }: {
  label: ReactNode;
  className?: string;
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return <Label className={['mb-[1.15rem] w-fit cursor-pointer gap-[.65rem] font-[550]',
    control.disabled ? 'cursor-default opacity-55' : '', className].filter(Boolean).join(' ')}>
    <SwitchControl {...control} onCheckedChange={(checked) => onCheckedChange?.(checked)} />
    <span>{label}</span>
  </Label>;
}
