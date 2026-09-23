import { useEffect, useRef, useState } from 'react';
import { redirect, useFetcher } from 'react-router';
import { api, unwrap } from '../api';
import { ThemeSelector } from '../theme-selector';
import { TimezonePicker } from '../timezone-picker';
import type { ThemeId } from '../../shared/theme';
import type { MailConfiguration, MailSecurity, PasswordAction } from '../../server/mail';
import type { Settings } from '../../server/settings';
import { mailPasswordAction } from '../mail-form';
import { useThemeRuntime } from '../theme-runtime';
import { PasswordField } from '../password-field';
import { Switch } from '../switch';
import { TransientSuccess } from '../transient-success';
import type { Route } from './+types/settings';

export async function clientLoader() {
  const { user, isAdmin } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  if (!isAdmin) throw new Response('Administrator access required.', { status: 403 });
  const [{ settings }, { configuration }] = await Promise.all([
    unwrap(await api.settings.$get()), unwrap(await api.admin.mail.$get()),
  ]);
  return { settings, mail: configuration };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function mailStatus(mail: MailConfiguration) {
  if (mail.operationalState === 'disabled') return { value: 'disabled', label: 'Disabled' };
  if (mail.operationalState === 'credential-unavailable') {
    return { value: 'credential-unavailable', label: 'Credential unavailable' };
  }
  if (mail.operationalState === 'incomplete') return { value: 'incomplete', label: 'Incomplete' };
  const labels = {
    'not-verified': 'Not verified', verified: 'Verified', 'connection-failed': 'Connection failed',
    'authentication-failed': 'Authentication failed', 'delivery-failed': 'Delivery failed',
  } as const;
  return { value: mail.verificationStatus, label: labels[mail.verificationStatus] };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.formData();
  const intent = String(data.get('intent') ?? '');
  try {
    if (intent === 'settings') {
      const ceiling = String(data.get('apiTokenMaxLifetimeDays') ?? '').trim();
      const { settings } = await unwrap(await api.settings.$patch({ json: {
        requirePhoto: data.get('requirePhoto') === 'on', displayTimezone: String(data.get('displayTimezone') ?? ''),
        themeId: String(data.get('themeId') ?? '') as ThemeId,
        // Blank is the unconfigured state: no ceiling, so a token may be
        // created with no expiry. It is not a number Kannabi chose.
        apiTokenMaxLifetimeDays: ceiling === '' ? null : Number(ceiling),
      } }));
      return { kind: 'settings' as const, saved: true, error: null, settings };
    }
    if (intent === 'mail') {
      const passwordAction = String(data.get('passwordAction'));
      const password: PasswordAction = passwordAction === 'replace'
        ? { action: 'replace', value: String(data.get('smtpPassword') ?? '') }
        : passwordAction === 'clear' ? { action: 'clear' } : { action: 'preserve' };
      const port = String(data.get('smtpPort') ?? '');
      const { configuration } = await unwrap(await api.admin.mail.$put({ json: {
        revision: Number(data.get('revision')), enabled: data.get('enabled') === 'on', transport: 'smtp',
        smtpHost: String(data.get('smtpHost') ?? ''), smtpPort: port ? Number(port) : null,
        smtpSecurity: String(data.get('smtpSecurity') ?? '') as MailSecurity,
        smtpUsername: String(data.get('smtpUsername') ?? ''), senderAddress: String(data.get('senderAddress') ?? ''),
        senderName: String(data.get('senderName') ?? ''), password,
      } }));
      return { kind: 'mail' as const, saved: true, error: null, configuration };
    }
    if (intent === 'mail-test') {
      await unwrap(await api.admin.mail.test.$post({ json: { recipient: String(data.get('recipient') ?? '') } }));
      return { kind: 'mail-test' as const, saved: true, error: null };
    }
    if (intent === 'secret-reset') {
      const { configuration } = await unwrap(await api.admin.secrets.reset.$post({ json: {
        revision: Number(data.get('revision')),
        confirmation: data.get('confirmed') === 'on' ? 'reset-encrypted-secrets' : '',
      } }));
      return { kind: 'secret-reset' as const, saved: true, error: null, configuration };
    }
    throw new Error('Unsupported settings action');
  } catch (error) {
    return { kind: intent, saved: false, error: errorMessage(error, 'Settings request failed') };
  }
}

function MailSettings({ mail }: { mail: MailConfiguration }) {
  const save = useFetcher<typeof clientAction>();
  const test = useFetcher<typeof clientAction>();
  const reset = useFetcher<typeof clientAction>();
  const [dirty, setDirty] = useState(false);
  const [security, setSecurity] = useState<MailSecurity | ''>(mail.smtpSecurity ?? '');
  const [smtpUsername, setSmtpUsername] = useState(mail.smtpUsername ?? '');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const recoveryRequired = mail.masterKeyState !== 'ready' || mail.passwordState === 'unavailable';
  const passwordAction = mailPasswordAction(mail.passwordState, security, smtpPassword, removePassword);
  const saveBusy = save.state !== 'idle';
  useEffect(() => {
    setSecurity(mail.smtpSecurity ?? '');
    setSmtpUsername(mail.smtpUsername ?? '');
    setSmtpPassword('');
    setRemovePassword(false);
  }, [mail.revision, mail.smtpSecurity, mail.smtpUsername]);
  useEffect(() => {
    if (save.data?.kind === 'mail' && save.data.saved && save.data.configuration) {
      setDirty(false);
      setSmtpPassword('');
      setRemovePassword(false);
    }
  }, [save.data]);
  const result = save.data?.kind === 'mail' ? save.data : null;
  const testResult = test.data?.kind === 'mail-test' ? test.data : null;
  const resetResult = reset.data?.kind === 'secret-reset' ? reset.data : null;
  const status = mailStatus(mail);
  return <section className="panel form-panel mail-settings"><div className="section-heading">
    <div><h2>Mail delivery</h2><p className="hint">Configure SMTP delivery for Kannabi transactional mail.</p></div>
    <div className="mail-status"><span className={`badge mail-state ${status.value}`}>{status.label}</span>
      {mail.verificationObservedAt && <time dateTime={mail.verificationObservedAt}
        title={new Date(mail.verificationObservedAt).toLocaleString()}>Observed {new Date(mail.verificationObservedAt).toLocaleString()}</time>}
    </div>
  </div>
    {result?.error && <p role="alert">{result.error}</p>}
    <save.Form method="post" key={mail.revision} onChange={() => setDirty(true)}>
      <fieldset disabled={saveBusy || recoveryRequired} aria-busy={saveBusy}>
        <input type="hidden" name="intent" value="mail" /><input type="hidden" name="revision" value={mail.revision} />
        <input type="hidden" name="passwordAction" value={passwordAction.action} />
        <Switch name="enabled" defaultChecked={mail.enabled} label="Enable mail delivery" />
        <div className="grid">
          <label>SMTP host<input name="smtpHost" defaultValue={mail.smtpHost ?? ''} maxLength={253} autoComplete="off" /></label>
          <label>SMTP port<input name="smtpPort" type="number" min="1" max="65535" defaultValue={mail.smtpPort ?? ''} /></label>
        </div>
        <label>SMTP security<select name="smtpSecurity" value={security}
          aria-describedby="smtp-security-help" onChange={(event) => setSecurity(event.currentTarget.value as MailSecurity | '')}>
          <option value="">Select security mode</option><option value="starttls">STARTTLS (usually port 587)</option>
          <option value="tls">TLS (usually port 465)</option><option value="none">None</option>
        </select></label>
        <p id="smtp-security-help" className="setting-help">Use the connection security mode required by your SMTP provider.</p>
        {security === 'none' ? <div className="mail-auth-disabled">
          <input type="hidden" name="smtpUsername" value="" />
          <p>Authentication is unavailable without connection security. Saving this mode removes any configured SMTP credentials.</p>
        </div> : <div className="mail-authentication">
          {removePassword && <input type="hidden" name="smtpUsername" value="" />}
          <label>SMTP username<input name={removePassword ? undefined : 'smtpUsername'} value={smtpUsername}
            disabled={removePassword} maxLength={320} autoComplete="username"
            onChange={(event) => setSmtpUsername(event.currentTarget.value)} /></label>
          <fieldset className="credential-field"><legend className="sr-only">SMTP password</legend>
            <div className="credential-heading">
              <label id="smtp-password-label" htmlFor="smtp-password">SMTP password</label>
            </div>
            {mail.passwordState === 'configured' && !removePassword
              ? <div className="credential-context"><p id="smtp-password-help" className="hint">Configured. Leave blank to keep current password.</p>
                <button type="button" className="credential-remove" onClick={() => {
                  setRemovePassword(true); setSmtpPassword(''); setDirty(true);
                }}>Remove password</button></div>
              : mail.passwordState === 'unavailable'
                ? <p id="smtp-password-help" className="hint">Unavailable — instance master-key recovery is required.</p>
                : removePassword
                  ? <div className="credential-context"><p id="smtp-password-help" className="hint">Password and username will be removed when saved.</p>
                    <button type="button" className="credential-remove" onClick={() => {
                      setRemovePassword(false); setDirty(true);
                    }}>Undo password removal</button></div>
                  : null}
            <div className="credential-password-input"><PasswordField id="smtp-password" label="SMTP password"
              aria-labelledby="smtp-password-label" name="smtpPassword" value={smtpPassword}
              maxLength={1024} autoComplete="new-password"
              aria-describedby={mail.passwordState !== 'none' || removePassword ? 'smtp-password-help' : undefined}
              placeholder={mail.passwordState === 'configured' && !removePassword ? 'Leave blank to keep current password' : ''}
              disabled={removePassword || mail.passwordState === 'unavailable'}
              onChange={(event) => { setSmtpPassword(event.currentTarget.value); setRemovePassword(false); }} /></div>
          </fieldset>
        </div>}
        <div className="grid">
          <label>Sender email<input name="senderAddress" type="email" defaultValue={mail.senderAddress ?? ''} maxLength={254} /></label>
          <label>Sender name<input name="senderName" defaultValue={mail.senderName ?? ''} maxLength={100} /></label>
        </div>
        <div className="mail-action-row"><button disabled={saveBusy}>{saveBusy ? 'Saving…' : 'Save mail configuration'}</button>
          <div className="mail-action-status" role="status" aria-live="polite" aria-atomic="true">
            <TransientSuccess trigger={result?.saved && !dirty ? result : null} label="Saved" />
          </div>
        </div>
      </fieldset>
    </save.Form>

    <div className="mail-test"><h3>Test delivery</h3><p className="hint">Uses currently persisted configuration.</p>
      {testResult?.error && <p role="alert">{testResult.error}</p>}
      <test.Form method="post" className="inline"><input type="hidden" name="intent" value="mail-test" />
        <label>Test recipient<input name="recipient" type="email" required maxLength={254} /></label>
        <div className="mail-test-action"><button disabled={dirty || mail.operationalState !== 'configured' || test.state !== 'idle'}>
          {test.state !== 'idle' ? 'Sending…' : 'Send test email'}</button>
          <div className="mail-action-status" role="status" aria-live="polite" aria-atomic="true">
            <TransientSuccess trigger={testResult?.saved ? testResult : null} label="Sent" />
          </div>
        </div>
      </test.Form>
      {dirty && <p className="hint">Save mail changes before testing.</p>}
    </div>

    {mail.masterKeyState !== 'ready' || mail.passwordState === 'unavailable' ? <div className="secret-recovery"><h3>Instance master-key recovery</h3>
      <p>Restore the instance master key and restart Kannabi, or explicitly reset all encrypted credentials. Reset disables mail and cannot be undone.</p>
      {resetResult?.error && <p role="alert">{resetResult.error}</p>}
      <div className="secret-reset-status" role="status" aria-live="polite" aria-atomic="true">
        <TransientSuccess trigger={resetResult?.saved ? resetResult : null} label="Encrypted credentials reset" />
      </div>
      <reset.Form method="post"><input type="hidden" name="intent" value="secret-reset" />
        <input type="hidden" name="revision" value={mail.revision} />
        <label className="checkbox"><input type="checkbox" name="confirmed" required />I understand this removes all encrypted credentials.</label>
        <button className="danger" disabled={reset.state !== 'idle'}>Reset encrypted credentials</button>
      </reset.Form>
    </div> : null}
  </section>;
}

export default function Administration({ loaderData: { settings, mail } }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const { colorScheme, setColorSchemePreview, setThemeId } = useThemeRuntime();
  const persisted = useRef(settings);
  const previous = useRef(settings);
  const [current, setCurrent] = useState(settings);
  const [previewMode, setPreviewMode] = useState<'light' | 'dark' | null>(null);
  const busy = fetcher.state !== 'idle';
  useEffect(() => () => setColorSchemePreview(null), [setColorSchemePreview]);
  useEffect(() => {
    if (busy) return;
    persisted.current = settings;
    setCurrent(settings);
  }, [settings, busy]);
  useEffect(() => {
    if (busy || fetcher.data?.kind !== 'settings') return;
    if (fetcher.data.saved && fetcher.data.settings) {
      persisted.current = fetcher.data.settings;
      setCurrent(fetcher.data.settings);
    } else if (!fetcher.data.saved) {
      persisted.current = previous.current;
      setCurrent(previous.current);
      setThemeId(previous.current.themeId);
    }
  }, [busy, fetcher.data, setThemeId]);

  function update(change: Partial<Settings>) {
    const next = { ...persisted.current, ...change };
    previous.current = persisted.current;
    setCurrent(next);
    if (change.themeId) setThemeId(next.themeId);
    void fetcher.submit({ intent: 'settings', requirePhoto: next.requirePhoto ? 'on' : '', displayTimezone: next.displayTimezone,
      themeId: next.themeId, apiTokenMaxLifetimeDays: next.apiTokenMaxLifetimeDays === null ? '' : String(next.apiTokenMaxLifetimeDays) },
    { method: 'post', action: '/admin/settings' });
  }
  function preview(mode: 'light' | 'dark') {
    setPreviewMode(mode);
    setColorSchemePreview(mode);
  }
  return <>
    <div className="page-heading settings-page-heading"><div><p className="eyebrow">Administration</p>
      <div className="settings-title-row"><h1>Instance settings</h1>
        <div className="settings-save-status" aria-live="polite" aria-atomic="true">
          {busy ? <span className="settings-status-pill saving">Saving…</span>
            : fetcher.data?.kind === 'settings' && fetcher.data.error ? <span className="settings-status-pill error" role="alert"
              title={fetcher.data.error}>Error: {fetcher.data.error}</span>
              : fetcher.data?.kind === 'settings' && fetcher.data.saved
                ? <TransientSuccess trigger={fetcher.data} label="Saved" /> : null}
        </div>
      </div>
      <p>Reporting policy, time presentation, theme, and mail delivery for this deployment.</p>
    </div></div>
    <section className="panel form-panel"><h2>Reporting, display, and appearance</h2>
      <fetcher.Form method="post"><fieldset disabled={busy} aria-busy={busy}>
        <input type="hidden" name="intent" value="settings" />
        <Switch name="requirePhoto" checked={current.requirePhoto}
          onChange={(event) => update({ requirePhoto: event.currentTarget.checked })}
          label="Require photo when reporting an Asset" />
        <p className="setting-help">Applies to new Asset reports.</p>
        <TimezonePicker name="displayTimezone" value={current.displayTimezone} disabled={busy}
          onChange={(displayTimezone) => update({ displayTimezone })} />
        <p className="setting-help">Timestamps remain stored as absolute instants.</p>
        <ThemeSelector name="themeId" value={current.themeId} previewMode={previewMode ?? colorScheme} disabled={busy}
          onChange={(themeId) => update({ themeId })} onPreviewModeChange={preview} />
        <label>Longest API token lifetime (days)
          <input name="apiTokenMaxLifetimeDays" type="number" min={1} step={1} inputMode="numeric"
            defaultValue={current.apiTokenMaxLifetimeDays ?? ''} disabled={busy}
            onBlur={(event) => {
              const raw = event.currentTarget.value.trim();
              const next = raw === '' ? null : Number(raw);
              if (next !== current.apiTokenMaxLifetimeDays) update({ apiTokenMaxLifetimeDays: next });
            }} />
        </label>
        <p className="setting-help">Leave empty to allow tokens that never expire. A token's expiry is
          absolute and is fixed when it is created.</p>
      </fieldset></fetcher.Form>
    </section>
    <MailSettings mail={mail} />
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
