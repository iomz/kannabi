import { Form, useNavigation } from 'react-router';
import { useEffect, useState } from 'react';
import type { Member } from '../server/identity-store';
import { api, unwrap } from './api';
import { DestructiveConfirmation } from './destructive-confirmation';
import { PasswordField } from './password-field';
import { TransientSuccess } from './transient-success';

type FormFeedback = { saved: boolean; error: string | null } | undefined;

function FormStatus({ feedback, savedLabel }: { feedback: FormFeedback; savedLabel: string }) {
  return <div className="profile-action-status" role="status" aria-live="polite" aria-atomic="true">
    {feedback?.saved ? <TransientSuccess trigger={feedback} label={savedLabel} />
      : feedback?.error ? <span className="settings-status-pill error" role="alert">{feedback.error}</span> : null}
  </div>;
}

export async function saveProfile(request: Request) {
  const data = await request.formData();
  const name = String(data.get('name') ?? '');
  try {
    await unwrap(await api.profile.$patch({ json: { name } }));
    return { saved: true, error: null };
  } catch (error) { return { saved: false, error: error instanceof Error ? error.message : 'Profile update failed' }; }
}

export function ProfileEditor({ member, feedback }: { member: Member; feedback?: FormFeedback }) {
  const busy = useNavigation().state !== 'idle';
  return <Form method="post"><fieldset disabled={busy}>
    <label>Name<input name="name" defaultValue={member.name} required maxLength={200} autoComplete="name" /></label>
    <div className="profile-action-row"><button>Save profile</button><FormStatus feedback={feedback} savedLabel="Saved" /></div>
  </fieldset></Form>;
}

export function EmailAddressEditor({ email, feedback }: { email: string; feedback?: FormFeedback }) {
  const busy = useNavigation().state !== 'idle';
  return <Form method="post"><fieldset disabled={busy}>
    <input type="hidden" name="intent" value="email" />
    <h2>Email address</h2>
    <p className="hint">Changing email immediately updates your sign-in address and password-recovery destination.</p>
    <label>Email<input name="newEmail" defaultValue={email} required maxLength={254} type="email" autoComplete="email" /></label>
    <PasswordField label="Current password" name="currentPassword" required autoComplete="current-password" />
    <div className="profile-action-row"><button>Change email</button>
      <FormStatus feedback={feedback} savedLabel="Changed" /></div>
  </fieldset></Form>;
}

export function PasswordEditor({ feedback }: { feedback?: FormFeedback }) {
  const busy = useNavigation().state !== 'idle';
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    if (!feedback?.saved) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
  }, [feedback]);
  return <Form method="post"><fieldset disabled={busy}>
    <input type="hidden" name="intent" value="password" />
    <h2>Password</h2>
    <p className="hint">Changing your password signs out your other sessions.</p>
    <PasswordField label="Current password" name="currentPassword" required autoComplete="current-password"
      value={currentPassword} onChange={(event) => setCurrentPassword(event.currentTarget.value)} />
    <PasswordField label="New password" name="newPassword" required minLength={12} maxLength={128}
      autoComplete="new-password" value={newPassword}
      onChange={(event) => setNewPassword(event.currentTarget.value)} />
    <PasswordField label="Confirm new password" name="confirmation" required minLength={12} maxLength={128}
      autoComplete="new-password" value={confirmation}
      onChange={(event) => setConfirmation(event.currentTarget.value)} />
    <p className="hint">Use at least 12 characters.</p>
    <div className="profile-action-row"><button>Change password</button>
      <FormStatus feedback={feedback} savedLabel="Changed" /></div>
  </fieldset></Form>;
}

export function DeleteAccount({ member, deletionBlocked, feedback }: {
  member: Member; deletionBlocked: boolean; feedback?: FormFeedback;
}) {
  const busy = useNavigation().state !== 'idle';
  const [confirming, setConfirming] = useState(false);
  return <>
    <h2>Delete account</h2>
    <p className="hint">Disables sign-in, removes personal account data and Group memberships, and preserves Asset provenance.</p>
    {member.isAdmin && <p className="hint">A final system administrator must promote another member before deleting their account.</p>}
    <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete account</button>
    <DestructiveConfirmation open={confirming} onClose={() => setConfirming(false)} displayName={member.name}
      email={member.email} mode="account" confirmLabel="Delete account" fields={{ intent: 'delete' }} busy={busy}
      error={feedback?.error} blocked={deletionBlocked} />
  </>;
}
