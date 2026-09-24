import { redirect } from 'react-router';

export function clientLoader() {
  throw redirect('/admin/users');
}

export default function LegacyAdminMembersRedirect() {
  return null;
}
