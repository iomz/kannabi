import { useState } from 'react';
import { api, unwrap } from './api';
import { Avatar } from './avatar';
import { Switch } from './switch';
import { Hint } from './ui';

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
    <div className="flex items-start gap-4">
      <Avatar name={name} hash={hash} size={56} />
      <div>
        <Switch checked={enabled} disabled={busy}
          onCheckedChange={(checked) => void change(checked)}
          label="Use my Gravatar" />
        <Hint className="max-w-[38rem]">Kannabi asks Gravatar for a picture using a one-way hash of your email
          address. Nothing is sent until you turn this on, and turning it off stops it at once.
          Without it, your initial is your avatar.</Hint>
      </div>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error.endsWith('.') ? error : error + '.'}</p>}
  </>;
}
