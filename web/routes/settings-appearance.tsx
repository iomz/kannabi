import { redirect } from 'react-router';
import { api, unwrap } from '../api';
import { AppearanceSelector } from '../appearance-selector';
import { themeById } from '../themes';
import type { AppearancePreference } from '../../shared/appearance';
import { useThemeRuntime } from '../theme-runtime';
import type { Route } from './+types/settings-appearance';

export async function clientLoader() {
  const { user } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  return null;
}
export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = await request.clone().formData();
  try {
    await unwrap(await api.profile.appearance.$patch({ json: {
      appearance: String(data.get('appearance') ?? '') as AppearancePreference,
    } }));
    return { saved: true, error: null, key: null, section: 'appearance' as const,
      appearance: String(data.get('appearance')) as AppearancePreference };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : 'Appearance update failed',
      key: null, section: 'appearance' as const };
  }
}
export default function SettingsAppearance() {
  const runtime = useThemeRuntime();
  return <section className="panel form-panel">
    <AppearanceSelector value={runtime.appearance} theme={themeById(runtime.themeId)} />
  </section>;
}
