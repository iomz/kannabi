# Project rules

Preserve the README naming story at the bottom of README.

- Use `Kannabi` for the product/brand and user-facing name.
- Use lowercase `kannabi` for technical identifiers such as repository, package/binary, and filesystem names.
- Use uppercase `KANNABI_*` for environment variables.
- Reporting requires an explicit Group context; that Group receives collaboration access.
- A sole Group may be selected automatically in the UI, but remains explicit in the API/domain.
- An Asset retains at least one collaboration Group; its initial Group has no continuing priority. Empty or unmanaged Groups retain their collaboration edges.
- Granting collaboration requires being a Group Manager of an existing collaborating Group and of the receiving Group, representing both sides in one operation. Removing a Group requires current Group-derived Asset access and being a Group Manager of that Group; managing another Group is insufficient.
- `reportedBy` is immutable provenance, never an authorization grant.
- Every canonical Asset change records, in the same statement as the change, who asserted it and whose authority accepted it. The asserter stays distinguishable from the acceptor even when they are the same person, the accepting authority comes from the authenticated actor and never from caller input, and appearing in provenance grants nothing.
- Change provenance is bounded current-state provenance describing the latest change only. It never becomes a history log, and it never replaces `reportedBy`.
- The asserting credential is recorded as a stable server-generated identity plus the label it carried at the time of the write. The identity is identity; the label is a historical snapshot and is never matched on, keyed by, or looked up. Renaming or revoking a credential never alters or hides existing provenance.
- `basis` identifies the basis; it is not the basis itself. It is an opaque bounded ASCII reference the asserting client owns, and Kannabi never generates, parses, dereferences, or registers namespace meaning for one. It is the only Tier 1 provenance value a caller supplies, and a public Asset may expose it.
- An Asset may carry one immutable attribution to the pre-existing source record it was created from: an opaque reference to that record, the instant the source states it recorded the Asset, the name the source states recorded it, and the source's own free-text description of the Asset. It is quoted evidence — Kannabi asserts only that the source says so — and is accepted when the Asset is created and on no other path.
- The attribution quotes at most one piece of content, that description, and never grows a second content field. Any other source field — location, category, memo, status, quantity, contact, or a value extracted from the description — is either a Kannabi-owned fact with its own semantics or stays outside Kannabi.
- Kannabi never alters a description it accepts, and need not accept every string a source holds: text that is not NFC, carries a control character other than tab and line breaks, or exceeds the bound is refused, never repaired. A null description means none is recorded in Kannabi, never that the source had none.
- Source attribution never becomes Kannabi's own chronology, authorship, identity, authorization, or current truth. `reportedAt` stays the sole Asset chronology and is never backdated from it; `reportedBy` stays the authenticated reporter and is never replaced by it; it is never a sort key, a structured filter, or cursor state. Free-text search may match the quoted description, and then says that it matched there, because a match on what a source said is not a match on a fact Kannabi holds.
- The quoted recorder is a bounded display label and nothing else: never resolved to a User, never matched on, keyed by, or looked up, and never a node or an edge. A recorder named in a pre-existing record may never have held a Kannabi account, so representing them as a User in any state, including a tombstone, would assert a membership that never happened.
- The source reference anchors the attribution and is required whenever it is present, so a quoted claim is always attributable to an identified record. It shares one opaque-reference grammar with `basis`, which is a different fact of the same shape: `basis` describes the latest change and moves with it, while source attribution describes where the record came from and never moves.
- An API token is a delegated credential issued under one User's authority, never an independent principal. It authenticates as that User and passes through the same Group-derived authorization, evaluated live. A User issues tokens only for themself; an administrator may revoke another User's token but never create one, because minting one would grant that User's Asset access.
- An admin-enabled token is a ceiling on the credential, never a grant. Administrator authority is re-read from the owning User on every request, and no token ever reaches an Asset outside its owner's Groups.
- The browser Origin requirement guards cookie-authenticated writes, which a browser sends automatically. A bearer credential is authenticated on its own and never falls back to a cookie, so presenting one can never opt a cookie-authenticated request out of that check.
- Do not introduce direct User-to-Asset ACLs.
- A person belongs to a Group through one membership with a role: **Member**, or **Group Manager** — a member who also manages the Group. There is no managing a Group without belonging to it: the role ends with the membership, whether by leaving, removal or account deletion, and startup refuses Group data that records management any other way.
- Group creation makes its creator a Group Manager. Being a Group Manager is the organizational authority for privileged operations on what the Group manages — adding and removing members, changing roles, changing which Groups collaborate on an Asset, and the managed GS1 namespace, its class keys and issuance from it. A Member's role is not authority over what the Group manages.
- Asset access stays Group-derived through membership. Where a privileged operation also acts on an Asset, that Asset's own access predicate is required independently and in addition, never in place of the role.
- Group Managers are peers. Any of them may add a member as either role, change anybody's role including their own, or remove anybody; a Group may deliberately be left with no Group Manager. Transfer is a promotion followed by a demotion; no successor is ever inferred.
- Per-resource separation of duties is deliberately not modelled: the Group Manager role carries every privileged operation over everything the Group manages, so a deployment cannot yet distinguish somebody who may administer a GS1 namespace from somebody who may recruit members. That distinction is real and may be introduced if a concrete deployment requires it; until then a second Group is how authority is scoped separately.
- Account deletion removes memberships, and their roles, without deleting Groups or requiring an automatic successor. Empty or unmanaged Groups remain valid.
- A system administrator can promote an existing active member to Group Manager only for a Group with no Group Manager. Recovery never adds Group membership or grants Asset access, so a Group with no members stays unmanaged.
- A new account takes part in the instance only once approved: by an administrator, or at signup when the instance does not require approval. Until then it reaches its own account and public Assets, as an anonymous visitor would, and nothing else. Approval is participation, never Asset access, and administrator-created accounts are approved when created.
- The People directory is an instance setting enforced by the server: every approved person, with or without email addresses, or only people sharing a Group. It decides who is findable and what is shown about them, never Group membership — which Groups somebody belongs to is shown only where the viewer belongs too — and anonymous and pending accounts never reach it. A search may match an email address only where that address is shown.
- Kannabi does not verify email addresses. An address is what its owner typed, so it is display context and never evidence of who somebody is or which organisation they belong to.
- A public Asset's full representation is readable without authentication through its public URI; public visibility never grants edit access.
- Do not introduce per-field public/private filtering.
- Every Asset has an immutable application-owned `Asset.id`, assigned at reporting time and never changed; startup verifies this and fails closed on data that violates it.
- `Asset.id` is a canonical lowercase UUIDv7, immutable and persistence-independent; it anchors internal Asset references and the native Asset URI without outranking domain identifier schemes.
- Identifier presentation must not imply a hierarchy between Kannabi's native Asset ID and domain identifier schemes. `Asset.id` is a stable implementation anchor, not a claim that UUID is the Asset's primary domain identity. GS1 and other identifiers are first-class identifiers associated with the Asset. Distinguish identifiers by scheme, semantics, provenance and authority, not by a user-facing “internal vs external” hierarchy. Whether the native Asset ID appears in ordinary UI is a presentation/deployment concern and never changes identity semantics.
- Migration assigns a native identity only where one is missing, under a lock that makes concurrent startup safe; an unrecognized identity is never repaired or replaced.
- The UUIDv7 timestamp has no domain meaning; Asset chronology uses explicit fields such as `reportedAt`.
- Internal database keys, including Neo4j node identity, remain implementation details.
- A Kannabi Asset exists independently of every identifier scheme. Registering and managing one must never require a scheme's knowledge or an identifier, and Kannabi with no scheme installed is complete.
- Kannabi core records identifiers and issues none; `Asset.id` is its only native identity. Whether a value was issued, by whom, and whether it may ever be reused are facts and policy of the plugin that issued it.
- External identifiers are optional and multiple: zero is a normal Asset state, and identifiers are attached and detached after creation without touching `Asset.id`.
- Domain identifiers retain their scheme and semantics whether Kannabi issues them or records an externally assigned value; neither possession nor issuance makes them authorization grants. Asset access stays Group-derived.
- Persistence labels that carry an identifier's derived level are persistence vocabulary; never promote them into domain concepts or expose them as identifier schemes.
- Each stored external identifier records the policy version that accepted it as historical provenance; a missing stamp is rejected, never replaced with the active version.
- Each Asset–identifier association records, on the association and in the same statement that creates it, who accepted it, when, and the basis the request named — the Tier 1 fields scoped to that association. It describes acceptance, never issuance or verification; it is fixed for the life of the association and removed with it, and a shared identifier node never carries it. An association recorded before Kannabi kept this reads as unknown, never as accepted by nobody.
- Identification level is derived by the scheme that owns the value and is never user-supplied or independently editable.
- A class-level identifier may describe many Assets; an individual-level identifier identifies exactly one, enforced by schema constraints rather than application sequencing.
- The native Asset URI is stable and always valid; the surfaced URI is presentation policy and never identity.
- A mutation is addressed by the native Asset identity the page carries, never by the presentation address it was submitted from. A presentation address is for reaching a page, and is not a carrier of identity.
- Resolving an address grants no access, whoever claimed the path; an Asset the reader may not see is indistinguishable from an unknown address.
- Account deletion removes the active personal account but preserves immutable Asset provenance by default.
- Deleted reporters become non-active tombstones that retain only the deletion-time display name required for human-readable provenance; they must not behave as discoverable Users.
- Tombstones do not retain email, credentials, sessions, preferences, administrator roles, or Group memberships.
- Deleting a Group's final member does not delete the Group; empty Groups are valid.
- Every Asset read takes an explicit audience. A `system` audience reads system-wide and is never a claim that User/Group authorization was applied. Whatever can reach a `system`-audience process can read the entire instance, so putting an authenticated gateway in front of one changes nothing: the gateway authenticates a person while Kannabi still answers with everything. Its reach must stay limited to readers already entitled to every Asset it returns.
- MCP tools reuse the same domain operations the HTTP API uses. MCP never calls Kannabi over HTTP and never reimplements persistence or domain semantics.
- An external identity is keyed by its issuer and subject together; email is display context and never an identity key. Only a `user` subject type maps to a Kannabi User, and an identity nobody has linked resolves to nobody.
- An asserted principal never creates or claims a Kannabi account, and a gateway's scopes never substitute for Kannabi's own authorization decision.
- Kannabi's MCP exposes only Kannabi-owned semantics. Generic graph access, EPCIS, and observation sources remain independent MCP servers; Kannabi never proxies them and exposes no Cypher or graph traversal.
- The MCP server states Kannabi's knowledge boundary in its connection instructions, naming the facts other systems own. An empty result must never be presentable as evidence about a fact Kannabi does not hold.
- Every handle an MCP tool returns must be accepted unchanged by the tool that consumes it, and every field an agent must interpret carries its own description.
- The MCP process's stdout is protocol; every diagnostic goes to stderr.
- The structured Asset representation (`server/asset-representation.ts`) encodes whose statement each value is in where it sits: `kannabi` for what Kannabi holds and did, `source.says` for what a source record states, `notRecorded` for kinds of fact Kannabi records none of. MCP returns it and the HTTP API serves it under `/api/v3`; neither builds its own. What an installed plugin states sits under `extensions.<plugin id>`, never under `kannabi`: it is that plugin's statement, follows the Asset's visibility whole, and core never sorts, filters or searches on it. A new Asset field takes its place in that structure in the same change, rather than an explanation in prose.
- No instant on an Asset is the time of a physical event. Every instant is the `at` of something Kannabi did, or the `recordedAt` a source says; an acquisition, loan, transfer or disposal date is never derived from either, nor from quoted text.
- A value Kannabi holds none of is an explicit null in the structured representation, never a missing key, and a summary states the paths it omits.

