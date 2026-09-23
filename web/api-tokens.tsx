import { useEffect, useId, useState } from 'react';
import { api, unwrap } from './api';
import { apiTokenCreateInput } from './api-token-form';
import { CopyField } from './copy-field';
import { Icon } from './icon';
import { notify } from './notify';
import { Switch } from './switch';
import { displayDate } from '../server/settings.js';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export type ApiTokenView = {
  id: string; label: string; admin: boolean; createdAt: string; expiresAt: string | null;
};

const hint = 'text-sm text-muted-foreground';

/** Deliberate without ceremony: one step, cancel focused, and the destructive
 * action named. Revoking a token is recoverable by issuing another one, so it
 * does not deserve the staged confirmation account deletion uses. */
function RevokeDialog({ token, busy, error, onClose, onConfirm }: {
  token: ApiTokenView | null;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  return <AlertDialog open={token !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Revoke this token?</AlertDialogTitle>
        <AlertDialogDescription>Anything still using “{token?.label}” stops working
          immediately. Changes it already made keep their recorded history.</AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">
        {error.endsWith('.') ? error : error + '.'}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy ? 'Revoking…' : 'Revoke token'}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

/** The secret, the one time it exists.
 *
 * Presented calmly rather than in danger colours: nothing has gone wrong and
 * nothing is being destroyed. What matters is that the value is here now and
 * will not be here again, so that is what the copy says, beside the one action
 * that takes it away.
 */
export function IssuedSecretDialog({ issued, onDismiss }: {
  issued: { label: string; secret: string } | null;
  onDismiss(): void;
}) {
  const secretId = useId();
  return <Dialog open={issued !== null} onOpenChange={(next) => { if (!next) onDismiss(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Copy “{issued?.label}”</DialogTitle>
        <DialogDescription>This token is shown once. Store it now — if it is lost, revoke it
          and create another.</DialogDescription>
      </DialogHeader>
      <CopyField id={secretId} value={issued?.secret ?? ''} label="Token"
        copyLabel="Copy API token" copiedLabel="API token copied" />
      <DialogFooter>
        <DialogClose render={<Button />}>I have stored it</DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function CreateDialog({ open, isAdmin, maxLifetimeDays, busy, error, onClose, onCreate }: {
  open: boolean;
  isAdmin: boolean;
  maxLifetimeDays: number | null;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onCreate(input: { label: string; expires: boolean; days: string; admin: boolean }): void;
}) {
  const labelId = useId();
  const daysId = useId();
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState(true);
  // The instance's own ceiling is the starting point when it has one. Where it
  // has none there is no number to suggest, so the field stays empty and the
  // choice stays with the person.
  const [days, setDays] = useState(maxLifetimeDays === null ? '' : String(maxLifetimeDays));
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLabel(''); setAdmin(false);
    setExpires(true); setDays(maxLifetimeDays === null ? '' : String(maxLifetimeDays));
  }, [open, maxLifetimeDays]);

  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Create token</DialogTitle>
        <DialogDescription>Only you see the name. It is how you recognise the token later.</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); onCreate({ label, expires, days, admin }); }}>
        <fieldset disabled={busy} aria-busy={busy} className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor={labelId}>Token name</Label>
            <Input id={labelId} type="text" value={label} maxLength={80} required autoFocus
              autoComplete="off" placeholder="Stocktake importer"
              onChange={(event) => setLabel(event.currentTarget.value)} />
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Expiry</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Label className="font-normal"><input type="radio" name="lifetime" value="expires"
                checked={expires} onChange={() => setExpires(true)} />Expires after</Label>
              <Label htmlFor={daysId} className="sr-only">Days until this token expires</Label>
              <Input id={daysId} type="number" inputMode="numeric" min={1} className="w-24"
                max={maxLifetimeDays ?? undefined} step={1} value={days} disabled={!expires}
                onChange={(event) => setDays(event.currentTarget.value)} />
              <span className="text-sm">days</span>
            </div>
            <Label className="font-normal"><input type="radio" name="lifetime" value="never"
              checked={!expires} disabled={maxLifetimeDays !== null}
              onChange={() => setExpires(false)} />Never expires</Label>
            <p className={hint}>{maxLifetimeDays === null
              ? 'Expiry is fixed when the token is created and does not extend with use.'
              : `This instance allows at most ${maxLifetimeDays} days, so a token must expire.`}</p>
          </fieldset>

          {/* Shown only to an administrator. For everybody else the capability
              does not exist, so neither does the question. */}
          {isAdmin && <div className="grid gap-1">
            <Switch checked={admin} onCheckedChange={setAdmin} className="mb-0"
              label="Let this token use your administrator access" />
            <details><summary className="cursor-pointer text-sm">What this allows</summary>
              <p className={`${hint} mt-1`}>The token can do the administrator things you can do, and
                stops being able to the moment you are no longer an administrator. It does not reach
                any Asset beyond the Groups you already belong to.</p>
            </details>
          </div>}

          {error && <p role="alert" className="text-sm text-destructive">
            {error.endsWith('.') ? error : error + '.'}</p>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create token'}</Button>
          </DialogFooter>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>;
}

/** API tokens a person manages for themself.
 *
 * Not a session manager: browser sign-ins never appear here, and nothing in
 * this surface reaches anybody else's credentials.
 */
export function ApiTokens({ tokens: initial, maxLifetimeDays, isAdmin }: {
  tokens: readonly ApiTokenView[];
  maxLifetimeDays: number | null;
  isAdmin: boolean;
}) {
  const [tokens, setTokens] = useState<readonly ApiTokenView[]>(initial);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ label: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenView | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function create(form: { label: string; expires: boolean; days: string; admin: boolean }) {
    if (busy) return;
    setError(null);
    const input = apiTokenCreateInput({ ...form, isAdmin, maxLifetimeDays });
    if (!input.body) { setError(input.error); return; }
    setBusy(true);
    try {
      const created = await unwrap(await api['api-tokens'].$post({ json: input.body }));
      setTokens((current) => [created.token, ...current]);
      setCreating(false);
      setIssued({ label: created.token.label, secret: created.secret });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The token could not be created');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    const target = revoking;
    if (!target || busy) return;
    setBusy(true);
    setRevokeError(null);
    try {
      await unwrap(await api['api-tokens'][':id'].$delete({ param: { id: target.id } }));
      setTokens((current) => current.filter((token) => token.id !== target.id));
      setRevoking(null);
      // The row is gone and the dialog with it, so the confirmation has no
      // control left to sit beside.
      notify(`“${target.label}” revoked`);
    } catch (failure) {
      setRevokeError(failure instanceof Error ? failure.message : 'The token could not be revoked');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2>API tokens</h2>
        <p className={`${hint} max-w-[46rem]`}>Let a program act with the access you already have — an
          integration, an automation, or an agent. A token never reaches anything you cannot reach
          yourself.</p></div>
      <Button type="button" onClick={() => { setError(null); setCreating(true); }}>
        <Icon name="plus" />Create token</Button>
    </div>

    {tokens.length ? <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader><TableRow>
          <TableHead>Token</TableHead>
          {isAdmin && <TableHead>Access</TableHead>}
          <TableHead>Expires</TableHead>
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>{tokens.map((token) => <TableRow key={token.id}>
          <TableCell className="font-medium">{token.label}</TableCell>
          {isAdmin && <TableCell><Badge variant={token.admin ? 'default' : 'secondary'}>
            {token.admin ? 'Administrator' : 'Standard'}</Badge></TableCell>}
          <TableCell>{token.expiresAt
            ? <time dateTime={token.expiresAt}>{displayDate(token.expiresAt)}</time>
            : <span className="text-muted-foreground">Never</span>}</TableCell>
          <TableCell className="text-right"><Button type="button" variant="ghost" size="sm"
            aria-label={`Revoke ${token.label}`}
            onClick={() => { setRevokeError(null); setRevoking(token); }}>Revoke</Button></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>
      : <div className="grid justify-items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
        <p aria-hidden="true" className="text-muted-foreground"><Icon name="key" /></p>
        <p>No API tokens yet.</p>
        <p className={hint}>Create one when a program needs to act for you.</p>
      </div>}

    <CreateDialog open={creating} isAdmin={isAdmin} maxLifetimeDays={maxLifetimeDays} busy={busy}
      error={error} onClose={() => setCreating(false)} onCreate={create} />
    <IssuedSecretDialog issued={issued} onDismiss={() => setIssued(null)} />
    <RevokeDialog token={revoking} busy={busy} error={revokeError}
      onClose={() => setRevoking(null)} onConfirm={revoke} />
  </>;
}
