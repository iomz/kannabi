# Project rules

Preserve the README naming story at the bottom of README.

- Use `Kannabi` for the product/brand and user-facing name.
- Use lowercase `kannabi` for technical identifiers such as repository, package/binary, and filesystem names.
- Use uppercase `KANNABI_*` for environment variables.
- Reporting requires an explicit Group context; that Group receives collaboration access.
- A sole Group may be selected automatically in the UI, but remains explicit in the API/domain.
- An Asset retains at least one collaboration Group; its initial Group has no continuing priority. Empty or uncontrolled Groups retain their collaboration edges.
- Granting collaboration requires membership and control in an existing collaborating Group plus control of the receiving Group, representing both sides in one operation. Removing a Group requires current Group-derived Asset access and control of that Group; control of another Group is insufficient. Control alone never grants Asset access.
- `reportedBy` is immutable provenance, never an authorization grant.
- Every canonical Asset change records, in the same statement as the change, who asserted it and whose authority accepted it. The asserter stays distinguishable from the acceptor even when they are the same person, the accepting authority comes from the authenticated actor and never from caller input, and appearing in provenance grants nothing.
- Change provenance is bounded current-state provenance describing the latest change only. It never becomes a history log, and it never replaces `reportedBy`.
- The asserting credential is recorded as a stable server-generated identity plus the label it carried at the time of the write. The identity is identity; the label is a historical snapshot and is never matched on, keyed by, or looked up. Renaming or revoking a credential never alters or hides existing provenance.
- `basis` identifies the basis; it is not the basis itself. It is an opaque bounded ASCII reference the asserting client owns, and Kannabi never generates, parses, dereferences, or registers namespace meaning for one. It is the only Tier 1 provenance value a caller supplies, and a public Asset may expose it.
- An API token is a delegated credential issued under one User's authority, never an independent principal. It authenticates as that User and passes through the same Group-derived authorization, evaluated live. A User issues tokens only for themself; an administrator may revoke another User's token but never create one, because minting one would grant that User's Asset access.
- An admin-enabled token is a ceiling on the credential, never a grant. Administrator authority is re-read from the owning User on every request, and no token ever reaches an Asset outside its owner's Groups.
- The browser Origin requirement guards cookie-authenticated writes, which a browser sends automatically. A bearer credential is authenticated on its own and never falls back to a cookie, so presenting one can never opt a cookie-authenticated request out of that check.
- Do not introduce direct User-to-Asset ACLs.
- Group creation explicitly grants its creator membership and membership-management control. Membership alone cannot add members; Group control alone never grants membership, Asset access, or namespace authority.
- Account deletion removes Group-control grants without deleting Groups or requiring an automatic successor. Empty or uncontrolled Groups remain valid.
- A system administrator can appoint an active controller only for a Group with no controller. Recovery never adds Group membership or grants Asset access.
- A public Asset's full representation is readable without authentication through its public URI; public visibility never grants edit access.
- Do not introduce per-field public/private filtering.
- Every Asset has an immutable application-owned `Asset.id`, assigned at reporting time and never changed; startup verifies this and fails closed on data that violates it.
- `Asset.id` is a canonical lowercase UUIDv7, immutable and persistence-independent; it anchors internal Asset references and the native Asset URI without outranking domain identifier schemes.
- Identifier presentation must not imply a hierarchy between Kannabi's native Asset ID and domain identifier schemes. `Asset.id` is a stable implementation anchor, not a claim that UUID is the Asset's primary domain identity. GS1 and other identifiers are first-class identifiers associated with the Asset. Distinguish identifiers by scheme, semantics, provenance and authority, not by a user-facing “internal vs external” hierarchy. Whether the native Asset ID appears in ordinary UI is a presentation/deployment concern and never changes identity semantics.
- Migration assigns a native identity only where one is missing, under a lock that makes concurrent startup safe; an unrecognized identity is never repaired or replaced.
- The UUIDv7 timestamp has no domain meaning; Asset chronology uses explicit fields such as `reportedAt`.
- Internal database keys, including Neo4j node identity, remain implementation details.
- A Kannabi Asset exists independently of GS1. Registering and managing one must never require GS1 knowledge or a GS1 identifier.
- External identifiers are optional and multiple: zero is a normal Asset state, and identifiers are attached and detached after creation without touching `Asset.id`.
- Domain identifiers retain their scheme and semantics whether Kannabi issues them or records an externally assigned value; neither possession nor issuance makes them authorization grants. Asset access stays Group-derived.
- GS1 syntax rules are enforced strictly at one boundary, and the internal domain model must not become the GS1 ontology.
- GS1 `req=`/`ex=` association rules belong to a single AI element string; never apply them across the independent identifiers of one Asset. Asset-level cardinality is permissive, GS1 validity within an identifier is strict.
- Persistence labels that carry a derived GS1 level are persistence vocabulary; never promote them into domain concepts or expose them as identifier schemes.
- GS1 rules are versioned policy data, not application conditionals, and the policy version is independent of the Kannabi software version.
- Kannabi must never present its own Syntax Dictionary to General Specifications mapping as a GS1 assertion.
- A GS1 policy bump governs future acceptance only; stored identifiers are never revalidated or rewritten, and a scheme's canonical layout may not change without a data migration.
- Each stored external identifier records the policy version that accepted it as historical provenance; a missing stamp is rejected, never replaced with the active version.
- Conformance rules apply to the semantic object the standard governs. Enforcing a rule strictly at the wrong boundary is itself incorrect, not merely over-strict.
- Allocation authority comes from a configured namespace plus an immutable allocation record; possessing or storing an identifier never implies Kannabi issued it.
- Kannabi can guarantee the configured prefix boundary for values it issues, and makes no equivalent authority claim about values it merely stores. Never promote a plausible-looking heuristic into a standards rule.
- A Kannabi-issued GIAI is never reused. It may be detached from its Asset, but the ledger permanently binds the issuance to that Asset, so it can only ever return there.
- Existing-use exclusion ranges protect references that were already unavailable when a namespace was configured; they are namespace configuration, distinct from the issuance ledger, and are never a free list.
- `GiaiNamespace.active` is configuration state, not allocation lifecycle. Deactivation stops new issuance and preserves the counter, exclusions and every issued record.
- One managed GCP belongs to one Group. This is a Kannabi authorization-boundary restriction for the current model, not a claim about GS1 organizational semantics.
- Any current Group member may configure a GCP namespace and allocate from it. This is a temporary assumption that Issue #20 will narrow without changing namespace or allocation semantics or any ledger data.
- Identification level is derived from GS1 semantics and is never user-supplied or independently editable.
- A class-level identifier may describe many Assets; an individual-level identifier identifies exactly one, enforced by schema constraints rather than application sequencing.
- Allocation authority is never inferred from possession of an identifier; a stored identifier is not evidence that Kannabi allocated it.
- The native Asset URI is stable and always valid; the surfaced URI is presentation policy and never identity.
- A Digital Link URI is derived from identifier data on read and never stored.
- Each supported Digital Link form independently resolves to the Asset; Kannabi never redirects one Digital Link form to another.
- After a mutation, a client may navigate away from an address that no longer serves the Asset. This is navigation, never canonicalization: a viewer at a valid non-preferred Digital Link stays, and resolution of every address is unchanged.
- A mutation is addressed by the native Asset identity the page carries, never by the presentation address it was submitted from. A presentation address is for reaching a page, and is not a carrier of identity.
- Kannabi dereferences the Digital Link forms it supports and makes no GS1-Conformant Resolver claim. "Canonical GS1 Digital Link URI" is the standard's term for the `id.gs1.org` form, which Kannabi never emits.
- Resolving through a Digital Link grants no access; an Asset the reader may not see is indistinguishable from an unknown identifier.
- Company-prefix inference and GS1-Conformant Resolver behaviour remain deferred.
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

