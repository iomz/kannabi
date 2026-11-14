import type { ComponentType, ReactNode } from 'react';
import { assetPath } from '../shared/asset-uri';

/** The contract between Kannabi's web client and a plugin's screens.
 *
 * The server's contract is `server/plugin.ts`; this is its counterpart for a
 * single-page build, whose routes and modules are fixed when it is built.
 * Composition is static here too: `web/plugins.ts` names the installed
 * plugins, `web/routes.ts` takes their routes, and no other file in the web
 * client imports a plugin.
 *
 * A slot with no contributor renders nothing. A plugin's screens use the same
 * theme tokens, vendored primitives and shared compositions as core's, and
 * every decision they display is still the server's on every request.
 */

/** One field a caller fills in to name an identifier of a scheme. */
export type SchemeInput = Readonly<{
  name: string; label: string; hint?: string; required: boolean; maxLength?: number; numeric?: boolean;
}>;

/** How one identifier scheme is presented. The scheme's meaning stays with
 * whoever defines it: `reference` points at that definition rather than
 * paraphrasing it. */
export type SchemePresentation = Readonly<{
  id: string;
  label: string;
  description: string;
  inputs: readonly SchemeInput[];
  /** Where the scheme is defined, and how to name that for a reader. */
  reference?: Readonly<{ href: string; label: string }>;
  /** What the policy that accepted a value is called, such as "GS1 policy". */
  policyLabel?: string;
  /** What an address this scheme supplies is called, such as "GS1 Digital Link". */
  addressLabel?: string;
}>;

/** The Asset facts a plugin's screens are given: its native id and what it
 * carries. Structural, so a list row and a full Asset both satisfy it. */
export type CarriedIdentifier = Readonly<{
  scheme: string; canonical: string; level: 'individual' | 'class'; components: Readonly<Record<string, string>>;
}>;
export type AddressedAsset = Readonly<{ id: string; identifiers: readonly CarriedIdentifier[] }>;

/** What a plugin's part of the Asset page is told about the reader. Display
 * only: the server re-checks every one of these on every request. */
export type AssetPageContext = Readonly<{
  asset: AddressedAsset;
  /** Whether the reader takes part in the instance at all. */
  participant: boolean;
  /** The keys of the Groups collaborating on the Asset. */
  assetGroups: readonly string[];
  /** The keys of the Groups the reader is a Group Manager of. */
  managedGroups: readonly string[];
}>;

/** What a plugin says about one identifier an Asset carries: a short badge in
 * place of core's "Recorded existing", and a sentence of its own beneath. */
export type IdentifierStanding = Readonly<{
  badge: string;
  note: ReactNode;
  /** What detaching this identifier means, said before it is detached. */
  detachConsequence: string;
}>;

/** A way to add an identifier beside recording one that already exists. The
 * panel renders inside a form core owns, which carries the Asset's identity;
 * its fields are handed back to `submit` as they were filled in. */
export type AddIdentifierPanel<Data> = Readonly<{
  label: string;
  Panel: ComponentType<Readonly<{
    data: Data; asset: AddressedAsset; busy: boolean; error: string | null;
  }>>;
  /** Perform the addition. Answers the Asset as it now stands and the
   * canonical form it added, so the new identifier can be picked out. */
  submit(assetId: string, fields: FormData): Promise<Readonly<{ asset: AddressedAsset; added: string | null }>>;
  /** What to tell the reader once it succeeded. */
  done: string;
  /** What to say when it fails without a reason of its own. */
  failed: string;
}>;

export type AssetPageSlot<Data = unknown> = Readonly<{
  /** Read whatever this plugin shows on the Asset page. */
  load(context: AssetPageContext): Promise<Data>;
  standing?(data: Data, identifier: CarriedIdentifier): IdentifierStanding | null;
  add?: AddIdentifierPanel<Data>;
  /** Whatever the panel's remount key should follow, so a form resets when
   * what it offers has changed. */
  revision?(data: Data): string;
}>;

/** A line in a Group's overview and, optionally, a view of its own. The view's
 * route is contributed through `web/routes.ts`. */