# Plugins

- A capability that one deployment has and another wholly lacks is a plugin under `plugins/<id>/`. Core is everything under `server/` and `web/` and imports no plugin. `server/composition.ts` names the installed plugins for the server; `web/plugins.ts` and `web/routes.ts` name them for the web client; nothing else does, and `server/core-boundary.test.ts` keeps it so.
- The web client takes a plugin's screens through the named slots of `web/plugin.ts`: scheme presentation, addresses, a part of the Asset page, a Group view and overview line, and its own settings section. A slot with no contributor renders nothing, and a plugin's screens read and save through the plugin's own routes.
- Composition is static. A different set of plugins is a different build: no discovery, no runtime loading, no enable flag, and no installing from the web interface, because whoever can install a plugin can read every Asset and system administration must not grant Asset access.
- A plugin adds and never overrides. No contribution lets one replace or skip authorization, provenance, the Asset access predicate or the Origin guard. Its routes mount under `/api/<id>/` behind core's authentication, an address it claims is served only to a reader core says may see the Asset, and inside an Asset write it may refuse while core does the writing.
- Absence is invisible: an uninstalled plugin leaves no route, tool, setting, navigation entry or empty panel behind.
- A plugin owns its vocabulary and its data. Its node labels carry its id as a prefix, it never sets a property on a core node, and it never joins two core nodes. What it holds about an Asset is keyed by `Asset.id`.
- The plugin contract (`server/plugin.ts`) grows only for a need two plugins share, or one a core invariant forces. Taking part in an identifier write is the one point admitted on a core invariant alone. A need only one plugin has stays inside that plugin.
- The plugin contract version is its own number, independent of the Kannabi software version. Startup refuses a plugin that does not list the running one.
- Plugins are trusted code in the same process. The contract is enforced by its shape, by review and by startup verification, never by a sandbox.
- A plugin keeps its own rules beside its code, in `plugins/<id>/AGENTS.md`. A rule about one scheme or one plugin's behaviour belongs there and not in this file.

