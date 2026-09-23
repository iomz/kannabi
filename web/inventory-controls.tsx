import { Link, useNavigate } from 'react-router';
import {
  assetDirections, assetSorts, type AssetDirection, type AssetFilters, type AssetScope, type AssetSort,
} from '../server/asset-page';
import { identifierSchemes, schemeLabels, type IdentifierScheme } from '../server/gs1.js';
import type { Entity } from '../server/identity-store';
import { displayDate } from '../server/settings.js';
import { Icon } from './icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, NativeSelect } from './ui';

/** The inventory's view controls.
 *
 * Scope, ordering and structured filters are different capabilities and are
 * presented as such. Scope shortcuts and ordering stay directly visible because
 * both are frequent; filters live behind one compact disclosure that can gain
 * dimensions without growing the strip horizontally. Active filters surface as
 * removable chips, so the current predicate stays legible when the panel is
 * closed, with a `Clear all` shortcut at the head of that row.
 *
 * All state is URL-backed, and every URL this module produces is the canonical
 * one: unset controls are omitted rather than serialised as `key=`.
 */
export const sortLabels: Record<AssetSort, string> = { name: 'Name', reportedAt: 'Reported' };
const identifiedLabels = { any: 'Has an identifier', none: 'No identifier' } as const;

export type InventoryView = {
  q: string; scope: AssetScope; sort: AssetSort; dir: AssetDirection; filters: AssetFilters;
};

export const noFilters: AssetFilters = {
  groups: [], schemes: [], identified: null, reportedFrom: null, reportedTo: null,
  reportedToEndOfDay: false,
};

/** The canonical URL for a view. Defaults and unset filters are omitted, so the
 * URL round-trips through the same parser the API validates against. */
export function inventoryPath(view: InventoryView, change: Partial<InventoryView> = {}): string {
  const next = { ...view, ...change };
  const params = new URLSearchParams();
  const set = (key: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') params.set(key, value);
  };
  set('q', next.q);
  if (next.scope !== 'all') set('scope', next.scope);
  if (next.sort !== 'name') set('sort', next.sort);
  if (next.dir !== 'asc') set('dir', next.dir);
  for (const group of next.filters.groups) params.append('group', group);
  for (const scheme of next.filters.schemes) params.append('scheme', scheme);
  set('identified', next.filters.identified);
  set('reportedFrom', next.filters.reportedFrom?.slice(0, 10));
  set('reportedTo', next.filters.reportedTo?.slice(0, 10));
  const query = params.toString();
  return query ? '/?' + query : '/';
}

/** Read the filter panel's fields, dropping every unset control. Separated from
 * the component so the form-to-URL round trip is testable on its own. */
export function filtersFromForm(form: FormData): AssetFilters {
  const value = (name: string) => {
    const entry = form.get(name);
    return typeof entry === 'string' && entry.trim() !== '' ? entry.trim() : null;
  };
  const group = value('group');
  const scheme = value('scheme');
  // The date controls submit plain dates, so an upper bound from this form
  // always means through the end of the day it names.
  const reportedTo = value('reportedTo');
  return {
    groups: group ? [group] : [],
    schemes: scheme ? [scheme as IdentifierScheme] : [],
    identified: value('identified') as AssetFilters['identified'],
    reportedFrom: value('reportedFrom'),
    reportedTo,
    reportedToEndOfDay: reportedTo !== null,
  };
}

const chipClass = 'inline-flex items-center gap-[.35rem] rounded-full border px-2 py-[.1rem] text-[.75rem] no-underline';

type Chip = { label: string; remove: Partial<AssetFilters> };

function activeChips(filters: AssetFilters, groups: readonly Entity[]): Chip[] {
  const chips: Chip[] = [];
  for (const key of filters.groups) {
    chips.push({ label: 'Group: ' + (groups.find((group) => group.key === key)?.name ?? key),
      remove: { groups: filters.groups.filter((other) => other !== key) } });
  }
  for (const scheme of filters.schemes) {
    chips.push({ label: schemeLabels[scheme],
      remove: { schemes: filters.schemes.filter((other) => other !== scheme) } });
  }
  if (filters.identified) {
    chips.push({ label: identifiedLabels[filters.identified], remove: { identified: null } });
  }
  if (filters.reportedFrom) {
    chips.push({ label: 'From ' + displayDate(filters.reportedFrom), remove: { reportedFrom: null } });
  }
  if (filters.reportedTo) {
    chips.push({ label: 'To ' + displayDate(filters.reportedTo), remove: { reportedTo: null } });
  }
  return chips;
}

