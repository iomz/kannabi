import { Link, useNavigate } from 'react-router';
import {
  assetDirections, assetSorts, type AssetDirection, type AssetFilters, type AssetScope, type AssetSort,
} from '../server/asset-page';
import { identifierSchemes, schemeLabels, type IdentifierScheme } from '../server/gs1.js';
import type { Entity } from '../server/identity-store';
import { displayDate } from '../server/settings.js';
import { Icon } from './icon';

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
  return {
    groups: group ? [group] : [],
    schemes: scheme ? [scheme as IdentifierScheme] : [],
    identified: value('identified') as AssetFilters['identified'],
    reportedFrom: value('reportedFrom'),
    reportedTo: value('reportedTo'),
  };
}

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
  return <div className="inventory-controls">
    <div className="inventory-toolbar">
      <nav className="inventory-scopes" aria-label="Asset scope">
        {([['all', 'All'], ['mine', 'Mine'], ['group', 'Group access'], ['public', 'Public']] as const)
          .map(([value, label]) =>
            <Link key={value} to={inventoryPath(view, { scope: value })}
              aria-current={view.scope === value ? 'page' : undefined}
              className={view.scope === value ? 'active' : ''}
              title={value === 'mine' ? 'Readable Assets you originally reported' : undefined}>
              {label}<span>{count.format(scopes[value])}</span>
            </Link>)}
      </nav>
      <div className="inventory-view-controls">
        {/* Sorting is frequent, so it stays one click away rather than behind a
            disclosure. Re-selecting the active field flips its direction. */}
        <nav className="inventory-sorts" aria-label="Asset ordering">
          {assetSorts.map((value) => {
            const active = view.sort === value;
            const dir: AssetDirection = active && view.dir === 'asc' ? 'desc' : 'asc';
            return <Link key={value} className={active ? 'active' : ''}
              aria-current={active ? 'true' : undefined}
              title={`Sort by ${sortLabels[value].toLowerCase()}`}
              to={inventoryPath(view, { sort: value, dir })}>
              {sortLabels[value]}<span aria-hidden="true">{active ? (view.dir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
            </Link>;
          })}
        </nav>
        <details className="inventory-view">
          <summary><Icon name="settings" />Filters
            {chips.length ? <span className="chip-count">{chips.length}</span> : null}</summary>
          <div className="inventory-view-panel">
            <form onSubmit={(event) => {
              // Navigate to the canonical URL rather than letting the browser
              // serialise every empty control as `key=`.
              event.preventDefault();
              navigate(inventoryPath(view, { filters: filtersFromForm(new FormData(event.currentTarget)) }));
            }}>
              <label>Group<select name="group" defaultValue={view.filters.groups[0] ?? ''}>
                <option value="">Any Group</option>
                {groups.map((group) => <option key={group.key} value={group.key}>{group.name}</option>)}
              </select></label>
              <label>External identifier<select name="identified" defaultValue={view.filters.identified ?? ''}>
                <option value="">Any</option>
                <option value="any">Has an identifier</option>
                <option value="none">No identifier</option>
              </select></label>
              <label>Identifier scheme<select name="scheme" defaultValue={view.filters.schemes[0] ?? ''}>
                <option value="">Any scheme</option>
                {identifierSchemes.map((scheme: IdentifierScheme) =>
                  <option key={scheme} value={scheme}>{schemeLabels[scheme]}</option>)}
              </select></label>
              <div className="grid">
                <label>Reported from<input type="date" name="reportedFrom"
                  defaultValue={view.filters.reportedFrom?.slice(0, 10) ?? ''} /></label>
                <label>Reported to<input type="date" name="reportedTo"
                  defaultValue={view.filters.reportedTo?.slice(0, 10) ?? ''} /></label>
              </div>
              <div className="inventory-view-actions">
                <button type="submit">Apply</button>
                <button type="button" className="secondary" disabled={!chips.length}
                  onClick={() => navigate(cleared)}>Clear filters</button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>
    {chips.length > 0 && <div className="inventory-chips">
      <Link className="inventory-chip clear-all" to={cleared}>Clear all</Link>
      {chips.map((chip) => <Link key={chip.label} className="inventory-chip"
        to={inventoryPath(view, { filters: { ...view.filters, ...chip.remove } })}
        aria-label={'Remove filter ' + chip.label}>{chip.label}<span aria-hidden="true">×</span></Link>)}
    </div>}
  </div>;
}