# Design principles

Settings persistence: Simple discrete preferences persist on selection/change. Complex multi-field configuration uses explicit actions.

# Implementation

Use SemVer for releases. PATCH covers fixes and compatible improvements within an existing capability; MINOR adds or meaningfully expands a user-visible, domain, or API capability. During `0.x`, intentional breaking changes may ship in a MINOR release and must be identified as breaking. Choose the level by capability/contract change, not PR size or effort. Reserve `1.0.0` for a future explicit stability commitment. `package.json` is the canonical software version source; keep release tags aligned with it.
A pull request that changes what Kannabi ships — server, UI, HTTP API, MCP or persistence behaviour — must include the version bump that change warrants in `package.json`, and merging it is the release: the merge commit is tagged `vX.Y.Z` and published as a GitHub release. A pull request that ships nothing — documentation, tests, CI or agent instructions — does not bump. When two open pull requests claim the same version, the one merged second takes the next version when it is updated.
A standalone release pull request is the exception, for releasing work already on `main`; its description contains `@coderabbitai ignore`, because a version change alone has nothing to review.

Use Hono for server behavior, React Router v7 Framework Mode for UI, and Neo4j for master data.
Style the UI with Tailwind CSS and shadcn/ui components on Base UI; do not reintroduce a hand-written application stylesheet.
`web/themes/` is the only place colour is decided. It publishes a palette at runtime as `--kannabi-*`, and `web/style.css` maps that palette onto Tailwind's `--color-*` namespace — including the names the shadcn components ask for — with `@theme inline`. A component never hard-codes a colour, and a new colour is a new palette token rather than a literal.
`web/style.css` holds the theme bridge and decisions about the document as a whole. Anything narrower belongs to a component: shared compositions live in `web/ui.tsx`, and vendored primitives in `web/components/ui/`.
A vendored primitive may be edited, and the edit is explained where it is made; it is Kannabi's file once added.
Prefer the browser's own control where it already does the job; add a scripted one only for behaviour the native control cannot provide. Replacing a native control is an exception that is explained where it is made: the `type="search"` clear button is suppressed because it empties the field without changing the results, leaving the input disagreeing with what is on screen, and because a query that lives in the URL is cleared by navigating.
UI tests assert roles, accessible names and behaviour rather than class names or markup shape. A surface anchored in a portal — a dialog, a menu, a toast — is opened in a real document and read back, never asserted against static markup.
Keep one package and ordinary files until a concrete need requires more structure.
Keep object bytes behind the small S3 storage interface and photo metadata in Neo4j.
Keep administrative settings limited to photo-on-report policy, display timezone, built-in instance theme, the API token lifetime ceiling, toast lifetime, the two identifier presentation choices, whether new accounts require approval, and the People directory; store timestamps as absolute instants. A plugin's settings are its own, kept in its own data and changed through its own routes.
System administration must not grant Asset access.
Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for application changes.

