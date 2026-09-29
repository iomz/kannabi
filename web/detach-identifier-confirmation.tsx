import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Detaching an identifier removes an identity by which this Asset is known,
 * so it asks first.
 *
 * What it says depends on where the value came from, because the consequence
 * differs. A recorded identifier simply stops being carried. A value Kannabi
 * issued stays bound to this Asset in the issuance ledger and is never reissued
 * anywhere else, so detaching it is not a release and the dialog says so rather
 * than letting somebody infer that the number returns to a pool.
 */
export function DetachIdentifierConfirmation({ identifier, issued, busy, error, onClose, onConfirm }: {
  /** The canonical form being detached, or null when nothing is pending. */
  identifier: string | null;
  /** Whether Kannabi's own ledger records issuing this value. */
  issued: boolean;
  busy: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  return <AlertDialog open={identifier !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Detach this identifier?</AlertDialogTitle>
        <AlertDialogDescription>
          <code>{identifier}</code> will no longer identify this Asset.{' '}
          {issued
            ? 'Kannabi issued this value, so it stays bound to this Asset in the issuance ledger and is never issued for anything else. It can only ever return here.'
            : 'It can be recorded again later.'}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">
        {error.endsWith('.') ? error : error + '.'}</p>}
      <AlertDialogFooter>
        {/* Cancel takes the resting focus: the safe answer should be the one a
            stray keypress gives. */}
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy ? 'Detaching…' : 'Detach'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
