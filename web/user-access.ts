import type { UserAccount } from '../server/identity-store';

export function userAccessLabel(state: UserAccount['credentialState']): 'Setup pending' | 'Password established' {
  return state === 'established' ? 'Password established' : 'Setup pending';
}