The README capability matrix records what each of the three surfaces — web UI, HTTP API, MCP — can do. Any change that adds, removes, or materially changes what a surface exposes updates that table in the same change, and states the reason beneath it when an absence is deliberate. This keeps the record honest; it is not a requirement that the surfaces match. Asymmetry between them is normal and often the point, and the table exists so that each asymmetry is a decision somebody wrote down rather than something a reader has to infer from the route list.
Do not commit or push without explicit authorization.

A human acceptance-test cycle adds a restriction rather than relaxing the one above: committing still requires explicit authorization, and an authorized local commit must additionally not be pushed to the pull request branch until the human accepts that checkpoint. Pushing publishes the work for remote review and therefore advances the checkpoint on the human's behalf, which is theirs to decide.

GitHub Issue titles are concise plain-language imperative or problem statements, such as `Preserve detached identifier history` or `Decide whether identity lookup answers anonymous callers`.
Do not give an Issue a Conventional Commit prefix or scope such as `feat(...)`, `fix(...)`, `refactor(...)` or `test(...)`; an Issue names a problem or an outcome, not a commit.
Branches and commits keep their own conventional prefixes, and pull request naming follows the existing repository convention rather than this rule.

Private working context — conversations, research notes, and the examples used in them — is not automatically publishable.
Before creating or editing a public Issue or Issue comment, remove incidental personal and private detail, and prefer fictional or anonymized examples wherever a real identity is not technically necessary.
Keep concrete empirical evidence whose specificity the engineering or research record genuinely depends on, and minimize unrelated personal information around it rather than weakening the evidence.
When it is unclear whether a private detail needs to be published, ask instead of publishing it.