# Design principles

Settings persistence: Simple discrete preferences persist on selection/change. Complex multi-field configuration uses explicit actions.

# Implementation

Use SemVer for releases. PATCH covers fixes and compatible improvements within an existing capability; MINOR adds or meaningfully expands a user-visible, domain, or API capability. During `0.x`, intentional breaking changes may ship in a MINOR release and must be identified as breaking. Choose the level by capability/contract change, not PR size or effort. Reserve `1.0.0` for a future explicit stability commitment. `package.json` is the canonical software version source; keep release tags aligned with it.

Use Hono for server behavior, React Router v7 Framework Mode for UI, and Neo4j for master data.
Style the UI with Tailwind CSS and shadcn/ui components on Base UI; do not reintroduce a hand-written application stylesheet.
`web/themes/` is the only place colour is decided. It publishes a palette at runtime as `--kannabi-*`, and `web/style.css` maps that palette onto Tailwind's `--color-*` namespace — including the names the shadcn components ask for — with `@theme inline`. A component never hard-codes a colour, and a new colour is a new palette token rather than a literal.
`web/style.css` holds the theme bridge and decisions about the document as a whole. Anything narrower belongs to a component: shared compositions live in `web/ui.tsx`, and vendored primitives in `web/components/ui/`.
A vendored primitive may be edited, and the edit is explained where it is made; it is Kannabi's file once added.
Prefer the browser's own control where it already does the job; add a scripted one only for behaviour the native control cannot provide.
UI tests assert roles, accessible names and behaviour rather than class names or markup shape. A surface anchored in a portal — a dialog, a menu, a toast — is opened in a real document and read back, never asserted against static markup.
Keep one package and ordinary files until a concrete need requires more structure.
Keep object bytes behind the small S3 storage interface and photo metadata in Neo4j.
Keep administrative settings limited to photo-on-report policy, display timezone, built-in instance theme, and the API token lifetime ceiling; store timestamps as absolute instants.
System administration must not grant Asset access.
Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for application changes.
Do not commit or push without explicit authorization.

Private working context — conversations, research notes, and the examples used in them — is not automatically publishable.
Before creating or editing a public Issue or Issue comment, remove incidental personal and private detail, and prefer fictional or anonymized examples wherever a real identity is not technically necessary.
Keep concrete empirical evidence whose specificity the engineering or research record genuinely depends on, and minimize unrelated personal information around it rather than weakening the evidence.
When it is unclear whether a private detail needs to be published, ask instead of publishing it.

## Browser and GUI verification

Unless explicitly requested, do not launch or attach to a browser, desktop application, or other GUI for manual interaction testing.

Prefer automated unit, integration, API, typecheck, and build validation. The user performs routine manual UI/UX acceptance separately.

Browser or GUI interaction may still be requested explicitly when it is necessary to investigate a browser-specific problem or reproduce an issue that cannot reasonably be validated otherwise.

Do not treat the absence of agent-driven browser testing as incomplete validation when the relevant automated checks pass. Report what was validated automatically and leave manual UI acceptance to the user.
