import { Link } from 'react-router';
import { api, unwrap } from '../api';
import { publicShellHandle } from '../anonymous-shell';
import { PageHeading, Panel } from '../ui';
import type { PeopleDirectory } from '../../server/settings.js';
import type { Route } from './+types/help';

/** A short guide to what Kannabi is and how its Groups work.
 *
 * Readable signed in or not, like a public Asset: it explains rules, and
 * reveals nothing about this instance beyond its People directory setting,
 * which the public settings read already says. It says the
 * same as the README; when one changes, so does the other.
 */
export const handle = publicShellHandle;

export async function clientLoader() {
  const { settings } = await unwrap(await api.settings.$get());
  return { directory: settings.peopleDirectory };
}

/** Verified against the server's authorization, not inferred from labels:
 * Asset reads, edits and reports follow membership; the people operations and
 * managed GS1 operations follow the Group Manager role. */
const roles: [string, boolean, boolean][] = [
  ['Read and edit the Group’s private Assets', true, true],
  ['Report new Assets into the Group', true, true],
  ['See everybody in the Group and their role', true, true],
  ['Leave the Group', true, true],
  ['Add or remove people', false, true],
  ['Make someone a Group Manager, or remove the role', false, true],
  ['Manage the Group’s GS1 Company Prefixes', false, true],
];

const directoryText: Record<PeopleDirectory, string> = {
  everyone: 'everybody on this instance can find everybody else, by name or email',
  names: 'everybody on this instance can find everybody else by name; email addresses are not shown',
  shared: 'people find only those they already share a Group with, and add anybody else by member key',
};

const prose = 'max-w-3xl text-[.95rem] leading-relaxed [&_h2]:mb-3 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:ps-5';

export default function Help({ loaderData: { directory } }: Route.ComponentProps) {
  const mark = (value: boolean) => value ? <span>Yes</span> : <span className="text-muted-foreground">No</span>;
  return <>
    <PageHeading eyebrow="Help" title="How Kannabi works"
      description="The essentials: Assets, Groups, roles, and finding people." />

    <Panel className={prose}>
      <h2>What Kannabi does</h2>
      <p>Kannabi keeps a shared record of physical Assets — equipment, tools, devices — and of who can see and
        change each one. Every Asset has a stable Kannabi ID, and may also carry identifiers such as GS1 keys.</p>
    </Panel>

    <Panel className={prose}>
      <h2>Assets and Inventory</h2>
      <p>The <Link to="/">Inventory</Link> lists the Assets you can read. You can read an Asset when it is public, or
        when it is shared with a Group you are in. Reporting an Asset records it under one of your Groups, and
        that Group’s people can then read and edit it. A public Asset is readable by anybody, but only the people
        in its Groups can change it.</p>
      <p><Link to="/lookup">Lookup</Link> finds an Asset by its Kannabi ID or by an identifier it carries. Finding
        one never gives you access you did not already have.</p>
    </Panel>

    <Panel className={prose}>
      <h2>Groups</h2>
      <p>A Group is the way Assets are shared. Open <Link to="/groups">Groups</Link> to create one or to see yours;
        each Group has its own page with an Overview, its Assets, its People and its GS1 prefixes.</p>
      <h2 className="mt-6">Member and Group Manager</h2>
      <p>Everybody in a Group is a member. Some members are also its <strong>Group Managers</strong>: they look
        after the Group itself — who is in it, their roles, and its GS1 Company Prefixes. Whoever creates a Group
        is its first Group Manager.</p>
      <div className="mb-3 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="sr-only">What a Member and a Group Manager can do</caption>
          <thead><tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">In a Group, you can</th>
            <th scope="col" className="px-3 py-2 font-medium">As a Member</th>
            <th scope="col" className="px-3 py-2 font-medium">As a Group Manager</th>
          </tr></thead>
          <tbody>{roles.map(([what, member, manager]) => <tr key={what} className="border-b last:border-b-0">
            <th scope="row" className="px-3 py-2 text-left font-normal">{what}</th>
            <td className="px-3 py-2">{mark(member)}</td>
            <td className="px-3 py-2">{mark(manager)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p>Leaving a Group ends any role in it. A Group can be left with no Group Manager; an administrator can then
        promote one of its members.</p>
    </Panel>

    <Panel className={prose}>
      <h2>Adding people</h2>
      <p>On a Group’s People page, a Group Manager chooses <strong>Add people</strong>, searches for the person, and
        chooses <strong>Member</strong> or <strong>Group Manager</strong>. Each person’s <strong>Change</strong> menu
        changes their role or removes them; anything that takes access or authority away asks you to confirm
        first, and nothing affects what the person has through other Groups.</p>
      {directory === 'shared' && <>
        <h2 className="mt-6">The member key</h2>
        <p>Somebody who shares no Group with anyone yet cannot be found by name. They copy their
          <strong> member key</strong> from their <Link to="/groups">Groups</Link> page and send it to a Group Manager,
          who pastes it under “Not listed? Use their member key” in Add people.</p>
      </>}
    </Panel>

    <Panel className={prose}>
      <h2>People and email addresses</h2>
      <p>On this instance, {directoryText[directory]}. An administrator chooses this. Which Groups somebody belongs to
        is shown only to people in the same Group.</p>
    </Panel>
  </>;
}