## Deciding a visual question

When the semantics and the interaction are settled but the way something should look is not, stop guessing at it one small change at a time. Repeatedly shipping a styling tweak to be looked at spends a review cycle per guess and resolves nothing in writing.

Build a temporary design-lab route instead: out of the navigation, reachable only by address, mutating nothing.

Put materially different candidate treatments beside each other, and include the real production component where one exists, so the comparison is between things that actually render rather than between descriptions of them. Hold the settled semantics and interaction constant, so the only thing varying is the open question. Use the real design system and real components; a comparison between approximations decides nothing.

Label each variant with what it is testing and say which one currently ships. Include the content that might change the answer — a short, an ordinary and a long value, an empty state — and check the variants in both colour schemes, because a treatment can be obvious in one and effectively invisible in the other.

The point is to let acceptance choose between rendered alternatives rather than translating a visual reaction through another round of prose and implementation.

Once the choice is made, apply it, and delete the lab along with the variants that lost. A lab left behind is dead code that reads like a decision still being made.

## Browser and GUI verification

Unless explicitly requested, do not launch or attach to a browser, desktop application, or other GUI for manual interaction testing.

Prefer automated unit, integration, API, typecheck, and build validation. The user performs routine manual UI/UX acceptance separately.

Browser or GUI interaction may still be requested explicitly when it is necessary to investigate a browser-specific problem or reproduce an issue that cannot reasonably be validated otherwise.

Do not treat the absence of agent-driven browser testing as incomplete validation when the relevant automated checks pass. Report what was validated automatically and leave manual UI acceptance to the user.
