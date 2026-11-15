import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Hint } from '../../../web/ui';
import { unwrap } from '../../../web/api';
import type { Gs1Namespace } from '../adapter/store.js';
import { gs1Api } from './api';

/** The prefixes one Group manages, for its overview. */
export async function loadGroupPrefixes(groupKey: string): Promise<Gs1Namespace[]> {
  const { namespaces } = await unwrap(await gs1Api.namespaces.$get());
  return namespaces.filter((namespace) => namespace.group?.key === groupKey);
}

/** Managed prefixes, folded: what each prefix is and whether it can issue.
 * Counters and class keys are on the GS1 prefixes view. */
export function GroupPrefixSummary({ data: namespaces }: { data: Gs1Namespace[] }) {
  if (!namespaces.length) return <>None · <Link to="prefixes">GS1 prefixes</Link></>;
  return <details className="[&>summary]:cursor-pointer [&[open]>summary]:mb-2">
    <summary>{namespaces.length === 1 ? '1 prefix' : `${namespaces.length} prefixes`}</summary>
    <ul className="grid gap-2">{namespaces.map((namespace) => <li key={namespace.key}
      className="flex flex-wrap items-center gap-2">
      <code>{namespace.gcp}</code>
      <Badge variant={namespace.active ? 'brand' : 'secondary'}>{namespace.active ? 'Active' : 'Inactive'}</Badge>
      {namespace.unissuableReason ? <Hint>Can no longer issue</Hint>
        : !namespace.classKeyIssuable && <Hint>GIAI only</Hint>}
    </li>)}</ul>
    <Hint className="mt-2">Managed under <Link to="prefixes">GS1 prefixes</Link>.</Hint>
  </details>;
}

