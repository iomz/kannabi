import { redirect } from 'react-router';

/** The account page became User settings. Existing links and bookmarks keep
 * working rather than becoming a dead end. */
export async function clientLoader() { return redirect('/settings'); }
export default function Profile() { return null; }
