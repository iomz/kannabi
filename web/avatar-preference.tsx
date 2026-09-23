import { useState } from 'react';
import { api, unwrap } from './api';
import { Avatar } from './avatar';
import { Switch } from './switch';

/** Consent for a third-party lookup, stated where the address it uses is.
 *
 * The copy says what leaves Kannabi and what does not, because "use Gravatar"
 * on its own does not tell somebody that their address is being hashed and
 * sent somewhere.
 */
export function AvatarPreference({ name, gravatar, avatarHash }: {
  name: string;
  gravatar: boolean;
  avatarHash: string | null;
}) {
  const [enabled, setEnabled] = useState(gravatar);
  const [hash, setHash] = useState(avatarHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    const previous = { enabled, hash };
    setEnabled(next);
    // Turning it off stops Kannabi rendering a remote URL immediately, before
    // the request that records the decision has even returned.
    if (!next) setHash(null);
    try {
      await unwrap(await api.profile.avatar.$patch({ json: { gravatar: next } }));
      if (next) {
        const { avatarHash: refreshed } = await unwrap(await api.me.$get());
        setHash(refreshed);
      }
    } catch (failure) {
      setEnabled(previous.enabled);
      setHash(previous.hash);
      setError(failure instanceof Error ? failure.message : 'The avatar preference could not be saved');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h2>Avatar</h2>
    <div className="avatar-preference">
      <Avatar name={name} hash={hash} size={56} className="avatar-preview" />
      <div>
        <Switch checked={enabled} disabled={busy}
          onChange={(event) => void change(event.currentTarget.checked)}
          label="Use my Gravatar" />
        <p className="hint">Kannabi asks Gravatar for a picture using a one-way hash of your email
          address. Nothing is sent until you turn this on, and turning it off stops it at once.
          Without it, your initial is your avatar.</p>
      </div>
    </div>
    {error && <p className="confirmation-error" role="alert">{error.endsWith('.') ? error : error + '.'}</p>}
  </>;
}
