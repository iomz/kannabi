import { redirect } from 'react-router';

export function clientLoader() {
  throw redirect('/members');
}

export default function LegacyUsersRedirect() {
  return null;
}
