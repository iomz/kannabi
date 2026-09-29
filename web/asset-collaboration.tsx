import { Button } from '@/components/ui/button';
import { Hint, Section } from './ui';

type Group = { key: string; name: string };

/** These affordances explain current authority; mutations recheck it in Neo4j. */
export function AssetCollaboration({ groups, controlled, canEdit, canGrant, busy, error, onChange }: {
  groups: readonly Group[]; controlled: readonly Group[]; canEdit: boolean; canGrant: boolean;
  busy: boolean; error: string | null;
  onChange: (groupKey: string, grant: boolean) => void;
}) {
  if (!canEdit) return null;
  // Closed by default. Which Groups collaborate is already stated in Details
  // above; this is the occasional act of changing it, so it asks for the
  // reader's attention only when they come looking for it. It folds through
  // the same Section every other part of the page uses, so one heading does
  // not behave differently from its neighbours.
  return <Section title="Manage collaboration">
    <Hint>Members of every collaboration Group can read and edit this Asset. Sharing requires membership and control in an existing collaboration Group and control of the receiving Group.</Hint>
    <ul>{groups.map((group) => <li key={group.key} className="my-3 flex items-center gap-3">
      <span>{group.name}</span>
      {controlled.some((g) => g.key === group.key) && <Button type="button" variant="outline"
        disabled={busy || groups.length === 1} onClick={() => onChange(group.key, false)}>
        Remove {group.name} collaboration</Button>}
    </li>)}</ul>
    <Hint>Only a controller of a Group who also has Asset access can remove that Group. At least one Group must remain. Removal may end your own access; other memberships and public readability still apply.</Hint>
    {canGrant && controlled.filter((group) => !groups.some((g) => g.key === group.key)).map((group) =>
      <div key={group.key} className="my-3"><Button type="button" disabled={busy}
        onClick={() => onChange(group.key, true)}>Grant {group.name} collaboration</Button></div>)}
    {error && <p role="alert">{error}</p>}
  </Section>;
}
