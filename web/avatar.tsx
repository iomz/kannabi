import { useEffect, useState } from 'react';
import { gravatarUrl } from '../shared/avatar.js';

/** One avatar, wherever a person appears.
 *
 * `hash` is supplied by the server and exists only for a User who turned
 * Gravatar on. When it is absent nothing remote is requested and nothing
 * remote is rendered — the initial is not a placeholder waiting for an image,
 * it is the avatar.
 *
 * When a hash is present Gravatar answers 404 for anybody who has no picture
 * there, so the same initial is used rather than a generated stand-in for
 * somebody who never chose one.
 *
 * This is deliberately not the shadcn Avatar: that one treats its fallback as
 * what to show while an image is on its way, which is the opposite of what is
 * true here.
 */
export function Avatar({ name, hash, size = 32, className }: {
  name: string;
  hash?: string | null;
  /** Rendered size in CSS pixels; the image is requested at twice this. */
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [hash]);
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase();
  const classes = ['shrink-0 rounded-full bg-brand-soft text-brand-text', className]
    .filter(Boolean).join(' ');
  const box = { width: size, height: size, fontSize: Math.round(size * 0.45) };
  if (!hash || failed) {
    return <span className={`${classes} grid place-items-center font-[650] leading-none`}
      style={box} aria-hidden="true">{initial}</span>;
  }
  return <img className={`${classes} object-cover`} style={box} alt="" aria-hidden="true"
    width={size} height={size}
    src={gravatarUrl(hash, size * 2)} referrerPolicy="no-referrer" loading="lazy"
    onError={() => setFailed(true)} />;
}
