# Project rules

Preserve the README naming story at the bottom of README.

- Use `Kannabi` for the product/brand and user-facing name.
- Use lowercase `kannabi` for technical identifiers such as repository, package/binary, and filesystem names.
- Use uppercase `KANNABI_*` for environment variables.
- Reporting requires an explicit Group context; that Group receives collaboration access.
- A sole Group may be selected automatically in the UI, but remains explicit in the API/domain.
- `reportedBy` is immutable provenance, never an authorization grant.
- Do not introduce direct User-to-Asset ACLs.
- A public Asset's full representation is readable without authentication through its public URI; public visibility never grants edit access.
- Do not introduce per-field public/private filtering.
- Every Asset has an immutable application-owned `Asset.id`, assigned at reporting time and never changed; startup verifies this and fails closed on data that violates it.
- `Asset.id` is a canonical lowercase UUIDv7 and is the only Kannabi Asset identity; it addresses the Asset everywhere, including the canonical public Asset URI.
- Migration assigns a native identity only where one is missing, under a lock that makes concurrent startup safe; an unrecognized identity is never repaired or replaced.
- The UUIDv7 timestamp has no domain meaning; Asset chronology uses explicit fields such as `reportedAt`.
- SGTIN and GRAI are external domain identifiers, not Kannabi's native Asset identity; standards define external contracts, never the internal identity model.
- Internal database keys, including Neo4j node identity, remain implementation details.
- GS1 Digital Link, resolver semantics, and identifier issuance remain deferred.
- Account deletion removes the active personal account but preserves immutable Asset provenance by default.
- Deleted reporters become non-active tombstones that retain only the deletion-time display name required for human-readable provenance; they must not behave as discoverable Users.
- Tombstones do not retain email, credentials, sessions, preferences, administrator roles, or Group memberships.
- Deleting a Group's final member does not delete the Group; empty Groups are valid.

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
