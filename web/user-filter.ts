import type { UserAccount } from '../server/identity-store';

export function filterUsers(users: readonly UserAccount[], query: string): UserAccount[] {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [...users];
  return users.filter((user) =>
    user.name.toLocaleLowerCase().includes(text) || user.email.toLocaleLowerCase().includes(text));
}