export function InventoryControls({ view, groups, scopes }: {
  view: InventoryView; groups: readonly Entity[]; scopes: Record<AssetScope, number>;
}) {
  const navigate = useNavigate();
  const count = new Intl.NumberFormat();
  const chips = activeChips(view.filters, groups);
  // One canonical clearing operation, offered in two places: beside the chips
  // where the active predicate is visible, and inside the panel where it was
  // built. Both drop every structured filter and keep search, scope and order.
  const cleared = inventoryPath(view, { filters: noFilters });
  return <div className="sticky top-14 z-[4] bg-background py-1">
    <div className="mb-[.55rem] flex items-center justify-between gap-4 max-sm:flex-wrap max-sm:gap-[.3rem]">
      <nav aria-label="Asset scope"
        className="flex min-w-0 gap-1 max-sm:w-full max-sm:gap-0 max-sm:overflow-x-auto">
        {([['all', 'All'], ['mine', 'Mine'], ['group', 'Group access'], ['public', 'Public']] as const)
          .map(([value, label]) =>
            <Link key={value} to={inventoryPath(view, { scope: value })}
              aria-current={view.scope === value ? 'page' : undefined}
              title={value === 'mine' ? 'Readable Assets you originally reported' : undefined}
              className={['flex items-center gap-[.7rem] whitespace-nowrap border-b-2 px-4 py-[.85rem] text-[.85rem] hover:bg-accent',
                'max-lg:gap-[.4rem] max-lg:px-[.6rem] max-sm:gap-1 max-sm:px-[.35rem] max-sm:text-[.76rem]',
                '[&>span]:rounded-full [&>span]:bg-muted [&>span]:px-2 [&>span]:py-[.15rem] [&>span]:text-[.75rem] [&>span]:font-normal max-sm:[&>span]:px-[.3rem] max-sm:[&>span]:py-[.1rem]',
                view.scope === value
                  ? 'border-selected-indicator font-semibold text-selected-text [&>span]:bg-selected-surface'
                  : 'border-transparent text-foreground'].join(' ')}>
              {label}<span>{count.format(scopes[value])}</span>
            </Link>)}
      </nav>
      <div className="ml-auto flex items-center gap-2 max-sm:ml-0">
        {/* Sorting is frequent, so it stays one click away rather than behind a
            disclosure. Re-selecting the active field flips its direction. */}
        <nav aria-label="Asset ordering" className="flex items-center gap-1">
          {assetSorts.map((value) => {
            const active = view.sort === value;
            const dir: AssetDirection = active && view.dir === 'asc' ? 'desc' : 'asc';
            return <Link key={value} aria-current={active ? 'true' : undefined}
              className={['rounded px-2 py-1 text-[.8rem] hover:bg-accent',
                active ? 'font-semibold text-selected-text' : 'text-muted-foreground'].join(' ')}
              title={`Sort by ${sortLabels[value].toLowerCase()}`}
              to={inventoryPath(view, { sort: value, dir })}>
              {sortLabels[value]}<span aria-hidden="true">{active ? (view.dir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
            </Link>;
          })}
        </nav>
        <details className="relative [&[open]>summary]:bg-muted">
          <summary className="inline-flex cursor-pointer list-none items-center gap-[.3rem] rounded-md border px-[.55rem] py-[.2rem] text-[.8rem] [&::-webkit-details-marker]:hidden">
            <Icon name="settings" />Filters
            {chips.length ? <span className="min-w-[1.1rem] rounded-full bg-sidebar px-1 text-center text-[.7rem] text-sidebar-foreground">{chips.length}</span> : null}</summary>
          <div className="absolute right-0 z-[6] mt-[.4rem] w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 shadow-lg">
            <form onSubmit={(event) => {
              // Navigate to the canonical URL rather than letting the browser
              // serialise every empty control as `key=`.
              event.preventDefault();
              navigate(inventoryPath(view, { filters: filtersFromForm(new FormData(event.currentTarget)) }));
            }}>
              <Field label="Group"><NativeSelect name="group" defaultValue={view.filters.groups[0] ?? ''}>
                <option value="">Any Group</option>
                {groups.map((group) => <option key={group.key} value={group.key}>{group.name}</option>)}
              </NativeSelect></Field>
              <Field label="External identifier"><NativeSelect name="identified" defaultValue={view.filters.identified ?? ''}>
                <option value="">Any</option>
                <option value="any">Has an identifier</option>
                <option value="none">No identifier</option>
              </NativeSelect></Field>
              <Field label="Identifier scheme"><NativeSelect name="scheme" defaultValue={view.filters.schemes[0] ?? ''}>
                <option value="">Any scheme</option>
                {identifierSchemes.map((scheme: IdentifierScheme) =>
                  <option key={scheme} value={scheme}>{schemeLabels[scheme]}</option>)}
              </NativeSelect></Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Reported from"><Input type="date" name="reportedFrom"
                  defaultValue={view.filters.reportedFrom?.slice(0, 10) ?? ''} /></Field>
                <Field label="Reported to"><Input type="date" name="reportedTo"
                  defaultValue={view.filters.reportedTo?.slice(0, 10) ?? ''} /></Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">Apply</Button>
                <Button type="button" variant="ghost" disabled={!chips.length}
                  onClick={() => navigate(cleared)}>Clear filters</Button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>
    {chips.length > 0 && <div className="mt-[.4rem] flex flex-wrap gap-[.35rem]">
      <Link className={chipClass + ' border-dashed text-link hover:bg-accent'} to={cleared}>Clear all</Link>
      {chips.map((chip) => <Link key={chip.label} className={chipClass + ' bg-muted'}
        to={inventoryPath(view, { filters: { ...view.filters, ...chip.remove } })}
        aria-label={'Remove filter ' + chip.label}>{chip.label}<span aria-hidden="true">×</span></Link>)}
    </div>}
  </div>;
}
