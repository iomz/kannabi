# Project rules

Preserve the README naming story at the bottom of README.

- Use `Kannabi` for the product/brand and user-facing name.
- Use lowercase `kannabi` for technical identifiers such as repository, package/binary, and filesystem names.
- Use uppercase `KANNABI_*` for environment variables.
- Reporting requires an explicit Group context; that Group receives collaboration access.
- A sole Group may be selected automatically in the UI, but remains explicit in the API/domain.
- `reportedBy` is immutable provenance, never an authorization grant.
- Every canonical Asset change records, in the same statement as the change, who asserted it and whose authority accepted it. The asserter stays distinguishable from the acceptor even when they are the same person, the accepting authority comes from the authenticated actor and never from caller input, and appearing in provenance grants nothing.
- Change provenance is bounded current-state provenance describing the latest change only. It never becomes a history log, and it never replaces `reportedBy`.
- Do not introduce direct User-to-Asset ACLs.
- A public Asset's full representation is readable without authentication through its public URI; public visibility never grants edit access.
- Do not introduce per-field public/private filtering.
- Every Asset has an immutable application-owned `Asset.id`, assigned at reporting time and never changed; startup verifies this and fails closed on data that violates it.
- `Asset.id` is a canonical lowercase UUIDv7 and is the only Kannabi Asset identity; it addresses the Asset everywhere, including the canonical public Asset URI.
- Migration assigns a native identity only where one is missing, under a lock that makes concurrent startup safe; an unrecognized identity is never repaired or replaced.
- The UUIDv7 timestamp has no domain meaning; Asset chronology uses explicit fields such as `reportedAt`.
- Internal database keys, including Neo4j node identity, remain implementation details.
- A Kannabi Asset exists independently of GS1. Registering and managing one must never require GS1 knowledge or a GS1 identifier.
- External identifiers are optional and multiple: zero is a normal Asset state, and identifiers are attached and detached after creation without touching `Asset.id`.
- External identifiers are external identities, never Kannabi's native Asset identity, and never a basis for authorization; Asset access stays Group-derived.
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
- GS1 Digital Link, resolver semantics, and identifier allocation remain deferred.
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

Use Hono for server behavior, React Router v7 Framework Mode for UI, and Neo4j for master data.
Keep one package and ordinary files until a concrete need requires more structure.
Keep object bytes behind the small S3 storage interface and photo metadata in Neo4j.
Keep administrative settings limited to photo-on-report policy, display timezone, and built-in instance theme; store timestamps as absolute instants.
System administration must not grant Asset access.
Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for application changes.
Do not commit or push without explicit authorization.

## Browser and GUI verification

Unless explicitly requested, do not launch or attach to a browser, desktop application, or other GUI for manual interaction testing.

Prefer automated unit, integration, API, typecheck, and build validation. The user performs routine manual UI/UX acceptance separately.

Browser or GUI interaction may still be requested explicitly when it is necessary to investigate a browser-specific problem or reproduce an issue that cannot reasonably be validated otherwise.

Do not treat the absence of agent-driven browser testing as incomplete validation when the relevant automated checks pass. Report what was validated automatically and leave manual UI acceptance to the user.
