import { redirect } from 'react-router';
import { api, unwrap } from '../api';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Hint, PageHeading, Panel } from '../ui';
import type { Route } from './+types/admin-plugins';

/** What this Kannabi was built with.
 *
 * An inventory to read, and deliberately nothing more. Which plugins an
 * instance has is decided when it is built, by whoever operates the host: a
 * plugin runs inside Kannabi with the whole database, so anybody able to
 * install one could read every Asset, and administration grants no Asset
 * access. There is therefore nothing here to install, enable or remove.
 */
export async function clientLoader() {
  const { user, isAdmin } = await unwrap(await api.me.$get());
  if (!user) throw redirect('/signin');
  if (!isAdmin) throw new Response('Administrator access required.', { status: 403 });
  return unwrap(await api.admin.plugins.$get());
}

export default function Plugins({ loaderData: { contract, plugins } }: Route.ComponentProps) {
  return <>
    <PageHeading eyebrow="Administration" title="Plugins"
      description="The plugins this instance was built with. They are chosen when Kannabi is built, so this page lists them and changes nothing." />
    <Hint>Plugin contract {contract}. Every plugin listed here passed its startup checks, because Kannabi does not start otherwise.</Hint>
    {plugins.length === 0 && <EmptyState>
      No plugin is installed. Assets, Groups and people work as they are; an Asset simply carries no external identifier.
    </EmptyState>}
    {plugins.map((plugin) => <Panel key={plugin.id} aria-labelledby={`plugin-${plugin.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`plugin-${plugin.id}`} className="m-0 text-[1.05rem]">{plugin.name}</h2>
        <Badge variant="outline">{plugin.id}</Badge>
        <span className="text-[.8rem] text-muted-foreground">version {plugin.version}</span>
      </div>
      <dl className="mt-4 mb-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[.875rem]">
        <dt className="text-muted-foreground">Contract</dt>
        <dd className="m-0">{plugin.contract.join(', ')}</dd>
        <dt className="text-muted-foreground">Requires</dt>
        <dd className="m-0">{plugin.requires.length ? plugin.requires.join(', ') : 'No other plugin'}</dd>
        <dt className="text-muted-foreground">Contributes</dt>
        <dd className="m-0"><ul className="m-0 list-disc pl-5">
          {plugin.contributes.map((line) => <li key={line}>{line}</li>)}
        </ul></dd>
      </dl>
    </Panel>)}
  </>;
}
