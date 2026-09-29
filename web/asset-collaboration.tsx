import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Icon } from './icon';
import { HelpTip, IconButton, NativeSelect, Section } from './ui';

type Group = { key: string; name: string };

/** Which Groups this Asset is associated with, and the two acts that change
 * that.
 *
 * Both used to be a button per Group stacked under two paragraphs, which grew
 * with the number of Groups a person controls and put the explanation of the
 * rule above the rule's effect. This is the association itself: one row per
 * Group, the act at the end of the row, and the rule behind the heading.
 *
 * "Associate" and "Remove" are what a person is doing. Granting and revoking
 * are how the domain records it, and the words are not the same size: a reader
 * choosing a Group is not exercising a grant they have to name.
 *
 * These affordances explain current authority; every mutation rechecks it in
 * Neo4j, and nothing here is permission.
 */
export function AssetCollaboration({ groups, controlled, canEdit, canGrant, busy, error, onChange }: {
  groups: readonly Group[]; controlled: readonly Group[]; canEdit: boolean; canGrant: boolean;
  busy: boolean; error: string | null;
  onChange: (groupKey: string, grant: boolean) => void;
}) {
  const [removing, setRemoving] = useState<Group | null>(null);
  const [associating, setAssociating] = useState<Group | null>(null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState('');
  if (!canEdit) return null;

  const associable = canGrant
    ? controlled.filter((group) => !groups.some((g) => g.key === group.key))
    : [];
  // The server decides this too, and refuses the request either way. Saying so
  // here is so the control explains itself rather than failing when used.
  const lastGroup = groups.length === 1;

  // One eligible Group needs no choosing; several do. Either way the
  // confirmation that follows names the Group and its consequence.
  function beginAssociating() {
    if (associable.length === 1) { setAssociating(associable[0]); return; }
    setChosen(associable[0]?.key ?? '');
    setPicking(true);
  }

  return <Section title={<>Manage Groups
    <HelpTip label="About Group association">Members of every associated Group can read and
      edit this Asset. Associating another Group requires membership and control in a Group
      already associated with it, plus control of the Group being added. Removing one requires
      Asset access through a Group and control of the Group being removed.</HelpTip>
  </>}>
    <table className="w-full text-[.875rem]">
      <caption className="sr-only">Groups associated with this Asset</caption>
      <thead><tr>
        <th scope="col" className="pb-2 text-left font-[650]">Group</th>
        {/* Narrow enough that the name takes the card's width. */}
        <th scope="col" className="w-10 pb-2"><span className="sr-only">Actions</span></th>
      </tr></thead>
      <tbody>
        {groups.map((group) => <tr key={group.key} className="border-t">
          <td className="py-2">{group.name}</td>
          <td className="py-2 text-right">
            {controlled.some((g) => g.key === group.key) && <IconButton tone="destructive"
              disabled={busy || lastGroup}
              label={lastGroup
                ? `Cannot remove ${group.name}: an Asset keeps at least one Group`
                : `Remove ${group.name}`}
              onClick={() => setRemoving(group)}><Icon name="trash" /></IconButton>}
          </td>
        </tr>)}
        {associable.length > 0 && <tr className="border-t">
          <td colSpan={2} className="py-2">
            <IconButton label="Associate another Group" disabled={busy}
              onClick={beginAssociating}><Icon name="plus" /></IconButton>
          </td>
        </tr>}
      </tbody>
    </table>
    {error && <p role="alert">{error}</p>}

    <AlertDialog open={picking} onOpenChange={(next) => { if (!next) setPicking(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Associate a Group</AlertDialogTitle>
          <AlertDialogDescription>
            Choose a Group you control to associate with this Asset.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <NativeSelect aria-label="Group to associate" value={chosen}
          onChange={(event) => setChosen(event.target.value)}>
          {associable.map((group) =>
            <option key={group.key} value={group.key}>{group.name}</option>)}
        </NativeSelect>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!chosen} onClick={() => {
            setPicking(false);
            setAssociating(associable.find((group) => group.key === chosen) ?? null);
          }}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={associating !== null}
      onOpenChange={(next) => { if (!next) setAssociating(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Associate {associating?.name} with this Asset?</AlertDialogTitle>
          <AlertDialogDescription>
            Members of {associating?.name} will be able to read and edit this Asset.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => {
            if (associating) onChange(associating.key, true);
            setAssociating(null);
          }}>{busy ? 'Associating…' : 'Associate'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={removing !== null}
      onOpenChange={(next) => { if (!next) setRemoving(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {removing?.name} from this Asset?</AlertDialogTitle>
          <AlertDialogDescription>
            Members of {removing?.name} will lose access unless another association or public
            readability still reaches them. This may end your own access to this Asset.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel rests under focus: the safe answer is the one a stray
              keypress gives. */}
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
            if (removing) onChange(removing.key, false);
            setRemoving(null);
          }}>{busy ? 'Removing…' : 'Remove'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Section>;
}
