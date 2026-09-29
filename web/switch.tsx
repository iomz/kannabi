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
export function Switch({ label, labelHidden, className, onCheckedChange, ...control }: {
  label: ReactNode;
  /** Keeps the name for assistive technology while letting the surrounding
   * line carry the words. Used where the state is already written out beside
   * the control, so showing the label again would say it twice — and where a
   * switch sits in a row of facts rather than in a stack of form fields, which
   * is also why the form-row margin goes with it. */
  labelHidden?: boolean;
  className?: string;
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return <Label className={[labelHidden ? 'w-fit' : 'mb-[1.15rem] w-fit gap-[.65rem] font-[550]',
    'cursor-pointer', control.disabled ? 'cursor-default opacity-55' : '', className]
    .filter(Boolean).join(' ')}>
    <SwitchControl {...control} onCheckedChange={(checked) => onCheckedChange?.(checked)} />
    <span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
  </Label>;
}