export type GroupSlot<Data = unknown> = Readonly<{
  view?: Readonly<{ path: string; label: string }>;
  overview?: Readonly<{
    label: string;
    load(groupKey: string): Promise<Data>;
    Summary: ComponentType<Readonly<{ data: Data }>>;
  }>;
}>;

/** A plugin's own settings, shown among the instance settings. It reads and
 * saves through the plugin's own routes: a plugin's settings are never part
 * of core's. */
export type AdminSettingsSlot<Data = unknown> = Readonly<{
  load(): Promise<Data>;
  Section: ComponentType<Readonly<{ data: Data; disabled: boolean }>>;
}>;

export type WebPlugin = Readonly<{
  /** The plugin's id, the same as on the server. */
  id: string;
  schemes?: readonly SchemePresentation[];
  /** The addresses, beside the native Asset URI, at which this Asset is
   * served where it stands. */
  addresses?(asset: AddressedAsset): readonly string[];
  /** The address to put in front of a person in place of the native Asset
   * URI, or null. It must be one of `addresses`. Presentation only. */
  surfaced?(asset: AddressedAsset): string | null;
  /** What a surfaced address is called on the Asset page. */
  surfacedLabel?: Readonly<{ name: string; help: ReactNode }>;
  // The slots carry each plugin's own data type, which only that plugin
  // reads; core passes it back unread.
  assetPage?: AssetPageSlot<any>;
  group?: GroupSlot<any>;
  adminSettings?: AdminSettingsSlot<any>;
}>;

/** The installed plugins as the web client consults them. */
export type WebPlugins = ReturnType<typeof installed>;

export function installed(plugins: readonly WebPlugin[]) {
  const schemes = plugins.flatMap((plugin) => plugin.schemes ?? []);
  const byId = new Map(schemes.map((scheme) => [scheme.id, scheme]));
  const surfacedBy = (asset: AddressedAsset) => {
    for (const plugin of plugins) {
      const path = plugin.surfaced?.(asset) ?? null;
      if (path !== null) return { plugin, path };
    }
    return null;
  };
  /** The path put in front of a person for this Asset: one a plugin surfaces,
   * and its native Asset URI otherwise. An Asset nothing is surfaced for is
   * not a lesser case; its native URI is presented without qualification. */
  const surfacedPath = (asset: AddressedAsset) => surfacedBy(asset)?.path ?? assetPath(asset.id);
  /** Every address that serves this Asset where it stands, without a
   * redirect: each plugin's addresses, and the native URI only when nothing
   * is surfaced in its place, because once something is the server redirects
   * the native URI there. */
  const servingPaths = (asset: AddressedAsset) => {
    const claimed = plugins.flatMap((plugin) => [...(plugin.addresses?.(asset) ?? [])]);
    return surfacedBy(asset) === null ? [...claimed, assetPath(asset.id)] : claimed;
  };
  return Object.freeze({
    plugins,
    schemes,
    /** A scheme's presentation, or null for a scheme no installed plugin
     * presents, which is then named by its id and nothing more. */
    scheme: (id: string) => byId.get(id) ?? null,
    schemeLabel: (id: string) => byId.get(id)?.label ?? id,
    surfacedPath,
    servingPaths,
    /** Which plugin's label names the surfaced address of this Asset. */
    surfacedLabel: (asset: AddressedAsset) => surfacedBy(asset)?.plugin.surfacedLabel ?? null,
    /** Where a viewer standing at `current` should be sent after this Asset's
     * identifiers changed, or null to stay put.
     *
     * Post-mutation navigation, and deliberately not canonicalization. A
     * viewer at a valid address that is not the surfaced one stays there,
     * because that address still serves the Asset and moving them would do by
     * navigation what resolution is forbidden to do by redirect. A viewer
     * moves only when the address they stand on no longer serves the Asset.
     * Nothing here changes how any address resolves. */
    transition: (current: string, asset: AddressedAsset) =>
      (servingPaths(asset).includes(current) ? null : surfacedPath(asset)),
  });
}
