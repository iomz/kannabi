import { Link } from 'react-router';
import type { ReporterAttribution as Reporter } from '../server/identity-store';
import { Badge } from '@/components/ui/badge';

/** Who reported this, and whether Workspace authorization permits opening them.
 *
 * Asset readability never implies profile reachability. Caller supplies the
 * server-derived decision. Tombstones never link, and an Asset row that is
 * itself one link stays one target rather than becoming two.
 */
export function ReporterAttribution({ reporter, link = false }: {
  reporter: Reporter;
  /** Whether this viewer may open this User's Workspace profile. */
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
