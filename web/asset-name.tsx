import { useEffect, useRef, useState } from 'react';
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

  function close() { setEditing(false); setReturnFocus(true); }
  function save() {
    const value = input.current?.value.trim() ?? '';
    if (value && value !== name) onSave(value); else close();
  }

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
  // Sized from the text it holds plus room to type, floored so a short name
  // is still comfortable and capped so a long one stops at the heading region.
  // Not a fixed width: the point is that it looks like the title becoming
  // editable, not like a form appearing where the title was.
  const width = Math.min(Math.max(name.length + 8, 24), 60);
  return <span className="inline-flex max-w-full items-baseline gap-1">
    <input ref={input} name="name" defaultValue={name} required disabled={busy} size={width}
      aria-label="Asset name"
      // Inherits the heading it stands in, so renaming looks like editing the
      // title rather than filling in a form that happens to be up here.
      className="min-w-0 max-w-full rounded-md border bg-card px-2 py-0.5 font-[inherit] text-[inherit] leading-[inherit] tracking-[inherit]"
      // Leaving the field abandons the edit. A small inline rename should not
      // hold somebody in a decision, and it must not save what they walked
      // away from; the checkmark and Enter are the only ways to commit.
      onBlur={(event) => {
        if (!commit.current?.contains(event.relatedTarget as Node)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Enter') { event.preventDefault(); save(); }
      }} />
    <span ref={commit} className="inline-flex items-center">
      <IconButton label="Save name" disabled={busy}
        className="translate-y-[-.1em] hover:bg-brand/10 hover:text-brand-text"
        onMouseDown={(event) => event.preventDefault()}
        onClick={save}><Icon name="check" /></IconButton>
    </span>
    {error && <span role="alert" className="ml-2 self-center text-[.875rem] font-normal tracking-normal">{error}</span>}
  </span>;
}
