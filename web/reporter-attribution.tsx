import type { ReporterAttribution as Reporter } from '../server/identity-store';
import { Badge } from '@/components/ui/badge';

export function ReporterAttribution({ reporter }: { reporter: Reporter }) {
  return <span className="inline-flex flex-wrap items-center gap-[.35rem]">
    <span>{reporter.name}</span>
    {reporter.status === 'deleted'
      && <Badge variant="secondary" className="px-[.4rem] py-[.15rem] text-[.67rem]">Deleted member</Badge>}
  </span>;
}
