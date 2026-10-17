import type { UserAccount } from '../server/identity-store';

export function filterUsers(users: readonly UserAccount[], query: string): UserAccount[] {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [...users];
  return users.filter((user) =>
    user.name.toLocaleLowerCase().includes(text) || user.email.toLocaleLowerCase().includes(text));
}

export const userSortColumns = ['name', 'email', 'joined', 'access', 'role'] as const;
export type UserSortColumn = (typeof userSortColumns)[number];
export type UserSort = { column: UserSortColumn; direction: 'ascending' | 'descending' };

/** Access in the order an administrator works through it: waiting for
 * approval, then setup not finished, then established. */
function accessRank(user: UserAccount): number {
  return !user.approvedAt ? 0 : user.credentialState === 'pending' ? 1 : 2;
}

const compare: Record<UserSortColumn, (a: UserAccount, b: UserAccount) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  email: (a, b) => a.email.localeCompare(b.email),
  joined: (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
  access: (a, b) => accessRank(a) - accessRank(b),
  role: (a, b) => Number(b.isAdmin) - Number(a.isAdmin),
};

/** The users in the chosen order, ties kept in loaded order. An unknown join
 * date sorts last either way, because it is an absence rather than a value. */
export function sortUsers(users: readonly UserAccount[], sort: UserSort | null): UserAccount[] {
  if (!sort) return [...users];
  const sign = sort.direction === 'ascending' ? 1 : -1;
  return users.map((user, index) => ({ user, index })).sort((a, b) => {
    if (sort.column === 'joined' && !a.user.createdAt !== !b.user.createdAt) return a.user.createdAt ? -1 : 1;
    return sign * compare[sort.column](a.user, b.user) || a.index - b.index;
  }).map(({ user }) => user);
}

/** The next order after a header is chosen: ascending first, then reversed. */
export function nextUserSort(current: UserSort | null, column: UserSortColumn): UserSort {
  return current?.column === column && current.direction === 'ascending'
    ? { column, direction: 'descending' } : { column, direction: 'ascending' };
}
