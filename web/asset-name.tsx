import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';

/** The Asset's name, editable where it is read.
 *
 * Renaming was a form in a panel of its own at the foot of the page, which put
 * the field a long way from the name it changes and gave one short string the
 * same weight as every capability above it. Here the heading is the control.
 *
 * It is not a general inline-edit framework: one field, one existing mutation,
 * no new authorization. A reader without edit access sees the heading and no
 * affordance at all.
 */
export function AssetName({ name, canEdit, busy, error, onSave }: {
  name: string;
  canEdit: boolean;
  busy: boolean;
  /** From the last attempt, so a refused save says why instead of silently
   * restoring the old name. */
  error: string | null;
  onSave: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Leaving edit mode has to put focus somewhere deliberate, or it falls to the
  // document and a keyboard reader loses their place on the page.
  const [returnFocus, setReturnFocus] = useState(false);

  // A save that succeeded changes the name prop; one that failed does not, so
  // the field stays open with the text the person typed and the reason.
  useEffect(() => { if (!busy && !error && editing) setEditing(false); }, [name]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  useEffect(() => {
    if (returnFocus) { trigger.current?.focus(); setReturnFocus(false); }
  }, [returnFocus]);

  function close() { setEditing(false); setReturnFocus(true); }

  if (!canEdit) return <>{name}</>;
  if (!editing) {
    return <span className="inline-flex items-baseline gap-2">
      {name}
      <Button ref={trigger} type="button" variant="outline" size="icon-sm"
        className="translate-y-[-.1em] [&_.icon]:size-4"
        aria-label={'Rename ' + name} onClick={() => setEditing(true)}>
        <Icon name="pencil" />
      </Button>
    </span>;
  }
  return <span className="block">
    <input ref={input} name="name" defaultValue={name} required disabled={busy}
      aria-label="Asset name"
      // Inherits the heading it stands in, so renaming looks like editing the
      // title rather than filling in a form that happens to be up here.
      className="w-full rounded-md border bg-card px-2 py-1 font-[inherit] text-[inherit] tracking-[inherit]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Enter') {
          event.preventDefault();
          const value = input.current?.value.trim() ?? '';
          if (value && value !== name) onSave(value); else close();
        }
      }} />
    <span className="mt-2 flex items-center gap-2 text-[1rem] font-normal tracking-normal">
      <Button type="button" size="sm" disabled={busy} onClick={() => {
        const value = input.current?.value.trim() ?? '';
        if (value && value !== name) onSave(value); else close();
      }}>{busy ? 'Saving…' : 'Save'}</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy}
        onClick={close}>Cancel</Button>
    </span>
    {error && <span role="alert" className="mt-2 block text-[.875rem] font-normal tracking-normal">{error}</span>}
  </span>;
}
