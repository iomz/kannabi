import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Detaching an identifier removes an identity by which this Asset is known,
 * so it asks first.
 *
 * What it says depends on where the value came from, because the consequence
 * differs. A recorded identifier simply stops being carried. Where an installed
 * plugin has something to say about the value, such as having issued it, the
 * plugin supplies the consequence and the dialog says that instead.
 */
export function DetachIdentifierConfirmation({ identifier, consequence, busy, error, onClose, onConfirm }: {
  /** The canonical form being detached, or null when nothing is pending. */
  identifier: string | null;
  /** What detaching means for this value, from the plugin that has a
   * statement about it, or null for a value that was simply recorded. */
  consequence: string | null;
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
          {consequence ?? 'It can be recorded again later.'}
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
