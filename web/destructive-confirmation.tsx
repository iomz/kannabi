import { Form } from 'react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const memberCopy = 'Deleting this member disables sign-in, removes personal account data, and removes them from every Group membership. Their Groups remain. Reported Asset history remains attributed to a non-personal deleted-member record.';
const accountCopy = 'Deleting your account disables sign-in, removes your personal account data, and removes you from every Group membership. Your Groups remain. Reported Asset history remains attributed to a non-personal deleted-member record.';

export const deletionCopy = { member: memberCopy, account: accountCopy } as const;

/** Two stages, because there are two different things to be sure of.
 *
 * The first says what deletion does and does not do — the account goes, the
 * provenance stays — and asks only that it has been read. The second asks for
 * the address, which is the part that makes deleting the wrong person hard.
 * Collapsing them would turn the explanation into something to click past.
 *
 * A blocked deletion shows neither stage: there is nothing to confirm, so it
 * says why instead of offering a path that ends in a refusal.
 */
export function DestructiveConfirmation({ open, onClose, displayName, email, mode, confirmLabel, fields, busy,
  error, blocked = false }: {
  open: boolean;
  onClose(): void;
  displayName: string;
  email: string;
  mode: 'member' | 'account';
  confirmLabel: string;
  fields: Record<string, string>;
  busy: boolean;
  error?: string | null;
  blocked?: boolean;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState('');
  // Reopening starts at the explanation again; having read it once is not a
  // standing answer.
  useEffect(() => { if (open) { setReviewed(false); setConfirmationEmail(''); } }, [open]);

  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Delete “{displayName}”</DialogTitle>
        {blocked
          ? <DialogDescription>This account is the final System administrator and cannot
            currently be deleted. Promote another member to System administrator first.</DialogDescription>
          : reviewed
            ? <DialogDescription>To confirm, type “{email}” below.</DialogDescription>
            : <DialogDescription>{deletionCopy[mode]}</DialogDescription>}
      </DialogHeader>
      {blocked ? <DialogFooter><DialogClose render={<Button variant="outline" />}>Close</DialogClose></DialogFooter>
        : reviewed ? <Form method="post" className="grid gap-4" onSubmit={(event) => {
          if (confirmationEmail !== email) event.preventDefault();
        }}>
          {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <Label htmlFor="deletion-confirmation-email" className="sr-only">Account email</Label>
          <Input id="deletion-confirmation-email" name="confirmationEmail" type="text" autoFocus
            value={confirmationEmail} autoComplete="off" spellCheck={false}
            onChange={(event) => setConfirmationEmail(event.currentTarget.value)} />
          {error && <p role="alert" className="text-sm text-destructive">
            {error.endsWith('.') ? error : error + '.'}</p>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={busy || confirmationEmail !== email}>
              {confirmLabel}</Button>
          </DialogFooter>
        </Form>
        : <>
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-text">
            This removes the personal account, not its recorded provenance.</p>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={() => setReviewed(true)}>I understand these effects</Button>
          </DialogFooter>
        </>}
    </DialogContent>
  </Dialog>;
}
