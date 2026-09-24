import { redirect } from 'react-router';
import { api, unwrap } from '../api';
import { DeleteAccount, EmailAddressEditor, ProfileEditor, saveProfile } from '../profile-editor';
import { AvatarPreference } from '../avatar-preference';
import type { Route } from './+types/settings-profile';
import { Panel } from '../ui';

export async function clientLoader() {
  const account = await unwrap(await api.me.$get());
  if (!account.user) throw redirect('/signin');
  return { ...await unwrap(await api.profile.$get()),
    gravatar: account.gravatar, avatarHash: account.avatarHash };
}
export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.clone().formData();
  if (data.get('intent') === 'delete') {
    try {
      await unwrap(await api.profile.$delete());
      return redirect('/signin');
    } catch (error) {
      return { saved: false, error: error instanceof Error ? error.message : 'Account could not be deleted',
        key: null, section: 'delete' as const };
    }
  }
  if (data.get('intent') === 'email') {
    try {
      await unwrap(await api.profile.email.$patch({ json: {
        newEmail: String(data.get('newEmail') ?? ''),
        currentPassword: String(data.get('currentPassword') ?? ''),
      } }));
      return { saved: true, error: null, key: null, section: 'email' as const };
    } catch (error) {
      return { saved: false, error: error instanceof Error ? error.message : 'Email address could not be changed',
        key: null, section: 'email' as const };
    }
  }
  return { ...await saveProfile(request), section: 'profile' as const };
}
export default function SettingsProfile({ loaderData: { member, deletionBlocked, gravatar, avatarHash },
  actionData }: Route.ComponentProps) {
  const profileFeedback = actionData?.section === 'profile' ? actionData : undefined;
  const emailFeedback = actionData?.section === 'email' ? actionData : undefined;
  const deleteFeedback = actionData?.section === 'delete' ? actionData : undefined;
  return <>
    <Panel form><ProfileEditor key={member.name} member={member} feedback={profileFeedback} /></Panel>
    <Panel form><EmailAddressEditor key={member.email} email={member.email} feedback={emailFeedback} /></Panel>
    {/* Beside the address it is derived from, so the consent is legible. */}
    <Panel form><AvatarPreference name={member.name} gravatar={gravatar} avatarHash={avatarHash} /></Panel>
    {/* Ending the account belongs with the identity it ends, not with the
        credentials or the colours. */}
    <Panel form className="border-warning-border [&>h2]:mb-3"><DeleteAccount member={member}
      deletionBlocked={deletionBlocked} feedback={deleteFeedback} /></Panel>
  </>;
}
