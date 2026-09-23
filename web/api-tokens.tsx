import { useEffect, useId, useRef, useState } from 'react';
import { api, unwrap } from './api';
import { apiTokenCreateInput } from './api-token-form';
import { CopyField } from './copy-field';
import { Icon } from './icon';
import { Switch } from './switch';
import { displayDate } from '../server/settings.js';

export type ApiTokenView = {
  id: string; label: string; admin: boolean; createdAt: string; expiresAt: string | null;
};

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
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (token && !node.open) {
      node.showModal();
      queueMicrotask(() => cancel.current?.focus());
    } else if (!token && node.open) node.close();
  }, [token]);
  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby={titleId}
    aria-describedby={descriptionId} onClose={onClose}>
    <div className="confirmation-dialog-card">
      <div className="confirmation-header"><h2 id={titleId}>Revoke this token?</h2>
        <button type="button" className="dialog-close" aria-label="Close revocation dialog"
          onClick={() => dialog.current?.close()}>×</button></div>
      <div className="confirmation-stage photo-confirmation-stage">
        <p id={descriptionId}>Anything still using “{token?.label}” stops working immediately.
          Changes it already made keep their recorded history.</p>
        <div className="photo-confirmation-actions">
          <button ref={cancel} type="button" className="photo-confirmation-cancel"
            onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
            {busy ? 'Revoking…' : 'Revoke token'}
          </button>
        </div>
        {error && <p className="confirmation-error" role="alert">{error.endsWith('.') ? error : error + '.'}</p>}
      </div>
    </div>
  </dialog>;
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
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const secretId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (issued && !node.open) {
      node.showModal();
      queueMicrotask(() => done.current?.focus());
    } else if (!issued && node.open) node.close();
  }, [issued]);
  return <dialog ref={dialog} className="member-dialog" aria-labelledby={titleId} onClose={onDismiss}>
    <div className="member-dialog-card">
      <div className="member-dialog-heading">
        <div><p className="eyebrow">API token</p><h2 id={titleId}>Copy “{issued?.label}”</h2></div>
        <button type="button" className="dialog-close" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
      </div>
      <p className="notice"><Icon name="info" /><span>This token is shown once. Store it now — if it is
        lost, revoke it and create another.</span></p>
      <CopyField id={secretId} value={issued?.secret ?? ''} label="Token"
        copyLabel="Copy API token" copiedLabel="API token copied" />
      <div className="profile-action-row">
        <button ref={done} type="button" onClick={() => dialog.current?.close()}>I have stored it</button>
      </div>
    </div>
  </dialog>;
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
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const titleId = useId();
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
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setLabel(''); setAdmin(false);
      setExpires(true); setDays(maxLifetimeDays === null ? '' : String(maxLifetimeDays));
      node.showModal();
      queueMicrotask(() => first.current?.focus());
    } else if (!open && node.open) node.close();
  }, [open, maxLifetimeDays]);
  return <dialog ref={dialog} className="member-dialog" aria-labelledby={titleId} onClose={onClose}>
    <div className="member-dialog-card">
      <div className="member-dialog-heading">
        <div><p className="eyebrow">API token</p><h2 id={titleId}>Create token</h2></div>
        <button type="button" className="dialog-close" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); onCreate({ label, expires, days, admin }); }}>
        <fieldset disabled={busy} aria-busy={busy}>
          <label htmlFor={labelId}>Token name
            <input ref={first} id={labelId} type="text" value={label} maxLength={80} required
              autoComplete="off" placeholder="Stocktake importer"
              onChange={(event) => setLabel(event.currentTarget.value)} />
          </label>
          <p className="hint">Only you see this. It is how you recognise the token later.</p>

          <fieldset className="api-token-lifetime">
            <legend>Expiry</legend>
            <div className="api-token-lifetime-option">
              <label className="checkbox"><input type="radio" name="lifetime" value="expires"
                checked={expires} onChange={() => setExpires(true)} />Expires after</label>
              <label htmlFor={daysId} className="sr-only">Days until this token expires</label>
              <input id={daysId} type="number" inputMode="numeric" min={1}
                max={maxLifetimeDays ?? undefined} step={1} value={days} disabled={!expires}
                onChange={(event) => setDays(event.currentTarget.value)} />
              <span className="api-token-lifetime-unit">days</span>
            </div>
            <label className="checkbox"><input type="radio" name="lifetime" value="never"
              checked={!expires} disabled={maxLifetimeDays !== null}
              onChange={() => setExpires(false)} />Never expires</label>
            <p className="hint">{maxLifetimeDays === null
              ? 'Expiry is fixed when the token is created and does not extend with use.'
              : `This instance allows at most ${maxLifetimeDays} days, so a token must expire.`}</p>
          </fieldset>

          {/* Shown only to an administrator. For everybody else the capability
              does not exist, so neither does the question. */}
          {isAdmin && <div className="api-token-admin">
            <Switch checked={admin} onChange={(event) => setAdmin(event.currentTarget.checked)}
              label="Let this token use your administrator access" />
            <details><summary>What this allows</summary>
              <p className="hint">The token can do the administrator things you can do, and stops being
                able to the moment you are no longer an administrator. It does not reach any Asset
                beyond the Groups you already belong to.</p>
            </details>
          </div>}

          <div className="profile-action-row">
            <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create token'}</button>
          </div>
          {error && <p className="confirmation-error" role="alert">{error.endsWith('.') ? error : error + '.'}</p>}
        </fieldset>
      </form>
    </div>
  </dialog>;
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
    } catch (failure) {
      setRevokeError(failure instanceof Error ? failure.message : 'The token could not be revoked');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="api-token-heading">
      <div><h2>API tokens</h2>
        <p className="hint">Let a program act with the access you already have — an integration, an
          automation, or an agent. A token never reaches anything you cannot reach yourself.</p></div>
      <button type="button" onClick={() => { setError(null); setCreating(true); }}>
        <Icon name="plus" />Create token</button>
    </div>

    {tokens.length ? <div className="member-table-frame"><table className="member-table">
      <thead><tr><th>Token</th>{isAdmin && <th>Access</th>}<th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{tokens.map((token) => <tr key={token.id}>
        <td data-label="Token">{token.label}</td>
        {isAdmin && <td data-label="Access"><span className={'badge' + (token.admin ? ' administrator' : '')}>
          {token.admin ? 'Administrator' : 'Standard'}</span></td>}
        <td data-label="Expires">{token.expiresAt
          ? <time dateTime={token.expiresAt}>{displayDate(token.expiresAt)}</time>
          : <span className="api-token-never">Never</span>}</td>
        <td data-label="Actions"><button type="button" className="api-token-revoke"
          aria-label={`Revoke ${token.label}`}
          onClick={() => { setRevokeError(null); setRevoking(token); }}>Revoke</button></td>
      </tr>)}</tbody></table></div>
      : <div className="empty-state api-token-empty">
        <p aria-hidden="true"><Icon name="key" /></p>
        <p>No API tokens yet.</p>
        <p className="hint">Create one when a program needs to act for you.</p>
      </div>}

    <CreateDialog open={creating} isAdmin={isAdmin} maxLifetimeDays={maxLifetimeDays} busy={busy}
      error={error} onClose={() => setCreating(false)} onCreate={create} />
    <IssuedSecretDialog issued={issued} onDismiss={() => setIssued(null)} />
    <RevokeDialog token={revoking} busy={busy} error={revokeError}
      onClose={() => setRevoking(null)} onConfirm={revoke} />
  </>;
}
