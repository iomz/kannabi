import { Form, useNavigation } from 'react-router';
import { useEffect, useState } from 'react';
import type { Member } from '../server/identity-store';
import { api, unwrap } from './api';
import { DestructiveConfirmation } from './destructive-confirmation';
import { PasswordField } from './password-field';
import { TransientSuccess } from './transient-success';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionRow, ActionStatus, Field, Hint, StatusPill } from './ui';

type FormFeedback = { saved: boolean; error: string | null } | undefined;

function FormStatus({ feedback, savedLabel }: { feedback: FormFeedback; savedLabel: string }) {
  return <ActionStatus className="max-[420px]:w-full">
    {feedback?.saved ? <TransientSuccess trigger={feedback} label={savedLabel} />
      : feedback?.error ? <StatusPill tone="error" role="alert">{feedback.error}</StatusPill> : null}
  </ActionStatus>;
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
    <Field label="Name"><Input name="name" defaultValue={member.name} required maxLength={200} autoComplete="name" /></Field>
    <ActionRow><Button>Save profile</Button><FormStatus feedback={feedback} savedLabel="Saved" /></ActionRow>
  </fieldset></Form>;
}

export function EmailAddressEditor({ email, feedback }: { email: string; feedback?: FormFeedback }) {
  const busy = useNavigation().state !== 'idle';
  return <Form method="post"><fieldset disabled={busy}>
    <input type="hidden" name="intent" value="email" />
    <h2>Email address</h2>
    <Hint className="mb-4">Changing email immediately updates your sign-in address and password-recovery destination.</Hint>
    <Field label="Email"><Input name="newEmail" defaultValue={email} required maxLength={254} type="email" autoComplete="email" /></Field>
    <PasswordField label="Current password" name="currentPassword" required autoComplete="current-password" />
    <ActionRow><Button>Change email</Button>
      <FormStatus feedback={feedback} savedLabel="Changed" /></ActionRow>
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
    <Hint className="mb-4">Changing your password signs out your other sessions.</Hint>
    <PasswordField label="Current password" name="currentPassword" required autoComplete="current-password"
      value={currentPassword} onChange={(event) => setCurrentPassword(event.currentTarget.value)} />
    <PasswordField label="New password" name="newPassword" required minLength={12} maxLength={128}
      autoComplete="new-password" value={newPassword}
      onChange={(event) => setNewPassword(event.currentTarget.value)} />
    <PasswordField label="Confirm new password" name="confirmation" required minLength={12} maxLength={128}
      autoComplete="new-password" value={confirmation}
      onChange={(event) => setConfirmation(event.currentTarget.value)} />
    <Hint className="mb-4">Use at least 12 characters.</Hint>
    <ActionRow><Button>Change password</Button>
      <FormStatus feedback={feedback} savedLabel="Changed" /></ActionRow>
  </fieldset></Form>;
}

export function DeleteAccount({ member, deletionBlocked, feedback }: {
  member: Member; deletionBlocked: boolean; feedback?: FormFeedback;
}) {
  const busy = useNavigation().state !== 'idle';
  const [confirming, setConfirming] = useState(false);
  return <>
    <h2>Delete account</h2>
    <Hint className="mb-3">Disables sign-in, removes personal account data and Group memberships, and preserves Asset provenance.</Hint>
    {member.isAdmin && <Hint className="mb-3">A final system administrator must promote another member before deleting their account.</Hint>}
    <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>Delete account</Button>
    <DestructiveConfirmation open={confirming} onClose={() => setConfirming(false)} displayName={member.name}
      email={member.email} mode="account" confirmLabel="Delete account" fields={{ intent: 'delete' }} busy={busy}
      error={feedback?.error} blocked={deletionBlocked} />
  </>;
}
