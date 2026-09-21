/** Who a read is performed for.
 *
 * Kannabi's readability rule is Group-derived: an Asset is readable when it is
 * public, or when the reader shares a Group that collaborates on it. `user` and
 * `public` are the ordinary audiences the web application uses, and they carry
 * exactly the semantics the HTTP API has always had.
 *
 * `system` is a deliberate exception. The local stdio MCP server runs as a
 * trusted process with no Kannabi principal to act as, so it reads the whole
 * graph and crosses ordinary User/Group readability boundaries — private Assets
 * and Group membership included. That is an accepted MVP limitation of the
 * local MCP process, never a claim that Kannabi authorization was preserved,
 * and such a process must not be exposed over a network.
 *
 * The audience is an explicit parameter of every Asset read rather than an
 * ambient mode, so a later principal or policy layer can narrow what MCP sees
 * by constructing a different audience — without changing any tool, query, or
 * projection.
 */
export type AssetAudience =
  | Readonly<{ kind: 'user'; actorKey: string }>
  | Readonly<{ kind: 'public' }>
  | Readonly<{ kind: 'system' }>;

/** Anonymous readers: public Assets only. */
export const publicAudience: AssetAudience = Object.freeze({ kind: 'public' as const });

/** System-wide read access. See the module note before using it. */
export const systemAudience: AssetAudience = Object.freeze({ kind: 'system' as const });

/** Construct the ordinary authenticated audience for one User. */
export function userAudience(actorKey: string): AssetAudience {
  return Object.freeze({ kind: 'user' as const, actorKey });
}

/** An audience that names who is reading: a User key, or an explicit audience.
 *
 * `null` is deliberately absent. Most reads require a reader, and accepting
 * `null` there would let a missing actor key silently degrade a Group-scoped
 * read into a public one instead of failing to compile.
 */
export type NamedAudienceInput = AssetAudience | string;

/** The same, plus `null` for the genuinely anonymous read: a public Asset is
 * readable through its public URI with no reader at all. Only reads that have
 * that meaning accept it. */
export type AudienceInput = NamedAudienceInput | null;

/** Normalize a User key, explicit audience, or anonymous read into an audience. */
export function assetAudience(value: AudienceInput): AssetAudience {
  if (value === null) return publicAudience;
  return typeof value === 'string' ? userAudience(value) : value;
}

/** Query parameters backing the readability predicate.
 *
 * Only a `user` audience has an actor key; the others read as no one in
 * particular, so actor-relative predicates such as `scope=mine` are simply
 * unsatisfied rather than quietly widened.
 */
export function audienceParameters(value: AudienceInput): { actorKey: string | null; systemRead: boolean } {
  const audience = assetAudience(value);
  return {
    actorKey: audience.kind === 'user' ? audience.actorKey : null,
    systemRead: audience.kind === 'system',
  };
}
