import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Eyebrow, Panel } from './ui';

/** What a refused or missing page says, in the terms of what was asked for.
 * Unknown and unauthorized read the same, as the server answers them. */
function RouteError({ missingTitle, missingText, back }: {
  missingTitle: string; missingText: string; back: { to: string; label: string };
}) {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return <Panel><Eyebrow>{status ?? 'Connection error'}</Eyebrow>
    <h1>{status === 403 ? 'Access restricted' : status === 404 ? missingTitle : 'Unable to load this page'}</h1>
    <p>{status === 403 ? 'This page requires system administrator access.' : status === 404
      ? missingText : 'Check your connection and try again.'}</p>
    <Link to={back.to}>{back.label}</Link>
  </Panel>;
}

export function WorkspaceError() {
  return <RouteError missingTitle="Page unavailable"
    missingText="This page does not exist or you do not have access." back={{ to: '/', label: 'Back to Assets' }} />;
}

export function AssetError() {
  return <RouteError missingTitle="Asset unavailable"
    missingText="This Asset does not exist or you do not have access." back={{ to: '/', label: 'Back to Assets' }} />;
}

export function PersonError() {
  return <RouteError missingTitle="Person unavailable"
    missingText="This person does not exist or is not someone you can find on People."
    back={{ to: '/people', label: 'Back to People' }} />;
}
