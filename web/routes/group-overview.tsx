import { Fragment } from 'react';
import { Link, useOutletContext } from 'react-router';
import { api } from '../api';
import { groupRead, GroupViewError, LeaveGroup, leaveAction, viewerKey, type GroupActionResult,
  type GroupRelationship } from '../group-destination';
import type { GroupPerson, ReporterAttribution } from '../../server/identity-store.js';
import { web } from '../plugins';
import { Panel, StatusPill } from '../ui';
import type { Route } from './+types/group-overview';

/** The installed plugins with a line of their own in a Group's overview. */
const overviews = web.plugins.filter((plugin) => plugin.group?.overview);

/** What this Group is to the viewer, in a few lines: who manages it, how many
 * people are in it, what they can read through it, and the prefixes it
 * manages. */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const key = params.key;
  const [{ members }, assets, pluginLines, self] = await Promise.all([
    api.groups[':key'].members.$get({ param: { key } }).then(groupRead),
    // The inventory's own Group filter, so the count is exactly what the
    // viewer can read through this Group and never more.
    api.assets.$get({ query: { group: [key], limit: ['1'] } }).then(groupRead),
    // Each installed plugin's own line about this Group, read by the plugin.
    Promise.all(overviews.map(async (plugin) => [plugin.id, await plugin.group!.overview!.load(key)] as const)),
    viewerKey(),
  ]);
  return { managers: (members as GroupPerson[]).filter((person) => person.role === 'manager'),
    people: members.length, matching: assets.matching, self,
    pluginLines: Object.fromEntries(pluginLines) as Record<string, unknown> };
}

export async function clientAction({ request, params }: Route.ClientActionArgs) {
  const data = await request.formData();
  if (data.get('intent') !== 'leave') return { intent: 'unknown', status: 'error', message: 'Unknown action' } satisfies GroupActionResult;
  return leaveAction(params.key);
}

/** "Rin Aoki, Sam Okafor and you" — one line however many there are. */
export function controllerSummary(managers: readonly ReporterAttribution[], self: string): string {
  const names = managers.map((person) => person.key === self ? 'you' : person.name);
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

export function assetsSentence(matching: number): string {
  const count = new Intl.NumberFormat().format(matching);
  return matching === 0 ? 'No Asset is shared with this Group yet.'
    : `You can read ${count} ${matching === 1 ? 'Asset' : 'Assets'} through this Group.`;
}

/** Label beside value only where the panel itself is wide enough for both.
 *
 * A container query rather than a viewport breakpoint: with the navigation
 * open, a laptop-width window still leaves the panel narrow, and a viewport
 * rule kept a long list of Group Manager names squeezed into whatever the
 * label column left over. Narrower than that, every label sits above its
 * value. */
const metadata = 'grid grid-cols-1 gap-y-1 text-[.9rem] [&_dd]:m-0 [&_dd]:mb-3 [&_dd]:min-w-0'
  + ' [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground'
  + ' @xl:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)] @xl:gap-x-4 @xl:gap-y-3 @xl:[&_dd]:mb-0';

export default function GroupOverview({ loaderData: { managers, people, matching, pluginLines, self }, actionData }: Route.ComponentProps) {
  const { group, viewer } = useOutletContext<GroupRelationship>();
  const result = actionData as GroupActionResult | null | undefined;
  return <Panel className="@container mt-0">
    <dl className={metadata}>
      <dt>Managed by</dt>
      <dd>{managers.length ? controllerSummary(managers, self) : 'Nobody'} · <Link to="people">{people === 1
        ? '1 person' : `${new Intl.NumberFormat().format(people)} people`}</Link></dd>
      <dt>Assets</dt>
      <dd>{assetsSentence(matching)}{matching > 0 && <> · <Link to="assets">Assets</Link></>}</dd>
      {overviews.map((plugin) => { const { label, Summary } = plugin.group!.overview!;
        return <Fragment key={plugin.id}><dt>{label}</dt><dd><Summary data={pluginLines?.[plugin.id]} /></dd></Fragment>; })}
      <dt>Group key</dt>
      <dd><code className="text-[.75rem] text-muted-foreground">{group.key}</code></dd>
    </dl>
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t pt-5">
      <LeaveGroup size="sm" lastManager={viewer.role === 'manager' && managers.length === 1} />
      {result?.status && <StatusPill tone={result.status === 'error' ? 'error' : 'info'}
        role={result.status === 'error' ? 'alert' : 'status'} className="whitespace-normal">{result.message}</StatusPill>}
    </div>
  </Panel>;
}

export { GroupViewError as ErrorBoundary };
