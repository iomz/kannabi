import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** What the dialog says, kept where it can be read without opening it. */
export const photoDeletionCopy = {
  title: 'Delete photo?',
  description: 'This photo will be permanently removed from this Asset.',
  cancel: 'Cancel',
  confirm: 'Delete photo',
  confirming: 'Deleting…',
} as const;

/** One step, because there is one thing to decide.
 *
 * Deleting a photo is destructive but narrow, so it asks once and names what
 * goes. Cancel takes the resting focus: the safe answer should be the one a
 * stray keypress gives.
 */
export function PhotoDeleteConfirmation({ open, busy, error, onClose, onConfirm }: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{photoDeletionCopy.title}</AlertDialogTitle>
        <AlertDialogDescription>{photoDeletionCopy.description}</AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">
        {error.endsWith('.') ? error : error + '.'}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel>{photoDeletionCopy.cancel}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy ? photoDeletionCopy.confirming : photoDeletionCopy.confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
