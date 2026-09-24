import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Eyebrow, Panel } from './ui';

export function WorkspaceError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : null;
  return <Panel><Eyebrow>{status ?? 'Connection error'}</Eyebrow>
    <h1>{status === 403 ? 'Access restricted' : status === 404 ? 'Asset unavailable' : 'Unable to load this page'}</h1>
    <p>{status === 403 ? 'This page requires system administrator access.' : status === 404
      ? 'This Asset does not exist or you do not have access.' : 'Check your connection and try again.'}</p>
    <Link to="/">Back to Assets</Link>
  </Panel>;
}
