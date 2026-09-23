import { redirect } from 'react-router';
import { api, authClient, unwrap } from '../api';
import { PasswordEditor } from '../profile-editor';
import { passwordChangeInput } from '../password-change';
import { ApiTokens } from '../api-tokens';
import type { Route } from './+types/settings-security';

export async function clientLoader() {
  const { user, isAdmin } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  // Token lifetime policy belongs to the instance. The browser asks for it
  // rather than deciding it, so the choices offered here are always the ones
  // the server will accept.
  const [tokens, settings] = await Promise.all([api['api-tokens'].$get(), api.settings.$get()]);
  return {
    isAdmin,
    apiTokens: (await unwrap(tokens)).tokens,
    apiTokenMaxLifetimeDays: (await unwrap(settings)).settings.apiTokenMaxLifetimeDays,
  };
}
export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.clone().formData();
  const input = passwordChangeInput(data);
  if (!input.body) return { saved: false, error: input.error, key: null, section: 'password' as const };
  try {
    const result = await authClient.changePassword(input.body);
    if (result.error) throw result.error;
    return { saved: true, error: null, key: null, section: 'password' as const };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : 'Password could not be changed',
      key: null, section: 'password' as const };
  }
}
export default function SettingsSecurity({ loaderData: { isAdmin, apiTokens, apiTokenMaxLifetimeDays },
  actionData }: Route.ComponentProps) {
  const passwordFeedback = actionData?.section === 'password' ? actionData : undefined;
  return <>
    <section className="panel form-panel"><PasswordEditor feedback={passwordFeedback} /></section>
    <section className="panel form-panel"><ApiTokens tokens={apiTokens}
      maxLifetimeDays={apiTokenMaxLifetimeDays} isAdmin={isAdmin} /></section>
  </>;
}
