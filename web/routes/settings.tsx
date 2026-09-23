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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ActionRow, ActionStatus, Eyebrow, Field, Hint, NativeSelect, Panel, SectionHeading,
  StatusPill } from '../ui';

/** Two fields that belong together on one line where there is room. */
const twoUp = 'grid grid-cols-2 gap-4 max-sm:grid-cols-1';
/** A note attached to the control above it rather than to the page. */
const settingHelp = 'mt-[-.7rem] mb-[1.15rem] text-[.78rem] text-muted-foreground';
const subSection = 'mt-7 border-t pt-6';
const subHeading = 'mt-0 mb-[.35rem] text-[.95rem]';
const credentialContext = 'mb-[.7rem] flex flex-wrap items-baseline gap-x-[.65rem] gap-y-[.35rem]';
const credentialAction = 'h-auto shrink-0 p-0 text-[.78rem] font-medium';

/** Delivery state is a fact about the instance, not a severity scale — but a
 * state that stops mail being sent has to read differently from one that does
 * not, without relying on the reader to know which is which. */
function mailStateTone(state: string): string {
  if (state === 'verified') return 'bg-success-surface text-success-text';
  return ['credential-unavailable', 'incomplete', 'connection-failed', 'authentication-failed',
    'delivery-failed'].includes(state) ? 'bg-danger-surface text-danger-text' : '';
}

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
  return <Panel form><SectionHeading className="mb-6">
    <div><h2 className="mb-1">Mail delivery</h2><Hint>Configure SMTP delivery for Kannabi transactional mail.</Hint></div>
    <div className="grid justify-items-end gap-[.3rem]">
      <Badge variant="secondary" className={'capitalize ' + mailStateTone(status.value)}>{status.label}</Badge>
      {mail.verificationObservedAt && <time dateTime={mail.verificationObservedAt} className="whitespace-nowrap text-[.67rem] text-muted-foreground"
        title={new Date(mail.verificationObservedAt).toLocaleString()}>Observed {new Date(mail.verificationObservedAt).toLocaleString()}</time>}
    </div>
  </SectionHeading>
    {result?.error && <p role="alert">{result.error}</p>}
    <save.Form method="post" key={mail.revision} onChange={() => setDirty(true)}>
      <fieldset disabled={saveBusy || recoveryRequired} aria-busy={saveBusy}>
        <input type="hidden" name="intent" value="mail" /><input type="hidden" name="revision" value={mail.revision} />
        <input type="hidden" name="passwordAction" value={passwordAction.action} />
        <Switch name="enabled" defaultChecked={mail.enabled} label="Enable mail delivery" />
        <div className={twoUp}>
          <Field label="SMTP host"><Input name="smtpHost" defaultValue={mail.smtpHost ?? ''} maxLength={253} autoComplete="off" /></Field>
          <Field label="SMTP port"><Input name="smtpPort" type="number" min="1" max="65535" defaultValue={mail.smtpPort ?? ''} /></Field>
        </div>
        <Field label="SMTP security"><NativeSelect name="smtpSecurity" value={security}
          aria-describedby="smtp-security-help" onChange={(event) => setSecurity(event.currentTarget.value as MailSecurity | '')}>
          <option value="">Select security mode</option><option value="starttls">STARTTLS (usually port 587)</option>
          <option value="tls">TLS (usually port 465)</option><option value="none">None</option>
        </NativeSelect></Field>
        <p id="smtp-security-help" className={settingHelp}>Use the connection security mode required by your SMTP provider.</p>
        {security === 'none' ? <div className="mt-[-.3rem] mb-[1.15rem] rounded-md bg-muted p-3 text-[.8rem] text-muted-foreground [&_p]:m-0">
          <input type="hidden" name="smtpUsername" value="" />
          <p>Authentication is unavailable without connection security. Saving this mode removes any configured SMTP credentials.</p>
        </div> : <div>
          {removePassword && <input type="hidden" name="smtpUsername" value="" />}
          <Field label="SMTP username"><Input name={removePassword ? undefined : 'smtpUsername'} value={smtpUsername}
            disabled={removePassword} maxLength={320} autoComplete="username"
            onChange={(event) => setSmtpUsername(event.currentTarget.value)} /></Field>
          <fieldset className="mb-[1.15rem]"><legend className="sr-only">SMTP password</legend>
            <div className="mb-[.45rem] flex items-baseline justify-between gap-4">
              <Label id="smtp-password-label" htmlFor="smtp-password">SMTP password</Label>
            </div>
            {mail.passwordState === 'configured' && !removePassword
              ? <div className={credentialContext}><Hint id="smtp-password-help">Configured. Leave blank to keep current password.</Hint>
                <Button type="button" variant="link" className={credentialAction} onClick={() => {
                  setRemovePassword(true); setSmtpPassword(''); setDirty(true);
                }}>Remove password</Button></div>
              : mail.passwordState === 'unavailable'
                ? <Hint id="smtp-password-help" className="mb-[.7rem]">Unavailable — instance master-key recovery is required.</Hint>
                : removePassword
                  ? <div className={credentialContext}><Hint id="smtp-password-help">Password and username will be removed when saved.</Hint>
                    <Button type="button" variant="link" className={credentialAction} onClick={() => {
                      setRemovePassword(false); setDirty(true);
                    }}>Undo password removal</Button></div>
                  : null}
            {/* The field names itself through the heading above, so its own
                label would be the same words twice. */}
            <div className="[&_[data-slot=label]]:sr-only"><PasswordField id="smtp-password" label="SMTP password"
              aria-labelledby="smtp-password-label" name="smtpPassword" value={smtpPassword}
              maxLength={1024} autoComplete="new-password"
              aria-describedby={mail.passwordState !== 'none' || removePassword ? 'smtp-password-help' : undefined}
              placeholder={mail.passwordState === 'configured' && !removePassword ? 'Leave blank to keep current password' : ''}
              disabled={removePassword || mail.passwordState === 'unavailable'}
              onChange={(event) => { setSmtpPassword(event.currentTarget.value); setRemovePassword(false); }} /></div>
          </fieldset>
        </div>}
        <div className={twoUp}>
          <Field label="Sender email"><Input name="senderAddress" type="email" defaultValue={mail.senderAddress ?? ''} maxLength={254} /></Field>
          <Field label="Sender name"><Input name="senderName" defaultValue={mail.senderName ?? ''} maxLength={100} /></Field>
        </div>
        <ActionRow><Button disabled={saveBusy}>{saveBusy ? 'Saving…' : 'Save mail configuration'}</Button>
          <ActionStatus className="w-22 min-w-22">
            <TransientSuccess trigger={result?.saved && !dirty ? result : null} label="Saved" />
          </ActionStatus>
        </ActionRow>
      </fieldset>
    </save.Form>

    <div className={subSection}><h3 className={subHeading}>Test delivery</h3>
      <Hint className="mb-4">Uses currently persisted configuration.</Hint>
      {testResult?.error && <p role="alert">{testResult.error}</p>}
      <test.Form method="post" className="flex max-w-[35rem] flex-wrap items-end gap-4">
        <input type="hidden" name="intent" value="mail-test" />
        <Field label="Test recipient" className="m-0 flex-1"><Input name="recipient" type="email" required maxLength={254} /></Field>
        <ActionRow><Button disabled={dirty || mail.operationalState !== 'configured' || test.state !== 'idle'}>
          {test.state !== 'idle' ? 'Sending…' : 'Send test email'}</Button>
          <ActionStatus className="w-22 min-w-22">
            <TransientSuccess trigger={testResult?.saved ? testResult : null} label="Sent" />
          </ActionStatus>
        </ActionRow>
      </test.Form>
      {dirty && <Hint className="mt-3">Save mail changes before testing.</Hint>}
    </div>

    {mail.masterKeyState !== 'ready' || mail.passwordState === 'unavailable' ? <div className={subSection}>
      <h3 className={subHeading}>Instance master-key recovery</h3>
      <p className="text-[.82rem] text-muted-foreground">Restore the instance master key and restart Kannabi, or explicitly reset all encrypted credentials. Reset disables mail and cannot be undone.</p>
      {resetResult?.error && <p role="alert">{resetResult.error}</p>}
      <ActionStatus className="mb-2 min-h-8">
        <TransientSuccess trigger={resetResult?.saved ? resetResult : null} label="Encrypted credentials reset" />
      </ActionStatus>
      <reset.Form method="post"><input type="hidden" name="intent" value="secret-reset" />
        <input type="hidden" name="revision" value={mail.revision} />
        <Label className="mb-[1.15rem]"><Checkbox name="confirmed" required />I understand this removes all encrypted credentials.</Label>
        <Button variant="destructive" disabled={reset.state !== 'idle'}>Reset encrypted credentials</Button>
      </reset.Form>
    </div> : null}
  </Panel>;
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
    {/* Each preference saves on selection, so the page has no Save button and
        needs one place that says whether the last change landed. */}
    <div className="mb-8 max-sm:items-stretch">
      <Eyebrow>Administration</Eyebrow>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-[.6rem]"><h1>Instance settings</h1>
        <ActionStatus className="h-9 w-52 min-w-0 max-sm:w-44">
          {busy ? <StatusPill>Saving…</StatusPill>
            : fetcher.data?.kind === 'settings' && fetcher.data.error
              ? <StatusPill tone="error" role="alert" title={fetcher.data.error}>Error: {fetcher.data.error}</StatusPill>
              : fetcher.data?.kind === 'settings' && fetcher.data.saved
                ? <TransientSuccess trigger={fetcher.data} label="Saved" /> : null}
        </ActionStatus>
      </div>
      <p className="mt-[.65rem] text-[.9rem] text-muted-foreground">Reporting policy, time presentation, theme, and mail delivery for this deployment.</p>
    </div>
    <Panel form><h2>Reporting, display, and appearance</h2>
      <fetcher.Form method="post"><fieldset disabled={busy} aria-busy={busy}>
        <input type="hidden" name="intent" value="settings" />
        <Switch name="requirePhoto" checked={current.requirePhoto}
          onCheckedChange={(requirePhoto) => update({ requirePhoto })}
          label="Require photo when reporting an Asset" />
        <p className={settingHelp}>Applies to new Asset reports.</p>
        <TimezonePicker name="displayTimezone" value={current.displayTimezone} disabled={busy}
          onChange={(displayTimezone) => update({ displayTimezone })} />
        <p className={settingHelp}>Timestamps remain stored as absolute instants.</p>
        <ThemeSelector name="themeId" value={current.themeId} previewMode={previewMode ?? colorScheme} disabled={busy}
          onChange={(themeId) => update({ themeId })} onPreviewModeChange={preview} />
        <Field label="Longest API token lifetime (days)">
          <Input name="apiTokenMaxLifetimeDays" type="number" min={1} step={1} inputMode="numeric"
            defaultValue={current.apiTokenMaxLifetimeDays ?? ''} disabled={busy}
            onBlur={(event) => {
              const raw = event.currentTarget.value.trim();
              const next = raw === '' ? null : Number(raw);
              if (next !== current.apiTokenMaxLifetimeDays) update({ apiTokenMaxLifetimeDays: next });
            }} />
        </Field>
        <p className={settingHelp}>Leave empty to allow tokens that never expire. A token's expiry is
          absolute and is fixed when it is created.</p>
      </fieldset></fetcher.Form>
    </Panel>
    <MailSettings mail={mail} />
  </>;
}

export { WorkspaceError as ErrorBoundary } from '../route-error';
