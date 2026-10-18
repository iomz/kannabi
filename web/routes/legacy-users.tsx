import { redirect } from 'react-router';

export function clientLoader() {
  throw redirect('/people');
}

export default function LegacyUsersRedirect() {
  return null;
}
