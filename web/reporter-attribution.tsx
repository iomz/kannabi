import { Link } from 'react-router';
import type { ReporterAttribution as Reporter } from '../server/identity-store';
import { Badge } from '@/components/ui/badge';

/** Who reported this, and whether they can be opened.
 *
 * Anybody reading an Asset may already know its reporter — that is one of the
 * ways a User becomes reachable — so the name leads to their page. Three cases
 * do not: a tombstone is not a person to visit, an anonymous reader of a
 * public Asset has no workspace to open it in, and a row that is itself one
 * link to the Asset stays one target rather than becoming two.
 */
export function ReporterAttribution({ reporter, link = false }: {
  reporter: Reporter;
  /** Whether the reader is signed in, and so has a User page to arrive at. */
  link?: boolean;
}) {
  const deleted = reporter.status === 'deleted';
  return <span className="inline-flex flex-wrap items-center gap-[.35rem]">
    {link && !deleted
      ? <Link to={`/users/${reporter.key}`}>{reporter.name}</Link>
      : <span>{reporter.name}</span>}
    {deleted && <Badge variant="secondary" className="px-[.4rem] py-[.15rem] text-[.67rem]">Deleted member</Badge>}
  </span>;
}
