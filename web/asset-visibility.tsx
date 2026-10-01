import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { HelpTip } from './ui';

/** Whether this Asset is readable by anyone with its address.
 *
 * `isPublic` is one boolean, and a switch is what a boolean usually gets. It
 * is the wrong control here anyway: publishing changes who may read an Asset,
 * and a one-click toggle makes a consequential access change as cheap as
 * changing a preference. The data shape is not the only thing a control
 * communicates.
 *
 * So the state is text a reader can just read, and changing it is a named act
 * with the consequence stated before it happens. The confirmation names the
 * outcome — Make public, Make private — because "Confirm" on a destructive or
 * disclosing change tells somebody nothing about what they are agreeing to.
 *
 * No new domain concept: this is the same `isPublic` field and the same
 * one-field PATCH.
 */
export function AssetVisibility({ isPublic, canEdit, busy, error, onChange }: {
  isPublic: boolean;
  canEdit: boolean;
  busy: boolean;
  error: string | null;
  onChange: (isPublic: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const target = !isPublic;
  return <>
    <dt className="flex items-center gap-[.15rem]">Visibility
      <HelpTip label="About visibility">Public Assets can be read by anyone with their
        address. Editing still requires Group access.</HelpTip>
    </dt>
    <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {/* The state is a word, not the position of a control. */}
      <span className="font-[550]">{isPublic ? 'Public' : 'Private'}</span>
      {canEdit && <Button type="button" variant="outline" size="xs" disabled={busy}
        onClick={() => setConfirming(true)}>Change visibility</Button>}
      {error && <span role="alert">{error}</span>}
    </dd>

    <AlertDialog open={confirming} onOpenChange={(next) => { if (!next) setConfirming(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{target ? 'Make this Asset public?' : 'Make this Asset private?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? 'Anyone with this Asset’s address will be able to read it, including its identifiers, its Groups and everything else shown on this page. They will not be able to edit it: editing stays with the Groups associated with this Asset.'
              : 'Only members of the Groups associated with this Asset will be able to read it. Anyone holding its address will no longer be able to.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel rests under focus, and the other button names the outcome
              rather than agreeing to an unnamed one. */}
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => {
            onChange(target);
            setConfirming(false);
          }}>{target ? 'Make public' : 'Make private'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
