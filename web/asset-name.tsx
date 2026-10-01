import { useEffect, useRef, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Icon } from './icon';
import { IconButton } from './ui';

/** The Asset's name, editable where it is read.
 *
 * Renaming was a form in a panel of its own at the foot of the page, which put
 * the field a long way from the name it changes and gave one short string the
 * same weight as every capability above it. Here the heading is the control.
 *
 * It is not a general inline-edit framework: one field, one existing mutation,
 * no new authorization. A reader without edit access sees the heading and no
 * affordance at all.
 *
 * The field is the heading with a line under it rather than a box. A bordered
 * input at heading size reads as a form having replaced the title, which is
 * the opposite of editing in place; an underline marks the text as live
 * without changing what the line looks like.
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
  const [discarding, setDiscarding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** The commit control, so leaving the field to press it is not "leaving". */
  const commit = useRef<HTMLSpanElement>(null);
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

  const typed = () => input.current?.value.trim() ?? '';
  const changed = () => typed() !== '' && typed() !== name;

  function close() { setEditing(false); setDiscarding(false); setReturnFocus(true); }
  function save() { if (changed()) onSave(typed()); else close(); }
  /** Abandoning the edit. Silent when there is nothing to lose, and asks when
   * there is: Escape and a stray click elsewhere are both easy to do by
   * accident, and what was typed is the only copy of it. An explicit save
   * never reaches here. */
  function abandon() { if (changed()) setDiscarding(true); else close(); }

  if (!canEdit) return <>{name}</>;
  if (!editing) {
    // The glyph carries the action on its own. A bordered button beside the
    // title reads as a second heading-sized element and competes with the name
    // it edits, so the chrome waits for hover and focus.
    return <span className="inline-flex items-baseline gap-1">
      {name}
      <IconButton ref={trigger} label={'Rename ' + name} className="translate-y-[-.1em]"
        onClick={() => setEditing(true)}><Icon name="pencil" /></IconButton>
    </span>;
  }
  // Sized from the text it holds plus room to type, floored so a short name is
  // still comfortable and capped so a long one stops at the heading region.
  const width = Math.min(Math.max(name.length + 6, 18), 52);
  return <span className="inline-flex max-w-full items-baseline gap-1">
    <input ref={input} name="name" defaultValue={name} required disabled={busy} size={width}
      aria-label="Asset name"
      // Inherits the heading entirely and adds one line: no box, no fill, no
      // radius. The line takes the focus colour so the live field is obvious
      // without becoming a control of a different size.
      className="min-w-0 max-w-full border-0 border-b-2 border-control-border bg-transparent px-0 pb-[.05em] font-[inherit] text-[inherit] leading-[inherit] tracking-[inherit] outline-none focus:border-focus"
      onBlur={(event) => {
        if (!commit.current?.contains(event.relatedTarget as Node)) abandon();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); abandon(); }
        if (event.key === 'Enter') { event.preventDefault(); save(); }
      }} />
    <span ref={commit} className="inline-flex items-center">
      <IconButton label="Save name" disabled={busy}
        className="translate-y-[-.1em] hover:bg-brand/10 hover:text-brand-text"
        // Pressing the checkmark must not read as leaving the field first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={save}><Icon name="check" /></IconButton>
    </span>
    {error && <span role="alert" className="ml-2 self-center text-[.875rem] font-normal tracking-normal">{error}</span>}

    <AlertDialog open={discarding} onOpenChange={(next) => { if (!next) setDiscarding(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard this name?</AlertDialogTitle>
          <AlertDialogDescription>
            This Asset will keep the name <strong>{name}</strong>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Keeping the edit is the safe answer, so it rests under focus. */}
          <AlertDialogCancel onClick={() => input.current?.focus()}>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={close}>Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </span>;
}
